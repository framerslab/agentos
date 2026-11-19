/**
 * @fileoverview The forge trace: one typed record of a forge, whatever its outcome.
 *
 * A trace holds the request as the forge received it, how each test case ran, the judge's verdict and the detail of
 * its reply, the executor that ran the code, who wrote each part, and the stage where the forge ended. Every value in
 * it is a JSON-safe copy under its own cap, so a trace is plain data whose JSON stays under a fixed total.
 *
 * This module holds the trace's types, its stage codes, the caps, and the JSON-safe copy and cuts every field goes
 * through.
 *
 * @module agentos/emergent/ForgeTrace
 */

import type { CreationVerdict } from './types.js';

// ============================================================================
// TYPES
// ============================================================================

/** The shape version of a ForgeTrace. A later shape raises it; readers keep a default branch. */
export const FORGE_TRACE_VERSION = 1;

/** How a forge ended. */
export type ForgeTraceOutcome =
  | 'approved'   // the tool was forged, judged, approved and registered
  | 'rejected'   // the judge ran and did not approve
  | 'refused'    // a check refused the request before the judge, or refused it after the judge's approval
  | 'failed';    // something broke: an executor that could not load, the host's onToolForged that threw, a registration that did not settle, a thrown error

/** The stage codes this release writes. The set grows: read a stage as a string and keep a default branch. */
export const FORGE_TRACE_STAGES = [
  'schema_check',
  'refused_before_approval',
  'shape_check',
  'host_refused',
  'orchestrator_refused',
  'permission_check_failed',
  'human_denied',
  'approval_failed',
  'self_change_refused',
  'name_refused',
  'description_missing',
  'engine_disabled',
  'compose_refused',
  'compose_needs_step_output',
  'caller_context_required',
  'sandbox_disabled',
  'allowlist_unknown',
  'effects_need_ceiling',
  'capability_not_granted',
  'code_validation',
  'executor_unavailable',
  'test_responses_refused',
  'judge_rejected',
  'compose_refused_after_judge',
  'step_cycle',
  'removed_while_forging',
  'activation_failed',
  'registration_failed',
  'approved',
  'thrown',
] as const;
export type KnownForgeTraceStage = (typeof FORGE_TRACE_STAGES)[number];
export type ForgeTraceStage = KnownForgeTraceStage | (string & {});

/** A text or a value cut at its cap: its whole UTF-8 length, and the start kept, ending on a whole character. */
export interface ForgeTraceCut {
  readonly $trace: 'cut';
  readonly bytes: number;      // UTF-8 length of the whole text (of its JSON text, for a value)
  readonly head: string;       // the start kept: the text itself, or the start of the value's JSON text
}

/** A value that could not be written as JSON, in its place. */
export interface ForgeTraceUnserializable {
  readonly $trace: 'unserializable';
  readonly kind: 'bigint' | 'cycle' | 'function' | 'symbol' | 'other';
}

/**
 * A JSON-safe copy of a value: the value itself, a ForgeTraceCut, or a ForgeTraceUnserializable.
 * Typed unknown because the value is whatever the request or the run produced.
 */
export type ForgeTraceValue = unknown;
export type ForgeTraceText = string | ForgeTraceCut;

/** The request as the forge received it, without its test cases (they are in `tests`). */
export interface ForgeTraceRequest {
  readonly name: ForgeTraceText;          // a name has no length limit (IDENTIFIER_PATTERN in ToolName.ts), so it is capped like any text
  readonly description: ForgeTraceText;
  readonly inputSchema: ForgeTraceValue;
  readonly outputSchema: ForgeTraceValue;
  readonly implementation:
    | { readonly mode: 'sandbox'; readonly code: ForgeTraceText; readonly allowlist: readonly ForgeTraceText[] }
    | { readonly mode: 'compose'; readonly steps: ForgeTraceValue };
}

/** One test case of the request and, when it ran, how it ran. */
export interface ForgeTraceTest {
  readonly index: number;                 // its position in the request's testCases
  readonly input: ForgeTraceValue;
  readonly expectedOutput: ForgeTraceValue;
  readonly stepOutputs?: ForgeTraceValue; // a composition's stand-in step outputs, as the request gave them
  readonly responses?: ForgeTraceValue;   // a code tool's answers to its state-changing requests, as given
  readonly ran: boolean;                  // false when the forge ended before this case ran
  readonly result?: ForgeTraceTestRun;    // present exactly when ran is true
}

/** The run of one test case as the judge read it (ForgeTestRun), without its input. */
export type ForgeTraceTestRun = {
  readonly output?: ForgeTraceValue;      // absent when the run produced no output
  readonly success: boolean;
  readonly error?: ForgeTraceText;        // the executor's or the composition's own message, whole up to its cap
  readonly effects?: ForgeTraceValue;     // a composition's unexecuted steps, or a code tool's capability calls
};

/** What the judge's reply held that CreationVerdict drops. Present only when the judge ran. */
export interface ForgeTraceJudgeDetail {
  readonly judgeModel: string | null;      // the model id the judge called
  readonly replyParsed: boolean;           // false when the call failed or the reply did not parse
  readonly judgeError: 'llm_call_failed' | 'reply_unparsable' | null;
  readonly judgeApproved: boolean | null;  // the reply's own `approved`, which the verdict recomputes and ignores
  readonly safetyPassed: boolean | null;
  readonly safetyConcerns: readonly ForgeTraceText[];
  readonly correctnessPassed: boolean | null;
  readonly failedTests: readonly number[]; // as the judge numbered them
  readonly deterministic: boolean | null;  // the reply's determinism.likely; null when absent (the verdict reads absent as 0.5)
  readonly determinismReasoning: ForgeTraceText | null;
  readonly bounded: boolean | null;        // the reply's bounded.likely; null when absent
  readonly boundedReasoning: ForgeTraceText | null;
}

/** The executor that ran the test cases, as it describes itself (its isolation is its author's claim). */
export interface ForgeTraceExecutor {
  readonly name: string;
  readonly isolates: boolean;
}

/** Who wrote one part of the trace. */
export interface ForgeTraceAuthor {
  readonly kind: 'model' | 'caller' | 'execution';
  readonly role: 'forging_agent' | 'judge' | 'direct_caller' | 'executor';
  readonly aiGenerated: boolean | null;   // true for 'model'; null for 'caller' (never guessed); false for 'execution'
  readonly provider: string | null;       // null when AgentOS does not know it
  readonly model: string | null;          // null when AgentOS does not know it
  /**
   * Where provider and model come from: 'answered' when read from the response that wrote the part (the GMI's
   * step); 'requested' when a host or the judge's config named the model it asked for, which a provider fallback
   * can answer with another; null when both are null. A reader never shows a 'requested' model as the author.
   */
  readonly modelSource: 'answered' | 'requested' | null;
  readonly at: string;                    // ISO 8601 UTC: when the part was received or produced
}

/** The verdict as the forge returned it, its reasoning capped like any text. */
export type ForgeTraceVerdict = Readonly<Omit<CreationVerdict, 'reasoning'>> & { readonly reasoning: ForgeTraceText };

/** The machine-readable mark of what in this trace a model wrote. */
export interface ForgeTraceProvenance {
  readonly provenanceVersion: 1;
  readonly request: ForgeTraceAuthor;              // code or steps, schemas, description, test cases
  readonly justification: ForgeTraceAuthor | null; // null when the request carried none
  readonly verdict: ForgeTraceAuthor | null;       // the verdict and judgeDetail; null when no judge ran
  readonly testResults: ForgeTraceAuthor | null;   // kind 'execution'; null when no test ran
}

/** Sizes of the large fields and the fields that were cut. */
export interface ForgeTraceSizes {
  readonly traceBytes: number;            // UTF-8 length of this trace's JSON, after cuts
  readonly codeBytes: number | null;      // the whole code's (or steps' JSON's) length before any cut
  readonly cut: readonly string[];        // paths of the cut fields, such as 'request.implementation.code', 'tests[2].result.output'
  readonly testsOmitted: number;          // test cases past the cap on how many the trace keeps
}

/** One forge, whatever its outcome. */
export interface ForgeTrace {
  readonly traceVersion: typeof FORGE_TRACE_VERSION;
  readonly forgeId: string;               // one id for this forge call
  readonly recordedBy: 'engine' | 'forge_tool' | 'wrapper' | 'orchestrator'; // the layer that ended the forge
  readonly via: 'forge_tool' | 'direct';  // whether the request came through forge_tool or a direct engine.forge call
  readonly agentId: string | null;        // the agent id the forge ran under
  readonly sessionId: string | null;      // the caller's session id when its context carried one (sessionData.sessionId)
  readonly correlationId: string | null;  // the id the engine was given as its sessionId; through a GMI, the turn's id
  readonly toolName: ForgeTraceText | null; // the requested name, when the arguments held one, capped
  readonly mode: 'sandbox' | 'compose' | null;
  readonly outcome: ForgeTraceOutcome;
  readonly stage: ForgeTraceStage;
  readonly reason: ForgeTraceText | null; // the full text of the refusal, rejection or error; null only when approved
  readonly startedAt: string;             // ISO 8601 UTC
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly request: ForgeTraceRequest | null;  // the request whenever the arguments have its shape, whichever layer ended the forge
  readonly rawArguments?: ForgeTraceValue;     // present exactly when request is null: the arguments as they arrived, never coerced
  readonly justification: ForgeTraceText | null;
  readonly tests: readonly ForgeTraceTest[];
  readonly executor: ForgeTraceExecutor | null; // the sandbox forge's executor once the forge reached it; null otherwise
  readonly verdict: ForgeTraceVerdict | null;   // a copy of the verdict, its reasoning capped, present only when the judge ran
  readonly judgeDetail: ForgeTraceJudgeDetail | null;
  readonly toolId: string | null;               // the id the forge minted, once it minted one
  readonly provenance: ForgeTraceProvenance;
  readonly sizes: ForgeTraceSizes;
}

// ============================================================================
// STAGES AND CAPS
// ============================================================================

/** The outcome each stage code ends a forge with. */
const STAGE_OUTCOME: Readonly<Record<KnownForgeTraceStage, ForgeTraceOutcome>> = Object.freeze({
  schema_check: 'refused',
  refused_before_approval: 'refused',
  shape_check: 'refused',
  host_refused: 'refused',
  orchestrator_refused: 'refused',
  permission_check_failed: 'failed',
  human_denied: 'refused',
  approval_failed: 'failed',
  self_change_refused: 'refused',
  name_refused: 'refused',
  description_missing: 'refused',
  engine_disabled: 'refused',
  compose_refused: 'refused',
  compose_needs_step_output: 'refused',
  caller_context_required: 'refused',
  sandbox_disabled: 'refused',
  allowlist_unknown: 'refused',
  effects_need_ceiling: 'refused',
  capability_not_granted: 'refused',
  code_validation: 'refused',
  executor_unavailable: 'failed',
  test_responses_refused: 'refused',
  judge_rejected: 'rejected',
  compose_refused_after_judge: 'refused',
  step_cycle: 'refused',
  removed_while_forging: 'failed',
  activation_failed: 'failed',
  registration_failed: 'failed',
  approved: 'approved',
  thrown: 'failed',
} satisfies Record<KnownForgeTraceStage, ForgeTraceOutcome>);

/**
 * The caps on a trace's fields. Each is a number of bytes of the field's own JSON text in the trace, escaping
 * included, except `judgeConcerns`, `failedTests`, `allowlistEntries` and `tests`, which count entries, and `total`,
 * the bound on the whole trace's JSON.
 *
 * @internal
 */
export const FORGE_TRACE_CAPS: Readonly<{
  code: 65_536; description: 2_048; schema: 8_192; testField: 2_048; testOutput: 4_096; text: 4_096;
  testEffects: 2_048; judgeText: 1_024; judgeConcerns: 16; failedTests: 64; verdictReasoning: 16_384;
  name: 256; allowlistEntries: 64; allowlistEntry: 256; rawArguments: 65_536; justification: 2_048;
  other: 2_048; tests: 16; total: 524_288;
}> = Object.freeze({
  code: 65_536,
  description: 2_048,
  schema: 8_192,
  testField: 2_048,
  testOutput: 4_096,
  text: 4_096,
  testEffects: 2_048,
  judgeText: 1_024,
  judgeConcerns: 16,
  failedTests: 64,
  verdictReasoning: 16_384,
  name: 256,
  allowlistEntries: 64,
  allowlistEntry: 256,
  rawArguments: 65_536,
  justification: 2_048,
  other: 2_048,
  tests: 16,
  total: 524_288,
} as const);

// ============================================================================
// THE JSON-SAFE COPY
// ============================================================================

/**
 * How many levels of objects and arrays the copy walks. A value nested deeper is written as an `other` marker at
 * that depth, so neither the copy nor the measurement of its JSON can run out of stack.
 */
const MAX_COPY_DEPTH = 256;

/** What the copy returns for `undefined`: an object leaves the key out, and an array holds `null` in its place. */
const OMITTED: unique symbol = Symbol('omitted');

function unserializable(kind: ForgeTraceUnserializable['kind']): ForgeTraceUnserializable {
  return { $trace: 'unserializable', kind };
}

/** Sets `key` as an own, enumerable property, so a key named `__proto__` is kept as a key and changes no prototype. */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The JSON-safe copy of a value, with no cap: what `JSON.stringify` would write, as plain data, with a marker in the
 * place of each value it cannot write. A BigInt, a function and a symbol become a `ForgeTraceUnserializable` of their
 * kind; a value that repeats one of its own ancestors becomes a `cycle` marker there; a property, a `toJSON` or a
 * `Proxy` trap that throws becomes an `other` marker in its place, as does a value nested more than 256 levels deep.
 * `toJSON` is called as `JSON.stringify` calls it, so a `Date` becomes its ISO text. `undefined` leaves an object's
 * key absent and is `null` in an array; `NaN` and the infinities are `null`. Never throws.
 *
 * @param value - Any value.
 * @returns The copy; `undefined` for `undefined`.
 * @internal
 */
export function jsonSafeCopy(value: unknown): unknown {
  const copy = copyValue(value, '', new Set<object>(), 0);
  return copy === OMITTED ? undefined : copy;
}

function copyValue(input: unknown, key: string, ancestors: Set<object>, depth: number): unknown {
  let value = input;
  if ((typeof value === 'object' && value !== null) || typeof value === 'function' || typeof value === 'bigint') {
    try {
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        value = toJSON.call(value, key);
      }
    } catch {
      return unserializable('other');
    }
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'undefined':
      return OMITTED;
    case 'bigint':
      return unserializable('bigint');
    case 'symbol':
      return unserializable('symbol');
    case 'function':
      return unserializable('function');
  }
  if (value === null) {
    return null;
  }
  const source = value as object;
  try {
    if (source instanceof Number) {
      const number = Number(source);
      return Number.isFinite(number) ? number : null;
    }
    if (source instanceof String) {
      return String(source);
    }
    if (source instanceof Boolean) {
      return Boolean.prototype.valueOf.call(source);
    }
    if (source instanceof BigInt) {
      return unserializable('bigint');
    }
    if (ancestors.has(source)) {
      return unserializable('cycle');
    }
    if (depth >= MAX_COPY_DEPTH) {
      return unserializable('other');
    }
    ancestors.add(source);
    try {
      return Array.isArray(source)
        ? copyArray(source, ancestors, depth)
        : copyObject(source, ancestors, depth);
    } finally {
      ancestors.delete(source);
    }
  } catch {
    return unserializable('other');
  }
}

function copyArray(list: readonly unknown[], ancestors: Set<object>, depth: number): unknown[] {
  const length = list.length;
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let item: unknown;
    try {
      item = list[index];
    } catch {
      out.push(unserializable('other'));
      continue;
    }
    const copy = copyValue(item, String(index), ancestors, depth + 1);
    out.push(copy === OMITTED ? null : copy);
  }
  return out;
}

function copyObject(source: object, ancestors: Set<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    let item: unknown;
    try {
      item = (source as Record<string, unknown>)[key];
    } catch {
      defineKey(out, key, unserializable('other'));
      continue;
    }
    const copy = copyValue(item, key, ancestors, depth + 1);
    if (copy !== OMITTED) {
      defineKey(out, key, copy);
    }
  }
  return out;
}

/** The JSON text of a value's copy; `'undefined'` for `undefined`, which has none. Never throws. */
function jsonText(value: unknown): string {
  try {
    const json = JSON.stringify(jsonSafeCopy(value));
    return json === undefined ? 'undefined' : json;
  } catch {
    return JSON.stringify(unserializable('other'));
  }
}

// ============================================================================
// CUTS
// ============================================================================

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** `end`, moved back to the start of the character it falls inside, so `text.slice(0, end)` ends on a whole character. */
function wholeCharacterEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    return end - 1;
  }
  return end;
}

/**
 * Whether a string's JSON text fits `capBytes`. Every UTF-16 unit of a string is at least one byte of its JSON text,
 * and the quotes are two more, so a string longer than the cap is answered without writing its JSON.
 */
function stringFits(text: string, capBytes: number): boolean {
  return text.length + 2 <= capBytes && jsonBytes(text) <= capBytes;
}

/**
 * The longest start of `text` that ends on a whole character and for which `fits` holds, or the empty start when
 * none does. A binary search over the first `2 * capBytes + 2` UTF-16 units: every unit is at least one byte of JSON,
 * so a start past that cannot fit, and a text of any length costs the same search.
 */
function longestFittingStart(text: string, capBytes: number, fits: (start: string) => boolean): string {
  let low = 0;
  let high = Math.min(text.length, 2 * capBytes + 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, wholeCharacterEnd(text, middle)))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, wholeCharacterEnd(text, low));
}

/** A cut of `text` whose own JSON fits `capBytes`: the text's whole UTF-8 length and the longest start that fits. */
function cutOf(text: string, capBytes: number): ForgeTraceCut {
  const bytes = Buffer.byteLength(text);
  const head = longestFittingStart(text, capBytes, (start) => jsonBytes({ $trace: 'cut', bytes, head: start }) <= capBytes);
  return { $trace: 'cut', bytes, head };
}

/**
 * A text field: kept whole when its JSON fits `capBytes`, else a ForgeTraceCut; a non-string is written as its JSON
 * text first (through {@link jsonSafeCopy}; `undefined`, which has none, as `'undefined'`). Pushes `path` onto `cut`
 * when it cuts. Never throws.
 *
 * @param text - The field's text, or a value to write as its JSON text.
 * @param capBytes - The field's cap: the most bytes its JSON may take, the marker's own JSON when it is cut.
 * @param path - The field's path in the trace, such as `request.implementation.code`.
 * @param cut - The trace's list of cut paths.
 * @returns The text, or its cut.
 * @internal
 */
export function traceText(text: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceText {
  const whole = typeof text === 'string' ? text : jsonText(text);
  if (stringFits(whole, capBytes)) {
    return whole;
  }
  const marker = cutOf(whole, capBytes);
  cut.push(path);
  return marker;
}

/**
 * A value field: the JSON-safe copy ({@link jsonSafeCopy}) when its JSON fits `capBytes`, else a ForgeTraceCut of
 * that JSON text; `undefined` for `undefined`. Pushes `path` onto `cut` when it cuts. Never throws: a value whose JSON
 * cannot be written at all becomes an `other` marker.
 *
 * @param value - The field's value.
 * @param capBytes - The field's cap: the most bytes its JSON may take, the marker's own JSON when it is cut.
 * @param path - The field's path in the trace, such as `tests[2].result.output`.
 * @param cut - The trace's list of cut paths.
 * @returns The copy, its cut, or `undefined`.
 * @internal
 */
export function traceValue(value: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const copy = jsonSafeCopy(value);
    const json = JSON.stringify(copy);
    if (json === undefined) {
      return undefined;
    }
    if (json.length <= capBytes && Buffer.byteLength(json) <= capBytes) {
      return copy;
    }
    const marker = cutOf(json, capBytes);
    cut.push(path);
    return marker;
  } catch {
    return unserializable('other');
  }
}

/**
 * A plain-string field (ids, the executor's name, provider and model names): whole when its JSON fits `capBytes`,
 * else its longest start that ends on a whole character and whose JSON fits, with `path` pushed onto `cut`. No
 * marker: the field's type is string. Never throws.
 *
 * @param text - The field's text.
 * @param capBytes - The field's cap: the most bytes its JSON may take.
 * @param path - The field's path in the trace, such as `forgeId`.
 * @param cut - The trace's list of cut paths.
 * @returns The text, or its start.
 * @internal
 */
export function traceString(text: string, capBytes: number, path: string, cut: string[]): string {
  const whole = typeof text === 'string' ? text : jsonText(text);
  if (stringFits(whole, capBytes)) {
    return whole;
  }
  const start = longestFittingStart(whole, capBytes, (candidate) => jsonBytes(candidate) <= capBytes);
  cut.push(path);
  return start;
}
