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

/** Where a checked value is held: Ajv writes a coercion of the value itself there. */
export interface SchemaCheckContext {
  parentData?: Record<string | number, unknown>;
  parentDataProperty?: string | number;
}

/** A compiled schema: whether a value passes, and the errors of the last value that did not. */
export type SchemaCheck = ((data: unknown, context?: SchemaCheckContext) => boolean) & { errors?: SchemaCheckError[] | null };

/**
 * Runs a check and answers whether the value passed, with the value as the check left it. Ajv changes a value inside
 * an object or a list in place, coercing it or filling in a default; a coercion of the value itself, such as `"5"`
 * read as 5 under `{ type: 'number' }`, it can only write into a holder, since a caller's own variable is out of its
 * reach, so the value comes back from that holder.
 */
export function checkValue(check: SchemaCheck, value: unknown): { valid: boolean; value: unknown } {
  const holder: Record<string, unknown> = { value };
  const valid = check(value, { parentData: holder, parentDataProperty: 'value' });
  return { valid, value: holder.value };
}

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
    if (isObject && SchemaChecks.holdsId(ajv, schema.$id)) {
      // Ajv refuses a second schema under an `$id` it holds, its meta-schema's for one, and letting go of that schema
      // by its `$id` would remove what Ajv holds: it is refused here, before Ajv keeps any of it.
      throw new Error(`schema with key or id "${schema.$id}" already exists`);
    }
    try {
      const compiledCheck = ajv.compile(schema) as unknown as SchemaCheck;
      if (isObject) this.compiled.set(schema, compiledCheck);
      return compiledCheck;
    } finally {
      // Ajv kept the schema, and its `$id` when it has one, even when the compile threw.
      if (isObject) ajv.removeSchema(schema);
    }
  }

  /** Whether Ajv holds a schema under an `$id`. A check compiles and lets go of its own, so these are Ajv's own. */
  private static holdsId(ajv: InstanceType<typeof Ajv>, id: unknown): boolean {
    // An `$id` that is a fragment (`#name`) names a place in its schema, never a schema Ajv holds.
    if (typeof id !== 'string' || id === '' || id.startsWith('#')) return false;
    try {
      return ajv.getSchema(id) !== undefined;
    } catch {
      return true;
    }
  }
}
