/**
 * @fileoverview JSON Schema checks compiled with Ajv on instances that stay bounded.
 *
 * An Ajv instance is a registry. It keeps every schema it compiles under that schema's `$id` and the `$id`s inside
 * it, refuses a second schema under an `$id` it holds, and keeps each schema and compiled check in the code its
 * checks share for as long as the instance lives. A caller that writes its schema anew for each check, such as a
 * schema read from each request, would grow one instance by a schema a check, and its second check under an `$id`
 * would throw. {@link SchemaChecks} keeps each compiled check beside its schema object instead, for as long as that
 * object lives, has Ajv let go of every `$id` a compile registered, and makes a new instance after
 * {@link SCHEMAS_PER_INSTANCE} compiles. A compiled check holds its own references to the schemas it refers to and
 * to the instance that compiled it, so it keeps working after its instance is replaced.
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
 * How many schemas {@link SchemaChecks} compiles on one Ajv instance before it makes a new one. An instance it has
 * replaced lives on only while a check it compiled does.
 */
export const SCHEMAS_PER_INSTANCE = 100;

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

/** Compiles JSON Schemas with Ajv instances of the options given, plus the standard formats of `ajv-formats`. */
export class SchemaChecks {
  private ajv: InstanceType<typeof Ajv> | undefined;
  /** The schemas compiled on the current instance. */
  private compiles = 0;
  private readonly compiled = new WeakMap<Record<string, any>, SchemaCheck>();

  /** @param options - Ajv's options. An instance is made on the first check, and again after every {@link SCHEMAS_PER_INSTANCE} compiles. */
  constructor(private readonly options: Options) {}

  /**
   * The check for a schema: compiled on the schema object's first check, then the same check while that object
   * lives. A change made to the object after its first check is not read.
   *
   * @throws The error Ajv throws for a schema it cannot compile, such as one whose `type` is no JSON Schema type; an
   * error for a schema under an `$id` Ajv holds itself, the draft-07 meta-schema's for one; and an error for a schema
   * marked `$async`, whose check answers a promise where a check answers at once.
   */
  check(schema: Record<string, any>): SchemaCheck {
    // A boolean schema (`true` passes every value) is no object to keep a check beside; Ajv holds the two it can be.
    const isObject = typeof schema === 'object' && schema !== null;
    const known = isObject ? this.compiled.get(schema) : undefined;
    if (known) return known;
    if (!this.ajv || this.compiles >= SCHEMAS_PER_INSTANCE) {
      this.ajv = new Ajv(this.options);
      addFormats(this.ajv);
      this.compiles = 0;
    }
    const ajv = this.ajv;
    if (isObject && SchemaChecks.holdsId(ajv, schema.$id)) {
      // Ajv refuses a second schema under an `$id` it holds, its meta-schema's for one, and letting go of that schema
      // by its `$id` would remove what Ajv holds: it is refused here, before Ajv keeps any of it.
      throw new Error(`schema with key or id "${schema.$id}" already exists`);
    }
    // What Ajv holds before the compile is its own; whatever the compile registers is let go of after it.
    const heldBefore = new Set(Object.keys(ajv.refs));
    this.compiles += 1;
    try {
      const compiledCheck = ajv.compile(schema) as unknown as SchemaCheck & { $async?: unknown };
      if (compiledCheck.$async === true) {
        throw new Error('schema is marked $async: its check answers a promise, and these checks answer at once');
      }
      if (isObject) this.compiled.set(schema, compiledCheck);
      return compiledCheck;
    } finally {
      // Ajv kept the schema, under its `$id` when it has one and under each `$id` inside it, even when the compile
      // threw.
      if (isObject) ajv.removeSchema(schema);
      for (const id of Object.keys(ajv.refs)) {
        if (!heldBefore.has(id)) ajv.removeSchema(id);
      }
    }
  }

  /** Whether Ajv holds a schema under an `$id`. A check lets go of every `$id` its compile registered, so these are Ajv's own. */
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
