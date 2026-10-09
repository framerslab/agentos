/**
 * @module api/runtime/structuredReply
 *
 * A reply that must match a schema, on the full runtime: the spec a request carries, the text parsed and checked
 * against a Zod or a JSON schema, the repair message a failed attempt is answered with, and the check again after
 * the output guardrails. `generateObject` shares the parsers here.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ZodError, ZodType } from 'zod';
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
  /** How the schema reached the model: a forced tool call lifted by the gateway, the gateway's provider-native schema format, or the instruction in the system prompt alone. */
  enforcement: 'forced_tool' | 'provider_schema' | 'prompt_only';
  /** Where the last check ran: on the model's reply, or on the text an output guardrail rewrote. */
  stage: 'model' | 'post_guardrail';
  issues?: string[];
}

export interface StructuredReplyOutput {
  value: unknown;
  meta: StructuredOutputMeta;
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

let sharedAjv: InstanceType<typeof Ajv> | undefined;
function ajvInstance(): InstanceType<typeof Ajv> {
  if (!sharedAjv) {
    sharedAjv = new Ajv({ allErrors: true, strict: false });
    addFormats(sharedAjv);
  }
  return sharedAjv;
}

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
  let validate: ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
  try {
    validate = ajvInstance().compile(schema) as typeof validate;
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
  let parsed = schema.safeParse(value);
  if (!parsed.success) {
    const repaired = repairStringEncodedContainers(value, parsed.error);
    if (repaired.repaired) parsed = schema.safeParse(repaired.value);
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
  parts.push('The JSON MUST conform to this JSON Schema:');
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
 * @param text - The raw text to parse.
 * @returns The parsed value.
 * @throws {SyntaxError} When no valid JSON can be extracted.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: direct JSON parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to code fence extraction
  }

  // Try extracting from markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Last resort: find the first { and last } to extract a JSON object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new SyntaxError(`No valid JSON found in LLM response: ${trimmed.slice(0, 200)}`);
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
 * One pass, no recursion; anything that does not parse is left untouched so
 * the caller's normal retry/feedback path still applies.
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
