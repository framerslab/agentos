/**
 * @fileoverview Structured-outputs capability helpers for the Anthropic Claude
 * models: which models have the surface, which schemas it carries, and the
 * one function that picks the route a schema request takes.
 *
 * Anthropic's structured-outputs surface has two halves that share one model
 * list and one set of schema limits
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs,
 * read 2026-10-18):
 *
 *   - JSON outputs: `output_config.format = { type: 'json_schema', schema }`
 *     makes the model answer valid JSON in its text block, with thinking,
 *     streaming and tools in the same request. No beta header.
 *   - Strict tool use: `strict: true` on a tool definition makes the API
 *     validate the model's tool input against `input_schema` server-side.
 *
 * {@link anthropicSchemaRoute} decides, for one model and one schema, whether
 * a schema request rides the JSON output format, a forced tool call (Claude
 * Opus 4 and Sonnet 4, which have no JSON outputs and accept a forced
 * `tool_choice`), or the prompt alone. `structuredOutputFormat.ts` computes it
 * when it builds the marker and `AnthropicProvider` computes it again for the
 * model it sends to, on the same object schema, so the two never disagree.
 *
 * The flag is NOT universally supported: models older than the 4.5
 * generation reject unknown tool fields ("tools.0.strict: Extra inputs are
 * not permitted"), so sending it blind would 400 every structured-output
 * call on those models. Tests pin the allowlist so a new model family gets
 * an explicit, reviewed decision instead of silently inheriting behavior.
 *
 * Sibling of `modelSupportsForcedToolChoice` / `modelSupportsThinking`. Kept
 * in its own pure module so the unit test imports no provider/SDK code.
 */
import { modelSupportsForcedToolChoice } from './model-forced-tool-choice.js';

/**
 * The Claude models with Anthropic's structured outputs, JSON outputs and
 * strict tool use alike: Fable 5 and 5.1; Mythos 5, 5.1 and Preview; Opus 4.5
 * through 4.8, 5 and 5.5; Sonnet 4.5, 4.6, 5 and 5.5; Haiku 4.5 and 5.5 (the
 * vendor's "Supported models" list, read 2026-10-18), dated variants
 * included. `\b` matches at the hyphen before a trailing version digit, so
 * `opus-5` covers `claude-opus-5-5` and `fable-5` covers `claude-fable-5-1`,
 * while `sonnet-4-50` is not `sonnet-4-5`. Claude Opus 4 and Claude Sonnet 4
 * (the May 2025 snapshots, `claude-opus-4-20250514` and
 * `claude-sonnet-4-20250514`) are not on the list.
 */
const STRUCTURED_OUTPUTS_MODELS =
  /^claude-(opus-(4-[5-9]|5)|sonnet-(4-[5-9]|5)|haiku-(4-5|5)|fable-5|mythos-(5|preview))\b/i;

/**
 * Whether the Anthropic API accepts `strict: true` on a tool definition for
 * the given Claude model id: the same model list as
 * {@link modelSupportsJsonOutputs}, since the vendor gives both features one.
 *
 * @param modelId Anthropic-side model id (e.g. `"claude-sonnet-5"` or
 *   `"claude-opus-4-8"`, dated variants included).
 * @returns `true` when the model accepts `strict: true` tool definitions.
 */
export function modelSupportsStrictToolUse(modelId: string): boolean {
  return STRUCTURED_OUTPUTS_MODELS.test(modelId);
}

/**
 * Whether the Anthropic API accepts `output_config.format` (JSON outputs) for
 * the given Claude model id. The vendor lists the same models for strict tool
 * use ({@link modelSupportsStrictToolUse}).
 *
 * @param modelId Anthropic-side model id, dated variants included.
 */
export function modelSupportsJsonOutputs(modelId: string): boolean {
  return STRUCTURED_OUTPUTS_MODELS.test(modelId);
}

/**
 * How a schema request reaches a Claude model:
 *
 *  - `json_schema`: `output_config.format` with the schema; the model answers
 *    JSON in its text block.
 *  - `forced_tool`: one tool whose `input_schema` is the schema, with
 *    `tool_choice: { type: 'tool', name }`; the answer is the tool call's
 *    input.
 *  - `none`: neither; the schema rides the prompt and the caller's Zod schema
 *    validates the text.
 */
export type AnthropicSchemaRoute = 'json_schema' | 'forced_tool' | 'none';

/**
 * The route one schema request takes on one model, decided on the object
 * schema the structured-output marker carries (the schema AFTER
 * `ensureAnthropicObjectSchema`, so the builder and the provider judge the
 * same object):
 *
 *  - `json_schema` when the model has JSON outputs
 *    ({@link modelSupportsJsonOutputs}) and the format carries the schema
 *    ({@link jsonOutputSchemaSupported});
 *  - else `forced_tool` when the model has no JSON outputs and accepts a
 *    forced `tool_choice` (Claude Opus 4 and Sonnet 4, whose thinking is off
 *    unless asked);
 *  - else `none`: a model with JSON outputs whose schema the format cannot
 *    carry (a record, an untyped node, a `$ref` or `oneOf`, a root without
 *    properties, or more union-typed or optional properties than the format
 *    takes) answers from the prompt. Claude Opus 5 and Sonnet 5 used to send
 *    such a schema as a non-strict forced tool, clamped to `auto` whenever
 *    thinking was on; the prompt is the honest route.
 *
 * An empty model id (a fallback entry that names no model, resolved to the
 * provider's default later) routes by the schema alone: `json_schema` when
 * the format carries it, else `none`. The provider then decides for its real
 * model, and a schema the format carries is carried by either route the
 * provider computes, so the two never disagree.
 *
 * @param modelId Anthropic-side model id, or `''` when it is not known yet.
 * @param objectSchema The marker's object schema.
 */
export function anthropicSchemaRoute(modelId: string, objectSchema: unknown): AnthropicSchemaRoute {
  const formatCarriesIt = jsonOutputSchemaSupported(objectSchema);
  if (!modelId || modelSupportsJsonOutputs(modelId)) {
    return formatCarriesIt ? 'json_schema' : 'none';
  }
  return modelSupportsForcedToolChoice(modelId) ? 'forced_tool' : 'none';
}

/**
 * Keywords the JSON output format does not take anywhere in a schema: a `$ref`
 * (with the `$defs` and `definitions` it would point at; the vendor takes an
 * internal `$ref`, but the lowering never emits one and a hand-written one is
 * refused whole rather than checked for an external target), `oneOf` (on
 * neither of the vendor's lists), `not`, `if`, `patternProperties` and
 * `dependentSchemas`.
 */
const JSON_OUTPUT_REFUSED_KEYWORDS = [
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'not',
  'if',
  'patternProperties',
  'dependentSchemas',
] as const;

/**
 * Whether the JSON output format carries an object schema as the marker holds
 * it: the schema can be made strict ({@link toolInputSchemaSupportsStrict}: no
 * `additionalProperties` other than `false`, every node typed, the union-typed
 * and optional parameter counts within the vendor's limits), its root is an
 * object with `properties` (a `{ type: 'string' }` or `{ type: 'array' }` root
 * from a direct caller is not one the format answers), and no node carries a
 * keyword of {@link JSON_OUTPUT_REFUSED_KEYWORDS}.
 *
 * A recursive Zod schema (`z.lazy`) lowers to an untyped `{}` node, which the
 * strict check refuses, so it routes away from the format as the vendor's
 * "recursive schemas" exclusion asks, by that path rather than by a `$ref`.
 *
 * @param objectSchema The marker's object schema.
 */
export function jsonOutputSchemaSupported(objectSchema: unknown): boolean {
  if (!objectSchema || typeof objectSchema !== 'object' || Array.isArray(objectSchema)) return false;
  const root = objectSchema as Record<string, unknown>;
  if (!root.properties || typeof root.properties !== 'object' || Array.isArray(root.properties)) return false;
  if (!toolInputSchemaSupportsStrict(objectSchema)) return false;
  return !carriesRefusedKeyword(objectSchema, 0);
}

/** True when `node` or a subschema below it carries a keyword of {@link JSON_OUTPUT_REFUSED_KEYWORDS}. */
function carriesRefusedKeyword(node: unknown, depth: number): boolean {
  if (depth > MAX_STRICT_SCAN_DEPTH) return true;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const schema = node as Record<string, unknown>;
  if (JSON_OUTPUT_REFUSED_KEYWORDS.some((kw) => kw in schema)) return true;
  // `properties` values are subschemas keyed by FIELD name; a field named
  // `$ref` or `not` is data, so only each value's own keys are read.
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const sub of Object.values(properties as Record<string, unknown>)) {
      if (carriesRefusedKeyword(sub, depth + 1)) return true;
    }
  }
  for (const key of ['items', 'prefixItems', 'anyOf', 'allOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) {
      for (const sub of value) if (carriesRefusedKeyword(sub, depth + 1)) return true;
    } else if (value && typeof value === 'object') {
      if (carriesRefusedKeyword(value, depth + 1)) return true;
    }
  }
  for (const key of ['additionalProperties', 'then', 'else', 'contains', 'unevaluatedProperties'] as const) {
    const value = schema[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (carriesRefusedKeyword(value, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * The string formats the JSON output format takes
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs,
 * "String formats", read 2026-10-18). Any other `format` value is refused with
 * `output_config.format.schema: For 'string' type, format '<name>' is not
 * supported` (live-probed 2026-10-18 on claude-haiku-5-5 with `slug`), so
 * {@link anthropicJsonOutputSchema} strips it.
 */
export const JSON_OUTPUT_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * The schema the provider sends as `output_config.format.schema`: the
 * marker's object schema with `additionalProperties: false` stamped on every
 * object node and the keywords the structured-outputs validator rejects
 * removed ({@link toolInputSchemaWithExplicitNoExtraProps}), and, besides,
 * `minItems` above 1 removed (the format takes only 0 and 1: `For 'array'
 * type, 'minItems' values other than 0 or 1 are not supported`, live-probed
 * 2026-10-18 on claude-haiku-5-5; a lowered `z.tuple` carries its arity
 * there) and any `format` outside {@link JSON_OUTPUT_STRING_FORMATS} removed.
 *
 * `minLength`, `maxLength` and `pattern` stay: the same probe answered 200 to
 * each of them on the format, as the strict tool path has kept them since its
 * probe of 2026-07-07. Every strip is lossless for the caller, whose Zod
 * schema re-validates the parsed answer with every constraint.
 *
 * Pure and non-mutating: the caller's schema object is never written to.
 *
 * @param inputSchema The marker's object schema.
 */
export function anthropicJsonOutputSchema(inputSchema: unknown): unknown {
  return stripForJsonOutputs(toolInputSchemaWithExplicitNoExtraProps(inputSchema), 0);
}

function stripForJsonOutputs(node: unknown, depth: number): unknown {
  if (depth > MAX_STRICT_SCAN_DEPTH) return node;
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((sub) => stripForJsonOutputs(sub, depth + 1));
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  if (typeof out.minItems === 'number' && out.minItems > 1) delete out.minItems;
  if ('format' in out && !(typeof out.format === 'string' && JSON_OUTPUT_STRING_FORMATS.has(out.format))) {
    delete out.format;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const) {
    const map = out[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const next: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(map as Record<string, unknown>)) {
        next[k] = stripForJsonOutputs(sub, depth + 1);
      }
      out[key] = next;
    }
  }
  for (const key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf'] as const) {
    if (out[key] !== undefined && typeof out[key] === 'object') out[key] = stripForJsonOutputs(out[key], depth + 1);
  }
  for (const key of ['additionalProperties', 'if', 'then', 'else', 'not', 'contains', 'unevaluatedProperties'] as const) {
    if (out[key] !== undefined && typeof out[key] === 'object') out[key] = stripForJsonOutputs(out[key], depth + 1);
  }
  return out;
}

/**
 * Whether a lowered tool `input_schema` can carry `strict: true` without the
 * Anthropic API rejecting the whole request.
 *
 * The structured-outputs validator requires `additionalProperties` to be
 * PRESENT and exactly `false` on every `object` node (`tools.N.custom: For
 * 'object' type, 'additionalProperties' must be explicitly set to false` —
 * live-API verified 2026-07-07: the key ABSENT is rejected too, nested
 * nodes included). An absent key is REWRITABLE — the provider stamps it via
 * {@link toolInputSchemaWithExplicitNoExtraProps} before sending — but a
 * schema-valued one, which is how `z.record(...)` lowers (dynamic keys are
 * the point, so it can never be `false`), can never satisfy strict mode and
 * 400s deterministically on every attempt. So this check answers "can the
 * schema BE MADE strict", not "is it strict-ready as-lowered".
 *
 * This is the schema-shape half of the strict gate; model capability
 * ({@link modelSupportsStrictToolUse}) is the other half, and
 * AnthropicProvider stamps `strict: true` only when BOTH hold. Without the
 * shape half, every record-bearing generateObject schema (component trees,
 * mechanics compositions, dungeon layouts) failed 100% at the provider the
 * day strict tools shipped — the schema can never satisfy strict mode, so
 * the only sound move is degrading that call to the non-strict forced tool
 * (best-effort adherence + caller-side Zod validation, the pre-strict
 * behavior). Mirrors how the OpenAI / OpenRouter strict paths gate on
 * `canUseStrictJsonSchema` before opting a schema into strict mode.
 *
 * The walk visits only positions that hold subschemas (`properties` /
 * `patternProperties` / `$defs` / `definitions` / `dependentSchemas` VALUES,
 * `items` — single or tuple form — plus `prefixItems`, `anyOf` / `oneOf` /
 * `allOf` members, and the single-schema positions `if` / `then` / `else` /
 * `not` / `contains` / `unevaluatedProperties`) — a FIELD literally named
 * `additionalProperties` inside `properties` must not trip the check.
 *
 * The check also applies Anthropic's explicit complexity limits (see
 * {@link STRICT_MAX_UNION_TYPED_PARAMETERS}): a schema over them 400s on every
 * attempt, so it degrades to the non-strict forced tool too.
 *
 * @param inputSchema Lowered JSON Schema destined for `tool.input_schema`.
 * @returns `true` when no reachable node carries a non-`false`
 *   `additionalProperties` and the schema is within the complexity limits;
 *   `false` otherwise (caller must omit `strict`).
 */
export function toolInputSchemaSupportsStrict(inputSchema: unknown): boolean {
  if (!nodeSupportsStrict(inputSchema, 0)) return false;
  const counts = { unionTyped: 0, optional: 0 };
  countStrictParameters(inputSchema, 0, counts);
  return (
    counts.unionTyped <= STRICT_MAX_UNION_TYPED_PARAMETERS &&
    counts.optional <= STRICT_MAX_OPTIONAL_PARAMETERS
  );
}

/**
 * Anthropic's explicit limit on parameters that use `anyOf` or a type array
 * (`"type": ["string", "null"]`), summed over every strict schema in a request:
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * ("Schema complexity limits"). The forced structured-output tool is the only
 * strict schema in its request, so its own count is the request's total.
 */
export const STRICT_MAX_UNION_TYPED_PARAMETERS = 16;

/**
 * Anthropic's explicit limit on parameters left out of `required`, summed over
 * every strict schema in a request (same page as
 * {@link STRICT_MAX_UNION_TYPED_PARAMETERS}).
 */
export const STRICT_MAX_OPTIONAL_PARAMETERS = 24;

/**
 * Count, below the root, the nodes that use `anyOf` / `oneOf` or a type array,
 * and the object properties left out of `required`. It walks the positions
 * {@link nodeSupportsStrict} walks. A node reached twice (a shared `$defs`
 * entry) counts once per position, which can only over-count, and an
 * over-count only costs strict mode, never the request.
 */
function countStrictParameters(
  node: unknown,
  depth: number,
  counts: { unionTyped: number; optional: number },
): void {
  if (depth > MAX_STRICT_SCAN_DEPTH) return;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;
  if (
    depth > 0 &&
    (Array.isArray(schema.type) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
  ) {
    counts.unionTyped += 1;
  }
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
    for (const name of Object.keys(properties as Record<string, unknown>)) {
      if (!required.has(name)) counts.optional += 1;
    }
  }
  const subschemas: unknown[] = [];
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      subschemas.push(...Object.values(map as Record<string, unknown>));
    }
  }
  for (const key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) subschemas.push(...value);
    else if (value && typeof value === 'object') subschemas.push(value);
  }
  for (const key of ['if', 'then', 'else', 'not', 'contains', 'unevaluatedProperties'] as const) {
    const value = schema[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) subschemas.push(value);
  }
  for (const sub of subschemas) countStrictParameters(sub, depth + 1, counts);
}

/** Defensive recursion bound — lowered schemas are shallow trees; anything
 *  deeper is malformed and must not stack-overflow the request path. */
const MAX_STRICT_SCAN_DEPTH = 64;

/**
 * Whether a JSON-Schema object node declares a concrete type/shape, versus
 * being an empty `{}` (or description-only) node that accepts ANY JSON. The
 * Anthropic structured-outputs validator rejects the latter with "Empty
 * schema ({}) that accepts any JSON value is not supported". Recognized
 * type-defining keywords mirror {@link canUseStrictJsonSchema}'s node scan
 * plus every subschema position this gate already walks.
 */
function nodeHasConcreteType(schema: Record<string, unknown>): boolean {
  const CONCRETE_KEYWORDS = [
    'type', 'enum', 'const', '$ref', 'anyOf', 'oneOf', 'allOf', 'not',
    'properties', 'patternProperties', 'additionalProperties', 'items',
    'prefixItems', 'contains', '$defs', 'definitions', 'if', 'then', 'else',
    'dependentSchemas', 'unevaluatedProperties',
  ] as const;
  return CONCRETE_KEYWORDS.some((k) => k in schema);
}

function nodeSupportsStrict(node: unknown, depth: number): boolean {
  if (depth > MAX_STRICT_SCAN_DEPTH) return false;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
  const schema = node as Record<string, unknown>;
  // Empty / any-JSON node (a `z.unknown()` / `z.any()` lowering to `{}` or a
  // description-only object): Anthropic strict rejects it ("Empty schema ({})
  // that accepts any JSON value is not supported. Please specify a concrete
  // type" — live-verified 2026-07-08 on a GenerateComponentTree `tree:
  // z.unknown()` field). The stamp transform also SKIPS it (it isn't
  // type:object), so it can never be made strict — degrade the whole schema
  // to the non-strict forced tool. Mirrors what canUseStrictJsonSchema
  // already does for the OpenAI path (an untyped node disqualifies); the two
  // gates were asymmetric until now.
  if (!nodeHasConcreteType(schema)) {
    return false;
  }
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    return false;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions'] as const) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const sub of Object.values(map as Record<string, unknown>)) {
        if (!nodeSupportsStrict(sub, depth + 1)) return false;
      }
    }
  }
  const items = schema.items;
  if (Array.isArray(items)) {
    for (const sub of items) if (!nodeSupportsStrict(sub, depth + 1)) return false;
  } else if (items && typeof items === 'object') {
    if (!nodeSupportsStrict(items, depth + 1)) return false;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const sub of members) if (!nodeSupportsStrict(sub, depth + 1)) return false;
    }
  }
  // Draft-2020 completeness (2026-07-07): subschema positions agentos's own
  // lowering never emits but a hand-authored input_schema can carry — a
  // record hidden under any of these must fail the gate exactly like one
  // under `properties`.
  for (const key of ['if', 'then', 'else', 'not', 'contains', 'unevaluatedProperties'] as const) {
    const sub = schema[key];
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
      if (!nodeSupportsStrict(sub, depth + 1)) return false;
    }
  }
  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const sub of prefixItems) if (!nodeSupportsStrict(sub, depth + 1)) return false;
  }
  const dependentSchemas = schema.dependentSchemas;
  if (dependentSchemas && typeof dependentSchemas === 'object' && !Array.isArray(dependentSchemas)) {
    for (const sub of Object.values(dependentSchemas as Record<string, unknown>)) {
      if (!nodeSupportsStrict(sub, depth + 1)) return false;
    }
  }
  return true;
}


/**
 * Rewrite a strict-compatible `input_schema` so every reachable object node
 * carries `additionalProperties: false` EXPLICITLY.
 *
 * The structured-outputs validator does not merely reject schema-valued
 * `additionalProperties` — it requires the key PRESENT and `false` on every
 * `object` node ("For 'object' type, 'additionalProperties' must be
 * explicitly set to false"; live-API verified 2026-07-07: a root OR nested
 * object node with the key absent 400s, while an optional property left out
 * of `required` is accepted). Zod object schemas lower WITHOUT the key, so
 * the capability + shape gates alone still 400'd every zod-lowered
 * structured-output call — the strict stamp needs this rewrite, not just
 * the {@link toolInputSchemaSupportsStrict} shape check.
 *
 * The same walk STRIPS constraint keywords the strict validator rejects
 * (see {@link STRICT_UNSUPPORTED_KEYWORDS}) — stamping alone still 400'd
 * every schema whose Zod lowering carried e.g. an array `.max(...)`.
 *
 * Pure + non-mutating: returns a structural copy; the input schema object
 * is never written to. Positions walked mirror the shape check
 * (`properties` / `patternProperties` / `$defs` / `definitions` /
 * `dependentSchemas` values, `items` — single or tuple form — plus
 * `prefixItems`, `anyOf` / `oneOf` / `allOf` members, and `if` / `then` /
 * `else` / `not` / `contains` / `unevaluatedProperties`). Only nodes that
 * read as object schemas (`type: 'object'`, an
 * `'object'` member of a type array, or a `properties` map) get the stamp.
 * `required` is deliberately untouched: Anthropic strict accepts optional
 * properties — unlike OpenAI's json_schema mode, force-requiring them here
 * would corrupt `.optional()` semantics.
 *
 * Callers gate on {@link toolInputSchemaSupportsStrict} FIRST: a node with
 * a present, non-`false` `additionalProperties` (a lowered `z.record`) can
 * never satisfy strict mode, so the whole schema degrades to the
 * non-strict forced tool instead of being rewritten.
 *
 * @param inputSchema Lowered JSON Schema destined for `tool.input_schema`.
 * @returns A copy with `additionalProperties: false` stamped on every
 *   reachable object node that lacks it.
 */
export function toolInputSchemaWithExplicitNoExtraProps(inputSchema: unknown): unknown {
  return stampNoExtraProps(inputSchema, 0);
}

/**
 * Constraint keywords the structured-outputs strict validator REJECTS with
 * `tools.N.custom: For '<type>' type, property '<kw>' is not supported` —
 * mapped empirically against the live API (2026-07-07, one probe per
 * keyword): arrays reject `maxItems` + `uniqueItems` (while `minItems` is
 * ACCEPTED); numbers reject `minimum` / `maximum` / `exclusiveMinimum` /
 * `multipleOf` (exclusiveMaximum stripped by symmetry); objects reject
 * `minProperties` / `maxProperties`. Accepted and therefore KEPT: `enum`,
 * `const`, `pattern`, `minLength` / `maxLength`, `minItems`, `format`,
 * `default`, `description`. Zod lowerings emit the rejected keywords from
 * everyday builders (`.max(25)` on an array → `maxItems`), so without the
 * strip a strict-stamped schema 400s at request time and the call degrades
 * through retry/fallback to prose — the "Failed to extract valid JSON"
 * lottery structured output exists to prevent. Stripping is lossless for
 * callers: generateObject re-validates the parsed object against the
 * original Zod schema, so the constraints are still enforced caller-side;
 * only API-side enforcement of those bounds is forgone (structure remains
 * guaranteed).
 */
const STRICT_UNSUPPORTED_KEYWORDS = [
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
] as const;

function stampNoExtraProps(node: unknown, depth: number): unknown {
  if (depth > MAX_STRICT_SCAN_DEPTH) return node;
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sub => stampNoExtraProps(sub, depth + 1));
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  for (const kw of STRICT_UNSUPPORTED_KEYWORDS) {
    if (kw in out) delete out[kw];
  }
  const typeIsObject =
    out.type === 'object' ||
    (Array.isArray(out.type) && (out.type as unknown[]).includes('object')) ||
    (out.properties != null && typeof out.properties === 'object');
  if (typeIsObject && !('additionalProperties' in out)) {
    out.additionalProperties = false;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions'] as const) {
    const map = out[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const next: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(map as Record<string, unknown>)) {
        next[k] = stampNoExtraProps(sub, depth + 1);
      }
      out[key] = next;
    }
  }
  if (out.items !== undefined) out.items = stampNoExtraProps(out.items, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = out[key];
    if (Array.isArray(members)) out[key] = members.map(sub => stampNoExtraProps(sub, depth + 1));
  }
  // Draft-2020 completeness (2026-07-07) — mirror of the gate walk: stamp +
  // strip inside conditional/tuple/dependency subschema positions too, so a
  // strict-eligible schema carrying them cannot 400 on an unstamped node.
  for (const key of ['if', 'then', 'else', 'not', 'contains', 'unevaluatedProperties'] as const) {
    if (out[key] !== undefined && typeof out[key] === 'object') {
      out[key] = stampNoExtraProps(out[key], depth + 1);
    }
  }
  if (Array.isArray(out.prefixItems)) {
    out.prefixItems = (out.prefixItems as unknown[]).map(sub => stampNoExtraProps(sub, depth + 1));
  }
  const dependentSchemas = out.dependentSchemas;
  if (dependentSchemas && typeof dependentSchemas === 'object' && !Array.isArray(dependentSchemas)) {
    const next: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(dependentSchemas as Record<string, unknown>)) {
      next[k] = stampNoExtraProps(sub, depth + 1);
    }
    out.dependentSchemas = next;
  }
  return out;
}
