/**
 * @module api/runtime/structuredReply
 *
 * A reply that must match a schema, on the full runtime: the spec a request carries, the text parsed and checked
 * against a Zod or a JSON schema, the repair message a failed attempt is answered with, and the check again after
 * the output guardrails. `generateObject` shares the parsers here.
 */
import type { ZodError, ZodType } from 'zod';
import { SchemaChecks, type SchemaCheck } from '../../core/utils/schemaChecks.js';
import { findDuplicateJsonKey } from '../../core/utils/jsonDuplicateKeys.js';
import { lowerZodToJsonSchema } from '../../orchestration/compiler/SchemaLowering.js';

// ---------------------------------------------------------------------------
// The spec a request carries and the output a reply returns
// ---------------------------------------------------------------------------

export type JsonSchemaObject = Record<string, unknown>;

export interface StructuredReplySpec {
  /** A Zod schema, or a JSON Schema object. One of `schema` and `schemaRef` is required. */
  schema?: ZodType | JsonSchemaObject;
  /** The key of a schema in `AgentOSConfig.structuredSchemas`, resolved before the turn. */
  schemaRef?: string;
  /** Named in the instruction and in the output's meta. Default "reply". */
  name?: string;
  description?: string;
  /** Repair rounds after a reply that does not match. Default 2, clamped to 0..5. */
  maxRetries?: number;
  /** When every attempt failed: end the turn with `GMI_STRUCTURED_OUTPUT_INVALID`, or return the last reply with `meta.valid: false`. Default `error`. */
  onExhausted?: 'error' | 'return_invalid';
  /** Stream the model's text deltas on a structured turn. Default false: the caller sees nothing before the check. */
  streamDeltas?: boolean;
}

export interface StructuredOutputMeta {
  schemaName: string;
  valid: boolean;
  /** Model calls the turn made for the structured reply. */
  attempts: number;
  /**
   * How the schema reached the model: `forced_tool`, a forced schema tool call the gateway lifted; `provider_schema`, a
   * hop whose payload carried the schema (OpenAI's strict json_schema, Gemini's responseSchema, Anthropic's JSON output
   * format, whose text answer the gateway lifts, and a forced tool call that did not parse or that the output limit
   * stopped); `prompt_only`, the schema reached the model in the prompt alone (a record schema on a Claude model that
   * refuses a forced choice, say).
   */
  enforcement: 'forced_tool' | 'provider_schema' | 'prompt_only';
  /** Where the last check ran: on the model's reply, or on the text an output guardrail rewrote. */
  stage: 'model' | 'post_guardrail';
  issues?: string[];
}

export interface StructuredReplyOutput {
  value: unknown;
  meta: StructuredOutputMeta;
}

/** Whether the output carries the runtime's refusal result rather than a schema validation failure. */
export function isRefusedStructuredReply(output: StructuredReplyOutput): boolean {
  return output.value === null && !output.meta.valid
    && output.meta.issues?.includes('The model refused the request instead of writing the reply.') === true;
}

/** Where a `schemaRef` is looked up. A `Map<string, ZodType | JsonSchemaObject>` is one. */
export interface IStructuredSchemaRegistry {
  get(ref: string): ZodType | JsonSchemaObject | undefined;
}

export class StructuredReplyConfigError extends Error {
  readonly code = 'STRUCTURED_REPLY_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'StructuredReplyConfigError';
  }
}

export const STRUCTURED_REPLY_DEFAULTS = { name: 'reply', maxRetries: 2, maxRetriesCeiling: 5, onExhausted: 'error' as const, streamDeltas: false };

export function isZodSchema(schema: unknown): schema is ZodType {
  return typeof schema === 'object' && schema !== null && typeof (schema as { safeParse?: unknown }).safeParse === 'function';
}

/** Resolves a `schemaRef` through the registry; a spec that names no schema the runtime can reach is refused here, before any turn. */
export function resolveStructuredReplySpec(spec: StructuredReplySpec, registry?: IStructuredSchemaRegistry): StructuredReplySpec & { schema: ZodType | JsonSchemaObject } {
  if (spec.schema !== undefined) {
    if (!isZodSchema(spec.schema) && (typeof spec.schema !== 'object' || spec.schema === null || Array.isArray(spec.schema))) {
      throw new StructuredReplyConfigError('structuredReply.schema must be a Zod schema or a JSON Schema object.');
    }
    return { ...spec, schema: spec.schema };
  }
  if (spec.schemaRef) {
    const found = registry?.get(spec.schemaRef);
    if (found) return { ...spec, schema: found };
    throw new StructuredReplyConfigError(`structuredReply.schemaRef "${spec.schemaRef}" is not in AgentOSConfig.structuredSchemas.`);
  }
  throw new StructuredReplyConfigError('structuredReply needs a schema or a schemaRef.');
}

// ---------------------------------------------------------------------------
// The resolved spec the GMI runs a turn with
// ---------------------------------------------------------------------------

export type StructuredCheck = { ok: true; value: unknown } | { ok: false; issues: string[]; value?: unknown };

export interface ResolvedStructuredReply {
  name: string;
  description?: string;
  /** The Zod schema when the spec gave one: the gateway lowers it per provider. */
  zod?: ZodType;
  jsonSchema: JsonSchemaObject;
  maxRetries: number;
  onExhausted: 'error' | 'return_invalid';
  streamDeltas: boolean;
  /** The instruction the system prompt carries: the schema in words the model follows. */
  instruction: string;
  /** Checks a parsed value. */
  checkValue(value: unknown): StructuredCheck;
}

/**
 * The checks of the JSON Schemas requests name. Ajv reads a schema as JSON Schema draft-07, reports every error of a
 * value, checks the standard formats (`date-time`, `email`, `uri` and the others of `ajv-formats`), and passes over a
 * keyword it does not know, as JSON Schema says to, and a format it does not know (strict mode is off). A host may
 * send its schema anew with each request, under one `$id` too: each compile lets go of the `$id`s it registered, and
 * an Ajv instance compiles at most `SCHEMAS_PER_INSTANCE` schemas.
 */
const structuredSchemaChecks = new SchemaChecks({ allErrors: true, strict: false });

/** Builds what a structured turn needs from the spec, or null when the request carries none. Throws on a spec without a usable schema. */
export function resolveStructuredReply(spec: StructuredReplySpec | undefined | null): ResolvedStructuredReply | null {
  if (!spec) return null;
  const { schema } = resolveStructuredReplySpec(spec);
  const name = (spec.name ?? '').trim() || STRUCTURED_REPLY_DEFAULTS.name;
  const maxRetries = Math.max(0, Math.min(STRUCTURED_REPLY_DEFAULTS.maxRetriesCeiling, Math.trunc(spec.maxRetries ?? STRUCTURED_REPLY_DEFAULTS.maxRetries)));
  const onExhausted = spec.onExhausted === 'return_invalid' ? 'return_invalid' : 'error';
  const streamDeltas = spec.streamDeltas === true;
  if (isZodSchema(schema)) {
    const jsonSchema = lowerZodToJsonSchema(schema);
    return {
      name,
      description: spec.description,
      zod: schema,
      jsonSchema,
      maxRetries,
      onExhausted,
      streamDeltas,
      instruction: buildSchemaInstructionText(jsonSchema, name, spec.description),
      checkValue: (value) => checkWithZod(value, schema),
    };
  }
  let validate: SchemaCheck;
  try {
    validate = structuredSchemaChecks.check(schema);
  } catch (e) {
    throw new StructuredReplyConfigError(`structuredReply.schema is not a valid JSON Schema: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    name,
    description: spec.description,
    jsonSchema: schema,
    maxRetries,
    onExhausted,
    streamDeltas,
    instruction: buildSchemaInstructionText(schema, name, spec.description),
    checkValue: (value) => {
      if (validate(value)) return { ok: true, value };
      const issues = (validate.errors ?? []).slice(0, MAX_FEEDBACK_VALIDATION_ISSUES).map((e) => `- ${e.instancePath || '<root>'}: ${e.message ?? 'does not match the schema'}`);
      return { ok: false, issues: issues.length ? issues : ['- <root>: does not match the schema'], value };
    },
  };
}

function checkWithZod(value: unknown, schema: ZodType): StructuredCheck {
  // A strict json_schema hop makes every optional property nullable, so the model writes `null` for one it leaves out.
  const candidate = dropNullsForOptionalFields(value, schema);
  let parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const repaired = repairStringEncodedContainers(candidate, parsed.error);
    if (repaired.repaired) parsed = schema.safeParse(dropNullsForOptionalFields(repaired.value, schema));
  }
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: summarizeZodErrors(parsed.error).split('\n'), value };
}

/** Parses the model's text and checks it: the JSON is found in plain text, in a code fence, or between the first and last brace. */
export function checkStructuredReply(text: string, resolved: ResolvedStructuredReply): StructuredCheck {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, issues: [`- <root>: the reply is not JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  return resolved.checkValue(raw);
}

/** The message a failed attempt is answered with, inside the same turn. The schema itself stands in the system prompt. */
export function structuredRepairMessage(issues: readonly string[], resolved: ResolvedStructuredReply, badText: string): string {
  return [
    `Your reply did not match the required JSON schema for "${resolved.name}".`,
    'Problems:',
    ...issues,
    '',
    `Your reply was: ${summarizeBadResponse(badText)}`,
    '',
    'Reply again with ONLY the corrected JSON object: no markdown, no code fences, no explanation.',
  ].join('\n');
}

/**
 * The check after the output guardrails: a sanitizer that rewrote the final text may have broken the shape the model
 * matched. Returns the output as it stands after the rewrite, with `stage: 'post_guardrail'`.
 */
export function recheckStructuredReply(finalText: string | null, previous: StructuredReplyOutput, resolved: ResolvedStructuredReply): StructuredReplyOutput {
  const check = checkStructuredReply(finalText ?? '', resolved);
  if (check.ok) return { value: check.value, meta: { ...previous.meta, valid: true, stage: 'post_guardrail', issues: undefined } };
  return { value: check.value ?? null, meta: { ...previous.meta, valid: false, stage: 'post_guardrail', issues: check.issues } };
}

// ---------------------------------------------------------------------------
// The parsers generateObject and the structured turn share
// ---------------------------------------------------------------------------

/**
 * The line of every schema instruction ({@link buildSchemaInstructionText})
 * before the JSON Schema itself: a prompt that holds it states a schema.
 */
export const SCHEMA_INSTRUCTION_LEAD = 'The JSON MUST conform to this JSON Schema:';

export function buildSchemaInstructionText(
  jsonSchema: Record<string, unknown>,
  schemaName?: string,
  schemaDescription?: string,
): string {
  const parts: string[] = [];
  parts.push('You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no explanation.');
  if (schemaName) parts.push(`The JSON object should be a "${schemaName}".`);
  if (schemaDescription) parts.push(schemaDescription);
  parts.push('');
  parts.push(SCHEMA_INSTRUCTION_LEAD);
  parts.push(JSON.stringify(jsonSchema, null, 2));
  return parts.join('\n');
}

/**
 * Attempts to extract a JSON object from raw LLM text.
 *
 * First tries a direct `JSON.parse`. If that fails, looks for JSON inside
 * common markdown code fences (` ```json ... ``` ` or ` ``` ... ``` `).
 * This handles the common case where models wrap JSON in code blocks
 * despite being told not to.
 *
 * An object that repeats a key is refused: `JSON.parse` would keep only the
 * key's last value, and the reply would lose the others without a sign.
 *
 * @param text - The raw text to parse.
 * @returns The parsed value.
 * @throws {SyntaxError} When no valid JSON can be extracted, or when the JSON
 *   found holds an object that repeats a key.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: direct JSON parse
  let direct: { value: unknown } | undefined;
  try {
    direct = { value: JSON.parse(trimmed) };
  } catch {
    // Fall through to code fence extraction
  }
  if (direct) return withDistinctKeys(trimmed, direct.value);

  // Try extracting from markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    return withDistinctKeys(fenced, JSON.parse(fenced));
  }

  // Last resort: find the first { and last } to extract a JSON object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const braced = trimmed.slice(firstBrace, lastBrace + 1);
    return withDistinctKeys(braced, JSON.parse(braced));
  }

  throw new SyntaxError(`No valid JSON found in LLM response: ${trimmed.slice(0, 200)}`);
}

/**
 * Parses JSON text as {@link extractJson} does, refusing an object that
 * repeats a key. For a reply whose text is the JSON itself (a forced schema
 * tool's input, the JSON output format's answer).
 *
 * @throws {SyntaxError} When the text is not JSON, or holds an object that repeats a key.
 */
export function parseJsonWithDistinctKeys(text: string): unknown {
  return withDistinctKeys(text, JSON.parse(text));
}

/**
 * Returns `value`, the parse of `json`, unless an object of `json` repeats a key.
 *
 * @throws {SyntaxError} Naming the repeated key and the object that holds it.
 */
export function withDistinctKeys(json: string, value: unknown): unknown {
  const duplicate = findDuplicateJsonKey(json);
  if (duplicate) {
    throw new SyntaxError(
      `Duplicate key "${duplicate.key}" in the object at ${duplicate.path}: each key may appear once in an object, and JSON keeps only its last value.`,
    );
  }
  return value;
}

/**
 * Re-parses string-encoded containers where the schema expects an array or
 * object but the model produced a JSON STRING containing one.
 *
 * Models on the tool-use / structured-output path intermittently
 * double-encode a nested container — `{"verdicts": "[{...}]"}` instead of
 * `{"verdicts": [{...}]}` — most often on long, deeply nested payloads. The
 * raw text extracts as valid JSON, so only Zod sees the defect
 * (`invalid_type: expected array, received string`), and a retry re-rolls
 * the same dice with the same prompt.
 *
 * Driven strictly by the validation issues: for each `invalid_type` issue
 * expecting a container whose actual value is a string that syntactically
 * starts like that container, `JSON.parse` the string in place on a clone.
 * One pass, no recursion; anything that does not parse, or that holds an
 * object repeating a key, is left untouched so the caller's normal
 * retry/feedback path still applies.
 *
 * @param value - The extracted-but-invalid candidate value.
 * @param error - The Zod error from the failed validation.
 * @returns The (possibly repaired) value and whether any repair applied.
 * @internal
 */
export function repairStringEncodedContainers(
  value: unknown,
  error: ZodError,
): { value: unknown; repaired: boolean } {
  type ContainerIssue = { code?: string; expected?: string; path?: PropertyKey[] };
  const targets = (error.issues as unknown as ContainerIssue[]).filter(
    issue =>
      issue.code === 'invalid_type' &&
      (issue.expected === 'array' || issue.expected === 'object'),
  );
  if (targets.length === 0) return { value, repaired: false };

  let root: unknown;
  try {
    root = structuredClone(value);
  } catch {
    // Non-cloneable input (should never happen for JSON-derived data) —
    // repair is best-effort, never a new failure mode.
    return { value, repaired: false };
  }

  let repaired = false;
  for (const issue of targets) {
    const path = issue.path ?? [];
    // Resolve the offending node and its parent inside the clone.
    let parent: Record<PropertyKey, unknown> | null = null;
    let node: unknown = root;
    for (const key of path) {
      if (node === null || typeof node !== 'object') {
        node = undefined;
        break;
      }
      parent = node as Record<PropertyKey, unknown>;
      node = parent[key];
    }
    if (typeof node !== 'string') continue;
    const trimmed = node.trim();
    const expectsArray = issue.expected === 'array';
    if (expectsArray ? !trimmed.startsWith('[') : !trimmed.startsWith('{')) continue;
    let inner: unknown;
    try {
      inner = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // An encoded container that repeats a key would keep only the key's last
    // value: it stays a string, and the reply fails validation as it stands.
    if (findDuplicateJsonKey(trimmed)) continue;
    if (path.length === 0) {
      // The root itself was string-encoded.
      root = inner;
      repaired = true;
      continue;
    }
    if (parent) {
      parent[path[path.length - 1] as PropertyKey] = inner;
      repaired = true;
    }
  }
  return { value: root, repaired };
}

/**
 * Repairs enum and literal values that differ from the schema's only by case.
 *
 * Anthropic's JSON output format does not guarantee the capitalization of
 * `enum` and `const` values (the structured outputs page, read 2026-10-18), so
 * a `"Yes"` can come back for a schema that says `'yes'`. Driven strictly by
 * the validation issues: when EVERY issue is an `invalid_value` whose actual
 * value is a string matching exactly one of the issue's allowed values
 * case-insensitively, each such value is replaced by the schema's spelling on
 * a clone. Any other issue (a missing field, a wrong type, a value that
 * matches none or two of the options) leaves the candidate untouched, so the
 * caller's normal retry/feedback path still applies.
 *
 * @param value - The extracted-but-invalid candidate value.
 * @param error - The Zod error from the failed validation.
 * @returns The (possibly repaired) value and whether any repair applied.
 * @internal
 */
export function repairEnumCasing(
  value: unknown,
  error: ZodError,
): { value: unknown; repaired: boolean } {
  type ValueIssue = { code?: string; values?: unknown[]; options?: unknown[]; expected?: unknown; path?: PropertyKey[] };
  /**
   * The values an enum or literal issue allows: Zod 4's `invalid_value.values`,
   * Zod 3's `invalid_enum_value.options` and `invalid_literal.expected`. Any
   * other issue is not a casing difference.
   */
  const allowedValues = (issue: ValueIssue): unknown[] | undefined => {
    if (issue.code === 'invalid_value' && Array.isArray(issue.values)) return issue.values;
    if (issue.code === 'invalid_enum_value' && Array.isArray(issue.options)) return issue.options;
    if (issue.code === 'invalid_literal' && issue.expected !== undefined) return [issue.expected];
    return undefined;
  };
  const issues = error.issues as unknown as ValueIssue[];
  if (issues.length === 0) return { value, repaired: false };
  const fixes: Array<{ path: PropertyKey[]; to: string }> = [];
  for (const issue of issues) {
    const allowed = allowedValues(issue);
    if (!allowed) return { value, repaired: false };
    const path = issue.path ?? [];
    let node: unknown = value;
    for (const key of path) {
      if (node === null || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = (node as Record<PropertyKey, unknown>)[key];
    }
    if (typeof node !== 'string') return { value, repaired: false };
    const lowered = node.toLowerCase();
    const matches = allowed.filter(
      (option): option is string => typeof option === 'string' && option !== node && option.toLowerCase() === lowered,
    );
    if (matches.length !== 1) return { value, repaired: false };
    fixes.push({ path, to: matches[0] });
  }
  let root: unknown;
  try {
    root = structuredClone(value);
  } catch {
    return { value, repaired: false };
  }
  for (const fix of fixes) {
    if (fix.path.length === 0) {
      root = fix.to;
      continue;
    }
    let parent: unknown = root;
    for (const key of fix.path.slice(0, -1)) {
      parent = parent === null || typeof parent !== 'object' ? undefined : (parent as Record<PropertyKey, unknown>)[key];
    }
    if (parent && typeof parent === 'object') {
      (parent as Record<PropertyKey, unknown>)[fix.path[fix.path.length - 1]] = fix.to;
    }
  }
  return { value: root, repaired: true };
}

/** Deepest schema nesting {@link dropNullsForOptionalFields} walks; a deeper value is left as it is. */
const MAX_NULL_DROP_DEPTH = 64;

/** A Zod schema's definition: `_zod.def` in Zod 4, `_def` otherwise. */
function zodDefinition(schema: unknown): Record<string, unknown> | undefined {
  const node = schema as { _zod?: { def?: Record<string, unknown> }; _def?: Record<string, unknown> } | null | undefined;
  return node?._zod?.def ?? node?._def;
}

/** `schema.safeParse(value).success`, false when the parse throws (an async refinement, say). */
function parsesAs(schema: ZodType, value: unknown): boolean {
  try {
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

/**
 * Removes every `null` the schema would refuse where it takes the property's absence: a property whose schema is
 * optional (`.optional()`, `.default()`, `.prefault()`) and does not accept `null`. Returns the value itself when
 * nothing is removed, else a copy with the removals; the input is never changed.
 *
 * OpenAI's strict structured outputs (and OpenRouter's, which forwards them) take no optional property: every property
 * of every object must be required. `makeStrictJsonSchema` makes each optional property nullable to fit, so a model
 * writes `null` for a property the caller's schema leaves out, and the caller's schema refuses that `null`
 * (`expected string, received null`). Read before the schema checks a reply, on every path whose payload the strict
 * builder can make: generateObject (its primary and each fallback leg), `session.send` on both runtimes and the GMI's
 * structured turn over the completion gateway. A `null` the schema accepts (a `.nullable()` property, optional or not)
 * stays, as does every key the schema does not name.
 *
 * Walks objects, arrays, tuples, records, intersections and the wrappers that read the same JSON value as their inner
 * schema. For a union, a value one member takes as it stands is left alone; otherwise the first member that takes the
 * value with its nulls removed decides.
 *
 * @param value - The parsed reply.
 * @param schema - The caller's Zod schema.
 * @returns The reply with those nulls removed.
 */
export function dropNullsForOptionalFields(value: unknown, schema: ZodType): unknown {
  return dropNullsAt(value, schema, 0);
}

function dropNullsAt(value: unknown, schema: ZodType, depth: number): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_NULL_DROP_DEPTH) return value;
  const def = zodDefinition(schema);
  if (!def) return value;
  const next = depth + 1;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return dropNullsAt(value, def.innerType as ZodType, next);
    case 'pipe':
      // The reply is checked against the pipe's input schema first.
      return dropNullsAt(value, def.in as ZodType, next);
    case 'lazy':
      return typeof def.getter === 'function' ? dropNullsAt(value, (def.getter as () => ZodType)(), next) : value;
    case 'object': {
      const shape = def.shape as Record<string, ZodType> | undefined;
      if (Array.isArray(value) || !shape || typeof shape !== 'object') return value;
      const source = value as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(shape, key)) continue;
        const field = shape[key];
        const current = source[key];
        if (current === null) {
          if (parsesAs(field, undefined) && !parsesAs(field, null)) {
            out ??= { ...source };
            delete out[key];
          }
          continue;
        }
        const cleaned = dropNullsAt(current, field, next);
        if (cleaned !== current) {
          out ??= { ...source };
          setOwn(out, key, cleaned);
        }
      }
      return out ?? value;
    }
    case 'array': {
      if (!Array.isArray(value)) return value;
      return mapChanged(value, (item) => dropNullsAt(item, def.element as ZodType, next));
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value;
      const items = (def.items as ZodType[] | undefined) ?? [];
      const rest = def.rest as ZodType | undefined;
      return mapChanged(value, (item, i) => {
        const member = i < items.length ? items[i] : rest;
        return member ? dropNullsAt(item, member, next) : item;
      });
    }
    case 'record': {
      if (Array.isArray(value)) return value;
      const source = value as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      for (const key of Object.keys(source)) {
        const cleaned = dropNullsAt(source[key], def.valueType as ZodType, next);
        if (cleaned !== source[key]) {
          out ??= { ...source };
          setOwn(out, key, cleaned);
        }
      }
      return out ?? value;
    }
    case 'intersection':
      return dropNullsAt(dropNullsAt(value, def.left as ZodType, next), def.right as ZodType, next);
    case 'union': {
      const options = (def.options as ZodType[] | undefined) ?? [];
      if (options.some((option) => parsesAs(option, value))) return value;
      for (const option of options) {
        const cleaned = dropNullsAt(value, option, next);
        if (cleaned !== value && parsesAs(option, cleaned)) return cleaned;
      }
      return value;
    }
    default:
      return value;
  }
}

/** Sets an own data property, so a `__proto__` key from `JSON.parse` stays a key and never reaches the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The array itself when `map` returns every item unchanged, else a copy with the changed items. */
function mapChanged(items: unknown[], map: (item: unknown, index: number) => unknown): unknown[] {
  let out: unknown[] | undefined;
  items.forEach((item, i) => {
    const mapped = map(item, i);
    if (mapped !== item) {
      out ??= [...items];
      out[i] = mapped;
    }
  });
  return out ?? items;
}

export const MAX_FEEDBACK_BAD_RESPONSE_CHARS = 500;
export const MAX_FEEDBACK_VALIDATION_ISSUES = 5;

/**
 * Truncates a bad LLM response for retry feedback to avoid prompt-token bloat.
 * @internal
 */
export function summarizeBadResponse(text: string): string {
  if (text.length <= MAX_FEEDBACK_BAD_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_FEEDBACK_BAD_RESPONSE_CHARS)}... (truncated, ${text.length - MAX_FEEDBACK_BAD_RESPONSE_CHARS} more chars)`;
}

/**
 * Truncates Zod validation errors for retry feedback.
 * @internal
 */
export function summarizeZodErrors(error: ZodError): string {
  const issues = error.issues.slice(0, MAX_FEEDBACK_VALIDATION_ISSUES);
  const lines = issues.map(i => `- ${i.path.join('.') || '<root>'}: ${i.message}`);
  if (error.issues.length > MAX_FEEDBACK_VALIDATION_ISSUES) {
    lines.push(`(${error.issues.length - MAX_FEEDBACK_VALIDATION_ISSUES} more issues omitted)`);
  }
  return lines.join('\n');
}
