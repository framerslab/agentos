/**
 * @fileoverview JSON Schema checks compiled with Ajv that leave Ajv holding no schema.
 *
 * Ajv keeps every schema object it compiles for the life of its instance, and refuses a second schema under an
 * `$id` it already holds. A caller that writes its schema anew for each check, such as a schema read from each
 * request, would grow the instance by one schema a check, and its second check under an `$id` would throw.
 * {@link SchemaChecks} keeps each compiled check beside its schema object instead, for as long as that object
 * lives, and has Ajv let go of the schema once it is compiled. A compiled check holds its own references to the
 * schemas it refers to, so it keeps working.
 *
 * @module agentos/core/utils/schemaChecks
 */
import Ajv from 'ajv';
import type { Options } from 'ajv';
import addFormats from 'ajv-formats';

/** One reason a value failed a schema, as Ajv reports it. */
export interface SchemaCheckError {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** A compiled schema: whether a value passes, and the errors of the last value that did not. */
export type SchemaCheck = ((data: unknown) => boolean) & { errors?: SchemaCheckError[] | null };

/** Compiles JSON Schemas with one Ajv instance of the options given, plus the standard formats of `ajv-formats`. */
export class SchemaChecks {
  private ajv: InstanceType<typeof Ajv> | undefined;
  private readonly compiled = new WeakMap<Record<string, any>, SchemaCheck>();

  /** @param options - Ajv's options. The instance is made on the first check. */
  constructor(private readonly options: Options) {}

  /**
   * The check for a schema: compiled on the schema object's first check, then the same check while that object
   * lives. A change made to the object after its first check is not read.
   *
   * @throws The error Ajv throws for a schema it cannot compile, such as one whose `type` is no JSON Schema type.
   */
  check(schema: Record<string, any>): SchemaCheck {
    // A boolean schema (`true` passes every value) is no object to keep a check beside; Ajv holds the two it can be.
    const isObject = typeof schema === 'object' && schema !== null;
    const known = isObject ? this.compiled.get(schema) : undefined;
    if (known) return known;
    if (!this.ajv) {
      this.ajv = new Ajv(this.options);
      addFormats(this.ajv);
    }
    const ajv = this.ajv;
    try {
      const compiledCheck = ajv.compile(schema) as SchemaCheck;
      if (isObject) this.compiled.set(schema, compiledCheck);
      return compiledCheck;
    } finally {
      // Ajv kept the schema, and its `$id` when it has one, even when the compile threw.
      if (isObject) ajv.removeSchema(schema);
    }
  }
}
