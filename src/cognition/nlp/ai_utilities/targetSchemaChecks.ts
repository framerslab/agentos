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
 * `parseJsonSafe()` gives (`checkValue`). A schema may be built anew for every call, under the same `$id` too:
 * Ajv keeps no schema it compiled.
 */
export const targetSchemaChecks = new SchemaChecks({ allErrors: true, coerceTypes: true, strict: false });
