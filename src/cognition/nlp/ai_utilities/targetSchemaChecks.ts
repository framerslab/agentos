/**
 * @fileoverview The checks `parseJsonSafe()` makes against a `targetSchema`, one set for StatisticalUtilityAI and
 * LLMUtilityAI, so the two classes read a schema alike.
 */
import { SchemaChecks } from '../../../core/utils/schemaChecks';

/**
 * The compiled `targetSchema` checks of both utility classes.
 *
 * Ajv reads a schema as JSON Schema draft-07 and reports every error of a value. It checks the standard formats
 * (`date-time`, `email`, `uri` and the others of `ajv-formats`), passes over a keyword it does not know, as JSON
 * Schema says to, and a format it does not know (strict mode is off), and coerces a value to the type its schema
 * names where it can (`"5"` to 5): inside an object or a list in place, and the value itself in the answer
 * `parseJsonSafe()` gives (`checkValue`). A schema may be built anew for every call, under the same `$id` too, or
 * under an `$id` an earlier schema used inside it: each compile lets go of the `$id`s it registered, and an Ajv
 * instance compiles at most `SCHEMAS_PER_INSTANCE` schemas. A schema under the draft-07 meta-schema's `$id`, or
 * marked `$async`, is refused as a schema that does not compile.
 */
export const targetSchemaChecks = new SchemaChecks({ allErrors: true, coerceTypes: true, strict: false });
