/**
 * @fileoverview The checks `parseJsonSafe()` makes against a `targetSchema`, one set for StatisticalUtilityAI and
 * LLMUtilityAI, so the two classes read a schema alike.
 *
 * Ajv reads the schema as JSON Schema draft-07 and reports every error of a value. It knows the standard formats
 * (`date-time`, `email`, `uri` and the others of `ajv-formats`), passes over a keyword or a format it does not know,
 * as JSON Schema says to, and coerces a value to the type its schema names where it can (`"5"` to 5), in the value
 * itself. A schema may be built anew for every call, under the same `$id` too.
 */
import { SchemaChecks } from '../../../core/utils/schemaChecks';

export const targetSchemaChecks = new SchemaChecks({ allErrors: true, coerceTypes: true, strict: false });
