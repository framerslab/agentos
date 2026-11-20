/**
 * @fileoverview The forge trace: one typed record of a forge, whatever its outcome.
 *
 * A trace holds the request as the forge received it, how each test case ran, the judge's verdict and the detail of
 * its reply, the executor that ran the code, who wrote each part, and the stage where the forge ended. Every value in
 * it is a JSON-safe copy under its own cap, so a trace is plain data whose JSON stays under a fixed total.
 *
 * This module holds the trace's types, its stage codes, the caps, the JSON-safe copy and cuts every field goes
 * through, the builder every layer uses, the per-call record that carries a forge's trace from the layer that ended
 * it to the layers around it, and the delivery that writes the forge's log line and hands the trace to a host's hook.
 *
 * @module agentos/emergent/ForgeTrace
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { moduleLogger } from '../../core/logging/loggerFactory.js';
import { listedErrorFields } from '../../core/logging/events.js';
import type { CreationVerdict, ForgeTestRun } from './types.js';

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
  'guardrail_refused',
  'schema_check',
  'refused_before_approval',
  'shape_check',
  'host_refused',
  'orchestrator_refused',
  'permission_check_failed',
  'human_denied',
  'approval_timed_out',
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
  'test_output_unserializable',
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

/**
 * A text or a value cut at its cap: its whole UTF-8 length, and the start kept, ending on a whole character. A value is
 * read no further than 64 times its field's cap, so the whole length of a larger one is not known: `bytes` is null.
 */
export interface ForgeTraceCut {
  readonly $trace: 'cut';
  readonly bytes: number | null; // UTF-8 length of the whole text (of its JSON text, for a value); null when not measured
  readonly head: string;         // the start kept: the text itself, or the start of the value's JSON text
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

/**
 * The verdict as the forge returned it, its reasoning capped like any text. A score JSON cannot write (an infinity,
 * which a judge's reply such as `"confidence": 1e999` parses to) is null.
 */
export type ForgeTraceVerdict = {
  readonly [K in keyof Omit<CreationVerdict, 'reasoning'>]: CreationVerdict[K] extends number
    ? number | null
    : CreationVerdict[K];
} & { readonly reasoning: ForgeTraceText };

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
  readonly codeBytes: number | null;      // the whole code's (or steps' JSON's) length before any cut; null with no request, or for steps read no further than 64 times their cap
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
  guardrail_refused: 'refused',
  schema_check: 'refused',
  refused_before_approval: 'refused',
  shape_check: 'refused',
  host_refused: 'refused',
  orchestrator_refused: 'refused',
  permission_check_failed: 'failed',
  human_denied: 'refused',
  approval_timed_out: 'refused',
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
  test_output_unserializable: 'refused',
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

/**
 * How long a forge waits, in milliseconds, for the promise a host's onForgeTrace returns to settle. A hook running past
 * it is left running, and the forge goes on. The bound starts when the hook returns: the hook's synchronous work runs
 * on the forge's own call before that, to its end, and no timer can cut it short.
 *
 * @internal
 */
export const FORGE_TRACE_HOOK_BOUND_MS = 1_000;

// ============================================================================
// THE JSON-SAFE COPY
// ============================================================================

/**
 * How many levels of objects and arrays the copy walks. A value nested deeper is written as an `other` marker at
 * that depth, so neither the copy nor the measurement of its JSON can run out of stack.
 */
const MAX_COPY_DEPTH = 256;

/**
 * How far a field's walk reads a value, as a multiple of the field's cap: the walk counts one unit for each value it
 * visits and one for each UTF-16 unit of each string and key, and stops when the count passes 64 times the cap. A value
 * it stops in is cut, with its whole size unknown.
 */
const MEASURE_FACTOR = 64;

/**
 * How many values the JSON-safe copy visits before it stops: a value with more (an array-shaped value whose length runs
 * to a billion, a host object with as many keys) is copied as one `other` marker. String lengths are not counted: the
 * copy holds a string as it is.
 */
const COPY_READ_BOUND = 1_048_576;

/** What the copy returns for `undefined`: an object leaves the key out, and an array holds `null` in its place. */
const OMITTED: unique symbol = Symbol('omitted');

function unserializable(kind: ForgeTraceUnserializable['kind']): ForgeTraceUnserializable {
  return { $trace: 'unserializable', kind };
}

/** Sets `key` as an own, enumerable property, so a key named `__proto__` is kept as a key and changes no prototype. */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * One walk of a value: the JSON-safe copy and, when `textUnits` is above zero, the start of the copy's JSON text and
 * that text's UTF-8 length, both written as the walk goes, so no whole copy or whole text is made of a value larger than
 * its field keeps.
 */
interface Walk {
  /** The most UTF-16 units of JSON text to keep; 0 writes none. */
  readonly textUnits: number;
  /** The most UTF-16 units of JSON text the copy is built for; past it, the copy is dropped. */
  readonly copyUnits: number;
  /** The units of reading the walk may spend: one a value visited, one a UTF-16 unit of a string or key. */
  readonly budget: number;
  readonly parts: string[];
  keptUnits: number;
  /** UTF-8 length of the JSON text written so far, kept or not. */
  bytes: number;
  spent: number;
  /** Whether the copy is still built. */
  building: boolean;
  /** Whether a piece of the text was left out or cut, so `parts` holds a start of the text and not all of it. */
  truncated: boolean;
  /** Whether the walk spent its budget and stopped before the value's end. */
  stopped: boolean;
}

function newWalk(textUnits: number, copyUnits: number, budget: number): Walk {
  return {
    textUnits,
    copyUnits,
    budget,
    parts: [],
    keptUnits: 0,
    bytes: 0,
    spent: 0,
    building: true,
    truncated: false,
    stopped: false,
  };
}

/** Keeps `piece` of the JSON text when there is room, and drops the copy once the kept text passes `copyUnits`. */
function keepPiece(walk: Walk, piece: string): void {
  walk.parts.push(piece);
  walk.keptUnits += piece.length;
  if (walk.keptUnits > walk.copyUnits) {
    walk.building = false;
  }
}

/** Writes a piece of punctuation, a literal, a number or a marker: ASCII text, a byte a unit. */
function writeRaw(walk: Walk, piece: string): void {
  if (walk.textUnits === 0 || walk.stopped) {
    return;
  }
  walk.bytes += piece.length;
  if (walk.keptUnits < walk.textUnits) {
    keepPiece(walk, piece);
  } else {
    walk.truncated = true;
  }
}

/** The UTF-8 length of the JSON escape of `text`, without its quotes, as `JSON.stringify` writes it. */
function escapedBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20) {
      // \b, \t, \n, \f and \r take two bytes; every other control character a six-byte \u escape.
      bytes += unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6;
    } else if (unit === 0x22 || unit === 0x5c) {
      bytes += 2;
    } else if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else if (isHighSurrogate(unit) || isLowSurrogate(unit)) {
      // A lone surrogate is written as a \u escape.
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Writes `text` as a JSON string: its UTF-8 length when the budget reaches its end, and as much of its JSON text as
 * there is room for. Only the start kept is escaped, so a long string costs the room, not its length.
 */
function writeString(walk: Walk, text: string): void {
  if (walk.textUnits === 0 || walk.stopped) {
    return;
  }
  const room = walk.textUnits - walk.keptUnits;
  if (room > 0) {
    if (text.length <= room) {
      keepPiece(walk, JSON.stringify(text));
    } else {
      // Every unit is at least one unit of JSON, so `room` units of the text fill the room, and the start kept (its
      // closing quote dropped) passes it. The start never ends between the two halves of a pair, which JSON would write
      // as two escapes the whole text does not have.
      let end = room;
      if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
        end += 1;
      }
      const start = JSON.stringify(text.slice(0, end));
      keepPiece(walk, start.slice(0, -1));
      walk.truncated = true;
    }
  } else {
    walk.truncated = true;
  }
  if (walk.spent + text.length > walk.budget) {
    walk.spent = walk.budget;
    walk.stopped = true;
    walk.truncated = true;
    return;
  }
  walk.spent += text.length;
  walk.bytes += 2 + escapedBytes(text);
}

/** Writes a marker and returns it. */
function writeMarker(walk: Walk, kind: ForgeTraceUnserializable['kind']): ForgeTraceUnserializable {
  const marker = unserializable(kind);
  writeRaw(walk, JSON.stringify(marker));
  return marker;
}

/**
 * The value `JSON.stringify` writes in the place of `input` under `key`: what its `toJSON` returns, when it has one,
 * else `input` itself; an `other` marker when reading or calling `toJSON` throws.
 */
function resolveJson(input: unknown, key: string): { value: unknown } | { thrown: true } {
  if ((typeof input === 'object' && input !== null) || typeof input === 'function' || typeof input === 'bigint') {
    try {
      const toJSON = (input as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        return { value: toJSON.call(input, key) };
      }
    } catch {
      return { thrown: true };
    }
  }
  return { value: input };
}

/** Spends one unit for a value visited; false once the budget is spent, when the walk stops. */
function spend(walk: Walk): boolean {
  walk.spent += 1;
  if (walk.spent > walk.budget) {
    walk.stopped = true;
    walk.truncated = true;
  }
  return !walk.stopped;
}

/**
 * Walks one value: writes its JSON text and returns its copy, or OMITTED for a value JSON leaves out (`undefined`
 * after `toJSON`), which writes nothing. Never throws. Once the walk has stopped it writes nothing more.
 */
function walkValue(walk: Walk, input: unknown, key: string, ancestors: Set<object>, depth: number): unknown {
  if (!spend(walk)) {
    return OMITTED;
  }
  const resolved = resolveJson(input, key);
  return 'thrown' in resolved ? writeMarker(walk, 'other') : walkResolved(walk, resolved.value, ancestors, depth);
}

/** Walks a value whose `toJSON` has been called, as `JSON.stringify` calls it: once. */
function walkResolved(walk: Walk, value: unknown, ancestors: Set<object>, depth: number): unknown {
  switch (typeof value) {
    case 'string':
      writeString(walk, value);
      return value;
    case 'boolean':
      writeRaw(walk, value ? 'true' : 'false');
      return value;
    case 'number':
      if (Number.isFinite(value)) {
        writeRaw(walk, JSON.stringify(value));
        return value;
      }
      writeRaw(walk, 'null');
      return null;
    case 'undefined':
      return OMITTED;
    case 'bigint':
      return writeMarker(walk, 'bigint');
    case 'symbol':
      return writeMarker(walk, 'symbol');
    case 'function':
      return writeMarker(walk, 'function');
  }
  if (value === null) {
    writeRaw(walk, 'null');
    return null;
  }
  return walkObject(walk, value as object, ancestors, depth);
}

/**
 * Walks an object or an array. Every read that can throw (a getter, a `Proxy` trap, a revoked `Proxy`) is made
 * before the opening bracket is written or is caught where it is made, so a throw leaves no part of the text written.
 */
function walkObject(walk: Walk, source: object, ancestors: Set<object>, depth: number): unknown {
  let keys: string[] | null = null;
  let length = 0;
  try {
    if (source instanceof Number) {
      const number = Number(source);
      const finite = Number.isFinite(number);
      writeRaw(walk, finite ? JSON.stringify(number) : 'null');
      return finite ? number : null;
    }
    if (source instanceof String) {
      const text = String(source);
      writeString(walk, text);
      return text;
    }
    if (source instanceof Boolean) {
      const flag = Boolean.prototype.valueOf.call(source);
      writeRaw(walk, flag ? 'true' : 'false');
      return flag;
    }
    if (source instanceof BigInt) {
      return writeMarker(walk, 'bigint');
    }
    if (ancestors.has(source)) {
      return writeMarker(walk, 'cycle');
    }
    if (depth >= MAX_COPY_DEPTH) {
      return writeMarker(walk, 'other');
    }
    if (Array.isArray(source)) {
      // Read and converted here, inside the guard, as `JSON.stringify` converts it (a whole number, 0 for NaN or less):
      // a `Proxy` can give a length that is a symbol or an object whose conversion to a number throws, and the array
      // is then an `other` marker in its place.
      const converted = Number((source as { length: unknown }).length);
      length = converted > 0 ? Math.floor(converted) : 0;
    } else {
      keys = jsonKeyOrder(Object.keys(source));
    }
  } catch {
    return writeMarker(walk, 'other');
  }
  ancestors.add(source);
  try {
    return keys === null
      ? walkArray(walk, source as readonly unknown[], length, ancestors, depth)
      : walkKeys(walk, source, keys, ancestors, depth);
  } finally {
    ancestors.delete(source);
  }
}

function walkArray(
  walk: Walk,
  list: readonly unknown[],
  length: number,
  ancestors: Set<object>,
  depth: number,
): unknown[] {
  const out: unknown[] = [];
  writeRaw(walk, '[');
  for (let index = 0; index < length; index += 1) {
    // A slot is counted before it is read, as an object's value is, so a slot whose read throws is counted too and an
    // array-shaped value with a huge length stops at the budget.
    if (!spend(walk)) {
      break;
    }
    if (index > 0) {
      writeRaw(walk, ',');
    }
    let item: unknown;
    let unreadable = false;
    try {
      item = list[index];
    } catch {
      unreadable = true;
    }
    const key = String(index);
    const resolved = unreadable ? null : resolveJson(item, key);
    const copy =
      resolved === null || 'thrown' in resolved
        ? writeMarker(walk, 'other')
        : walkResolved(walk, resolved.value, ancestors, depth + 1);
    if (copy === OMITTED && !walk.stopped) {
      writeRaw(walk, 'null');
    }
    if (walk.building) {
      out.push(copy === OMITTED ? null : copy);
    }
  }
  writeRaw(walk, ']');
  return out;
}

function walkKeys(
  walk: Walk,
  source: object,
  keys: readonly string[],
  ancestors: Set<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  writeRaw(walk, '{');
  let written = 0;
  for (const key of keys) {
    // A value is counted before it is read, so a walk that has spent its budget runs no further getter.
    if (!spend(walk)) {
      break;
    }
    let item: unknown;
    let unreadable = false;
    try {
      item = (source as Record<string, unknown>)[key];
    } catch {
      unreadable = true;
    }
    // The key is written only once its value is known to be written: JSON leaves out a key whose value is undefined.
    const resolved = unreadable ? null : resolveJson(item, key);
    if (resolved !== null && 'value' in resolved && resolved.value === undefined) {
      continue;
    }
    if (written > 0) {
      writeRaw(walk, ',');
    }
    writeString(walk, key);
    writeRaw(walk, ':');
    written += 1;
    let copy: unknown;
    if (resolved === null || 'thrown' in resolved) {
      copy = writeMarker(walk, 'other');
    } else {
      copy = walkResolved(walk, resolved.value, ancestors, depth + 1);
    }
    if (walk.building && copy !== OMITTED) {
      defineKey(out, key, copy);
    }
  }
  writeRaw(walk, '}');
  return out;
}

/**
 * Keys in the order `JSON.stringify` writes a plain object's: array-index keys in ascending order, then the rest as
 * given. `Object.keys` gives that order for an ordinary object; a `Proxy` can give another.
 */
function jsonKeyOrder(keys: string[]): string[] {
  const indexes: string[] = [];
  const others: string[] = [];
  for (const key of keys) {
    if (isArrayIndex(key)) {
      indexes.push(key);
    } else {
      others.push(key);
    }
  }
  if (indexes.length === 0) {
    return others;
  }
  indexes.sort((a, b) => Number(a) - Number(b));
  return [...indexes, ...others];
}

function isArrayIndex(key: string): boolean {
  if (key === '0') {
    return true;
  }
  if (!/^[1-9][0-9]{0,9}$/.test(key)) {
    return false;
  }
  return Number(key) < 4_294_967_295;
}

/**
 * The JSON-safe copy of a value, with no cap: what `JSON.stringify` would write, as plain data, with a marker in the
 * place of each value it cannot write. A BigInt, a function and a symbol become a `ForgeTraceUnserializable` of their
 * kind; a value that repeats one of its own ancestors becomes a `cycle` marker there; a property, a `toJSON` or a
 * `Proxy` trap that throws becomes an `other` marker in its place, as does a value nested more than 256 levels deep.
 * `toJSON` is called as `JSON.stringify` calls it, so a `Date` becomes its ISO text. `undefined` leaves an object's
 * key absent and is `null` in an array; `NaN` and the infinities are `null`. A value holding more than 1,048,576 values
 * (strings, numbers, objects and array slots, each counted once it is visited) is copied as one `other` marker, so an
 * array-shaped value whose length runs to a billion ends. Never throws.
 *
 * @param value - Any value.
 * @returns The copy; `undefined` for `undefined`.
 * @internal
 */
export function jsonSafeCopy(value: unknown): unknown {
  const walk = newWalk(0, Number.POSITIVE_INFINITY, COPY_READ_BOUND);
  const copy = walkValue(walk, value, '', new Set<object>(), 0);
  if (walk.stopped) {
    return unserializable('other');
  }
  return copy === OMITTED ? undefined : copy;
}

/** What a field's walk gives: the copy, the start of its JSON text, whether that start is the whole text, and its size. */
interface FieldWalk {
  /** The copy, built while its JSON text is within the cap; OMITTED for a value JSON has no text for. */
  readonly copy: unknown;
  readonly text: string;
  readonly whole: boolean;
  /** The UTF-8 length of the whole JSON text; null when the walk stopped before the value's end. */
  readonly bytes: number | null;
}

/**
 * Walks a field's value under its cap: keeps the copy while its JSON text is within the cap, keeps `2 * capBytes + 3`
 * UTF-16 units of the text (more than any cut of it can keep), and reads no further than 64 times the cap.
 */
function walkField(value: unknown, capBytes: number): FieldWalk {
  const walk = newWalk(2 * capBytes + 3, capBytes, MEASURE_FACTOR * capBytes);
  try {
    const copy = walkValue(walk, value, '', new Set<object>(), 0);
    return { copy, text: walk.parts.join(''), whole: !walk.truncated, bytes: walk.stopped ? null : walk.bytes };
  } catch {
    // The walk guards every read; this is an engine's own failure, such as running out of memory.
    const marker = unserializable('other');
    const text = JSON.stringify(marker);
    return { copy: marker, text, whole: true, bytes: text.length };
  }
}

// ============================================================================
// CUTS
// ============================================================================

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
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
 * so a start past that cannot fit, and a text of any length costs the same search. A text that is itself the start of
 * a longer one, of at least `2 * capBytes + 3` units, gives the same start as the longer one.
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

/** A cut of a text whose own JSON fits `capBytes`, from the text or a start of it: its whole UTF-8 length and the head. */
function cutOf(text: string, bytes: number | null, capBytes: number): ForgeTraceCut {
  const head = longestFittingStart(text, capBytes, (start) => jsonBytes({ $trace: 'cut', bytes, head: start }) <= capBytes);
  return { $trace: 'cut', bytes, head };
}

/**
 * A text field: kept whole when its JSON fits `capBytes`, else a ForgeTraceCut; a non-string is written as its JSON
 * text first (as {@link jsonSafeCopy} writes it; `undefined`, which has none, as `'undefined'`), from a walk that reads
 * no further than 64 times the cap. Pushes `path` onto `cut` when it cuts. Never throws.
 *
 * @param text - The field's text, or a value to write as its JSON text.
 * @param capBytes - The field's cap: the most bytes its JSON may take, the marker's own JSON when it is cut.
 * @param path - The field's path in the trace, such as `request.implementation.code`.
 * @param cut - The trace's list of cut paths.
 * @returns The text, or its cut.
 * @internal
 */
export function traceText(text: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceText {
  const json = typeof text === 'string' ? null : fieldText(text, capBytes);
  const whole = json === null ? (text as string) : json.text;
  if ((json === null || json.whole) && stringFits(whole, capBytes)) {
    return whole;
  }
  const marker = cutOf(whole, json === null ? Buffer.byteLength(whole) : json.bytes, capBytes);
  cut.push(path);
  return marker;
}

/** A non-string's JSON text from a bounded walk; `'undefined'` for a value JSON has no text for. */
function fieldText(value: unknown, capBytes: number): { text: string; whole: boolean; bytes: number | null } {
  const walked = walkField(value, capBytes);
  return walked.copy === OMITTED
    ? { text: 'undefined', whole: true, bytes: 9 }
    : { text: walked.text, whole: walked.whole, bytes: walked.bytes };
}

/**
 * A value field: the JSON-safe copy ({@link jsonSafeCopy}) when its JSON fits `capBytes`, else a ForgeTraceCut of
 * that JSON text; `undefined` for `undefined`. The value is walked once, no further than 64 times the cap, and no copy
 * or text is made of more than the field keeps: a value the walk stops in is cut with `bytes` null. Pushes `path` onto
 * `cut` when it cuts. Never throws.
 *
 * @param value - The field's value.
 * @param capBytes - The field's cap: the most bytes its JSON may take, the marker's own JSON when it is cut.
 * @param path - The field's path in the trace, such as `tests[2].result.output`.
 * @param cut - The trace's list of cut paths.
 * @returns The copy, its cut, or `undefined`.
 * @internal
 */
export function traceValue(value: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceValue | undefined {
  return fieldValue(value, capBytes, path, cut).value;
}

/** {@link traceValue}, with the UTF-8 length of the value's whole JSON text (null when the walk stopped first). */
function fieldValue(
  value: unknown,
  capBytes: number,
  path: string,
  cut: string[],
): { value: ForgeTraceValue | undefined; bytes: number | null } {
  if (value === undefined) {
    return { value: undefined, bytes: 0 };
  }
  const walked = walkField(value, capBytes);
  if (walked.copy === OMITTED) {
    return { value: undefined, bytes: 0 };
  }
  if (walked.whole && walked.bytes !== null && walked.text.length <= capBytes && walked.bytes <= capBytes) {
    return { value: walked.copy, bytes: walked.bytes };
  }
  cut.push(path);
  return { value: cutOf(walked.text, walked.bytes, capBytes), bytes: walked.bytes };
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
  const json = typeof text === 'string' ? null : fieldText(text, capBytes);
  const whole = json === null ? text : json.text;
  if ((json === null || json.whole) && stringFits(whole, capBytes)) {
    return whole;
  }
  const start = longestFittingStart(whole, capBytes, (candidate) => jsonBytes(candidate) <= capBytes);
  cut.push(path);
  return start;
}

// ============================================================================
// THE PER-CALL RECORD
// ============================================================================

/**
 * Who wrote a forge's request, as the layer that saw it knows it: a model through forge_tool (`forging_agent`), or the
 * code that called the engine itself (`direct_caller`), with the provider and model when that layer knows them.
 *
 * @internal
 */
export interface ForgeCallAuthor {
  kind: 'model' | 'caller';
  role: 'forging_agent' | 'direct_caller';
  provider: string | null;
  model: string | null;
  modelSource: 'answered' | 'requested' | null;
}

/**
 * One forge call's record: the forge's id, when the call started, who wrote the request, the trace once a layer ended
 * the forge, and whether that trace has been delivered. The outermost layer that sees the call makes it, and every
 * layer inside reads it. forge_tool's `execute` sets `seen` in the same step that takes the record.
 *
 * @internal
 */
export interface ForgeCallRecord {
  readonly forgeId: string;
  /** When the call started, in epoch milliseconds. */
  readonly startedAt: number;
  author?: ForgeCallAuthor;
  trace?: ForgeTrace;
  delivered: boolean;
  seen: boolean;
}

/**
 * The record of the forge call an async chain belongs to. A layer that makes a record runs the call inside
 * `forgeCallScope.run(record, ...)`, and forge_tool reads it there, so a host subclass that hands `super.execute` a
 * copied or rebuilt context reaches the record of its own call all the same.
 *
 * @internal
 */
export const forgeCallScope: AsyncLocalStorage<ForgeCallRecord> = new AsyncLocalStorage<ForgeCallRecord>();

/**
 * forge_tool's hand-over to the engine: the call's record, keyed by the context object forge_tool builds and passes to
 * `forge`.
 *
 * @internal
 */
export const forgeContextRecords: WeakMap<object, ForgeCallRecord> = new WeakMap<object, ForgeCallRecord>();

/**
 * A new forge id: `forge_` followed by a random UUID.
 *
 * @internal
 */
export function mintForgeId(): string {
  return `forge_${randomUUID()}`;
}

/**
 * A new record for one forge call, started now, under `forgeId` or a newly minted id.
 *
 * @param forgeId - The forge's id, when the caller has one.
 * @returns The record, neither delivered nor seen.
 * @internal
 */
export function newForgeCallRecord(forgeId?: string): ForgeCallRecord {
  return { forgeId: forgeId ?? mintForgeId(), startedAt: Date.now(), delivered: false, seen: false };
}

// ============================================================================
// THE BUILDER
// ============================================================================

/**
 * What a layer knows when it ends a forge, which the builder turns into its trace.
 *
 * @internal
 */
export interface ForgeTraceInput {
  /** The call's record: the forge's id, when it started and who wrote the request come from it. */
  record: ForgeCallRecord;
  recordedBy: ForgeTrace['recordedBy'];
  via: ForgeTrace['via'];
  /** Where the forge ended. Its outcome follows from it. */
  stage: KnownForgeTraceStage;
  /** The refusal's, rejection's or error's text, or the thrown value; null when approved. */
  reason: unknown;
  /** The arguments as the layer received them. */
  args: unknown;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  /** `testRuns[i]` is test case i's run, in request order. */
  testRuns?: readonly ForgeTestRun[];
  /** When the test runs ended, in epoch milliseconds. */
  testsFinishedAt?: number;
  executor?: { name: string; isolates: boolean } | null;
  verdict?: CreationVerdict | null;
  /** When the judge's verdict came back, in epoch milliseconds. */
  verdictAt?: number;
  judgeDetail?: ForgeTraceJudgeDetail | null;
  /** The judge's model and provider, when a judge whose configuration AgentOS reads ran. */
  judge?: { model: string | null; providerId: string | null } | null;
  toolId?: string | null;
  /** When the forge ended, in epoch milliseconds; now when absent. */
  finishedAt?: number;
}

/** What a read returns when reading the property threw: a getter, a `Proxy` trap or a revoked `Proxy`. */
const UNREADABLE: unique symbol = Symbol('unreadable');

/** `source[key]`, read once; {@link UNREADABLE} when the read throws. */
function readKey(source: unknown, key: string | number): unknown {
  try {
    return (source as Record<string | number, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Whether a value is an array; false for a revoked `Proxy`, on which `Array.isArray` throws. */
function isList(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** A list's length, read once; 0 when the read throws or gives no whole number. */
function lengthOf(list: readonly unknown[]): number {
  const length = readKey(list, 'length');
  return typeof length === 'number' && Number.isInteger(length) && length > 0 ? length : 0;
}

/** The first `limit` entries of a list, each read once, {@link UNREADABLE} in the place of one whose read threw. */
function entriesOf(list: readonly unknown[], limit = Number.POSITIVE_INFINITY): unknown[] {
  const count = Math.min(lengthOf(list), limit);
  const entries: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push(readKey(list, index));
  }
  return entries;
}

/** A value field from a read: an `other` marker when the read threw, else {@link traceValue}. */
function readValue(read: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceValue | undefined {
  return read === UNREADABLE ? unserializable('other') : traceValue(read, capBytes, path, cut);
}

/** A text field from a read: the `other` marker's JSON text when the read threw, else {@link traceText}. */
function readText(read: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceText {
  return traceText(read === UNREADABLE ? unserializable('other') : read, capBytes, path, cut);
}

/** A text field that may be absent: null for null or undefined, else {@link readText}. */
function readTextOrNull(read: unknown, capBytes: number, path: string, cut: string[]): ForgeTraceText | null {
  return read === null || read === undefined ? null : readText(read, capBytes, path, cut);
}

/** A plain-string field: its start under the cap ({@link traceString}) when it is a string, else null. */
function readString(read: unknown, capBytes: number, path: string, cut: string[]): string | null {
  return typeof read === 'string' ? traceString(read, capBytes, path, cut) : null;
}

function readBoolean(read: unknown): boolean | null {
  return typeof read === 'boolean' ? read : null;
}

/** Sets `key` on `target` unless `value` is undefined, which JSON leaves out. */
function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** An epoch time in milliseconds as ISO 8601 UTC; the epoch itself for a time a `Date` cannot hold. */
function isoAt(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** The arguments' fields a trace reads, each read once, so a getter that answers differently each time is read once. */
interface ArgumentReads {
  name: unknown;
  description: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  implementation: unknown;
  mode: unknown;
  code: unknown;
  allowlist: unknown;
  steps: unknown;
  testCases: unknown;
  justification: unknown;
}

/** The fields of `args`, each read once; null when `args` is not an object. */
function readArguments(args: unknown): ArgumentReads | null {
  if (!isObject(args)) {
    return null;
  }
  const name = readKey(args, 'name');
  const description = readKey(args, 'description');
  const inputSchema = readKey(args, 'inputSchema');
  const outputSchema = readKey(args, 'outputSchema');
  const implementation = readKey(args, 'implementation');
  const mode = isObject(implementation) ? readKey(implementation, 'mode') : undefined;
  return {
    name,
    description,
    inputSchema,
    outputSchema,
    implementation,
    mode,
    code: mode === 'sandbox' ? readKey(implementation, 'code') : undefined,
    allowlist: mode === 'sandbox' ? readKey(implementation, 'allowlist') : undefined,
    steps: mode === 'compose' ? readKey(implementation, 'steps') : undefined,
    testCases: readKey(args, 'testCases'),
    justification: readKey(args, 'justification'),
  };
}

/**
 * The test cases, each read once, when the arguments have a request's shape: string `name` and `description`, an
 * object `inputSchema`, an absent or object `outputSchema`, a sandbox implementation with a string `code` and an
 * array `allowlist` or a compose implementation with an array `steps`, and a `testCases` array whose every entry is
 * an object. Null otherwise.
 */
function requestTestCases(reads: ArgumentReads | null): unknown[] | null {
  if (reads === null || typeof reads.name !== 'string' || typeof reads.description !== 'string') {
    return null;
  }
  if (!isObject(reads.inputSchema) || (reads.outputSchema !== undefined && !isObject(reads.outputSchema))) {
    return null;
  }
  if (reads.mode === 'sandbox') {
    if (typeof reads.code !== 'string' || !isList(reads.allowlist)) {
      return null;
    }
  } else if (reads.mode === 'compose') {
    if (!isList(reads.steps)) {
      return null;
    }
  } else {
    return null;
  }
  if (!isList(reads.testCases)) {
    return null;
  }
  const testCases = entriesOf(reads.testCases);
  return testCases.every(isObject) ? testCases : null;
}

/**
 * The request, and `codeBytes`: the UTF-8 length of the whole code, or of the steps' JSON text as the walk of the steps
 * measured it, null when that walk stopped before their end. The steps are walked once, for both.
 */
function buildRequest(reads: ArgumentReads, cut: string[]): { request: ForgeTraceRequest; codeBytes: number | null } {
  const request: Record<string, unknown> = {
    name: traceText(reads.name, FORGE_TRACE_CAPS.name, 'request.name', cut),
    description: traceText(reads.description, FORGE_TRACE_CAPS.description, 'request.description', cut),
    inputSchema: traceValue(reads.inputSchema, FORGE_TRACE_CAPS.schema, 'request.inputSchema', cut),
  };
  setField(request, 'outputSchema', traceValue(reads.outputSchema, FORGE_TRACE_CAPS.schema, 'request.outputSchema', cut));
  let codeBytes: number | null;
  if (reads.mode === 'sandbox') {
    request.implementation = {
      mode: 'sandbox',
      code: traceText(reads.code, FORGE_TRACE_CAPS.code, 'request.implementation.code', cut),
      allowlist: buildAllowlist(reads.allowlist as readonly unknown[], cut),
    };
    codeBytes = Buffer.byteLength(reads.code as string);
  } else {
    const steps = fieldValue(reads.steps, FORGE_TRACE_CAPS.code, 'request.implementation.steps', cut);
    request.implementation = { mode: 'compose', steps: steps.value };
    codeBytes = steps.bytes;
  }
  return { request: request as unknown as ForgeTraceRequest, codeBytes };
}

/** The first 64 allowlist entries, each capped; the list's own path is listed when it held more. */
function buildAllowlist(allowlist: readonly unknown[], cut: string[]): ForgeTraceText[] {
  if (lengthOf(allowlist) > FORGE_TRACE_CAPS.allowlistEntries) {
    cut.push('request.implementation.allowlist');
  }
  return entriesOf(allowlist, FORGE_TRACE_CAPS.allowlistEntries).map((entry, index) =>
    readText(entry, FORGE_TRACE_CAPS.allowlistEntry, `request.implementation.allowlist[${index}]`, cut),
  );
}

/** The first 16 test cases in request order; entry i ran when `runs` holds a run at i. */
function buildTests(testCases: readonly unknown[], runs: readonly unknown[], cut: string[]): ForgeTraceTest[] {
  const tests: ForgeTraceTest[] = [];
  const kept = Math.min(testCases.length, FORGE_TRACE_CAPS.tests);
  for (let index = 0; index < kept; index += 1) {
    const testCase = testCases[index];
    const prefix = `tests[${index}]`;
    const test: Record<string, unknown> = { index };
    setField(test, 'input', readValue(readKey(testCase, 'input'), FORGE_TRACE_CAPS.testField, `${prefix}.input`, cut));
    setField(
      test,
      'expectedOutput',
      readValue(readKey(testCase, 'expectedOutput'), FORGE_TRACE_CAPS.testField, `${prefix}.expectedOutput`, cut),
    );
    setField(
      test,
      'stepOutputs',
      readValue(readKey(testCase, 'stepOutputs'), FORGE_TRACE_CAPS.testField, `${prefix}.stepOutputs`, cut),
    );
    setField(
      test,
      'responses',
      readValue(readKey(testCase, 'responses'), FORGE_TRACE_CAPS.testField, `${prefix}.responses`, cut),
    );
    const ran = index < runs.length;
    test.ran = ran;
    if (ran) {
      test.result = buildRun(runs[index], prefix, cut);
    }
    tests.push(test as unknown as ForgeTraceTest);
  }
  return tests;
}

function buildRun(run: unknown, prefix: string, cut: string[]): ForgeTraceTestRun {
  const result: Record<string, unknown> = {};
  setField(result, 'output', readValue(readKey(run, 'output'), FORGE_TRACE_CAPS.testOutput, `${prefix}.result.output`, cut));
  result.success = readKey(run, 'success') === true;
  setField(result, 'error', readTextOrNull(readKey(run, 'error'), FORGE_TRACE_CAPS.text, `${prefix}.result.error`, cut) ?? undefined);
  setField(
    result,
    'effects',
    readValue(readKey(run, 'effects'), FORGE_TRACE_CAPS.testEffects, `${prefix}.result.effects`, cut),
  );
  return result as ForgeTraceTestRun;
}

function buildExecutor(executor: unknown, cut: string[]): ForgeTraceExecutor | null {
  if (!isObject(executor)) {
    return null;
  }
  const name = readKey(executor, 'name');
  return {
    name: traceString((name === UNREADABLE ? unserializable('other') : name) as string, FORGE_TRACE_CAPS.other, 'executor.name', cut),
    isolates: readKey(executor, 'isolates') === true,
  };
}

/** The verdict's scores and approval as given, each JSON-safe, and its reasoning capped. Other keys are left out. */
const VERDICT_SCORES = ['approved', 'confidence', 'safety', 'correctness', 'determinism', 'bounded'] as const;

function buildVerdict(verdict: unknown, cut: string[]): ForgeTraceVerdict | null {
  if (!isObject(verdict)) {
    return null;
  }
  const copy: Record<string, unknown> = {};
  for (const key of VERDICT_SCORES) {
    setField(copy, key, readValue(readKey(verdict, key), FORGE_TRACE_CAPS.other, `verdict.${key}`, cut));
  }
  copy.reasoning = readText(readKey(verdict, 'reasoning'), FORGE_TRACE_CAPS.verdictReasoning, 'verdict.reasoning', cut);
  return copy as unknown as ForgeTraceVerdict;
}

function buildJudgeDetail(detail: unknown, cut: string[]): ForgeTraceJudgeDetail | null {
  if (!isObject(detail)) {
    return null;
  }
  const judgeError = readKey(detail, 'judgeError');
  return {
    judgeModel: readString(readKey(detail, 'judgeModel'), FORGE_TRACE_CAPS.other, 'judgeDetail.judgeModel', cut),
    replyParsed: readKey(detail, 'replyParsed') === true,
    judgeError: judgeError === 'llm_call_failed' || judgeError === 'reply_unparsable' ? judgeError : null,
    judgeApproved: readBoolean(readKey(detail, 'judgeApproved')),
    safetyPassed: readBoolean(readKey(detail, 'safetyPassed')),
    safetyConcerns: buildConcerns(readKey(detail, 'safetyConcerns'), cut),
    correctnessPassed: readBoolean(readKey(detail, 'correctnessPassed')),
    failedTests: buildFailedTests(readKey(detail, 'failedTests'), cut),
    deterministic: readBoolean(readKey(detail, 'deterministic')),
    determinismReasoning: readTextOrNull(
      readKey(detail, 'determinismReasoning'),
      FORGE_TRACE_CAPS.judgeText,
      'judgeDetail.determinismReasoning',
      cut,
    ),
    bounded: readBoolean(readKey(detail, 'bounded')),
    boundedReasoning: readTextOrNull(readKey(detail, 'boundedReasoning'), FORGE_TRACE_CAPS.judgeText, 'judgeDetail.boundedReasoning', cut),
  };
}

/** The first 16 concerns, each cut at 1 KiB; the list's own path is listed when it held more. */
function buildConcerns(concerns: unknown, cut: string[]): ForgeTraceText[] {
  if (!isList(concerns)) {
    return [];
  }
  if (lengthOf(concerns) > FORGE_TRACE_CAPS.judgeConcerns) {
    cut.push('judgeDetail.safetyConcerns');
  }
  return entriesOf(concerns, FORGE_TRACE_CAPS.judgeConcerns).map((concern, index) =>
    readText(concern, FORGE_TRACE_CAPS.judgeText, `judgeDetail.safetyConcerns[${index}]`, cut),
  );
}

/** The first 64 finite numbers of the list, in order; the list's own path is listed when it held more. */
function buildFailedTests(failedTests: unknown, cut: string[]): number[] {
  if (!isList(failedTests)) {
    return [];
  }
  const numbers = entriesOf(failedTests).filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );
  if (numbers.length > FORGE_TRACE_CAPS.failedTests) {
    cut.push('judgeDetail.failedTests');
  }
  return numbers.slice(0, FORGE_TRACE_CAPS.failedTests);
}

/**
 * The author of the request (and of the justification): the record's author, or the direct caller with no model
 * named when the record has none.
 */
function requestAuthor(author: unknown, at: string, path: string, cut: string[]): ForgeTraceAuthor {
  if (!isObject(author)) {
    return { kind: 'caller', role: 'direct_caller', aiGenerated: null, provider: null, model: null, modelSource: null, at };
  }
  const kind = readKey(author, 'kind') === 'model' ? 'model' : 'caller';
  const modelSource = readKey(author, 'modelSource');
  return {
    kind,
    role: readKey(author, 'role') === 'forging_agent' ? 'forging_agent' : 'direct_caller',
    aiGenerated: kind === 'model' ? true : null,
    provider: readString(readKey(author, 'provider'), FORGE_TRACE_CAPS.other, `${path}.provider`, cut),
    model: readString(readKey(author, 'model'), FORGE_TRACE_CAPS.other, `${path}.model`, cut),
    modelSource: modelSource === 'answered' || modelSource === 'requested' ? modelSource : null,
    at,
  };
}

/** The author of the verdict: the judge's configured provider and model, as asked for, when AgentOS reads them. */
function judgeAuthor(judge: unknown, at: string, cut: string[]): ForgeTraceAuthor {
  const provider = isObject(judge) ? readKey(judge, 'providerId') : null;
  const model = isObject(judge) ? readKey(judge, 'model') : null;
  return {
    kind: 'model',
    role: 'judge',
    aiGenerated: true,
    provider: readString(provider, FORGE_TRACE_CAPS.other, 'provenance.verdict.provider', cut),
    model: readString(model, FORGE_TRACE_CAPS.other, 'provenance.verdict.model', cut),
    modelSource: typeof model === 'string' && model !== '' ? 'requested' : null,
    at,
  };
}

function executionAuthor(at: string): ForgeTraceAuthor {
  return { kind: 'execution', role: 'executor', aiGenerated: false, provider: null, model: null, modelSource: null, at };
}

/** The trace's reason: null when approved; a refusal's text capped; a thrown value as its JSON text when not a string. */
function reasonOf(stage: KnownForgeTraceStage, reason: unknown, cut: string[]): ForgeTraceText | null {
  if (stage === 'approved' || ((reason === null || reason === undefined) && stage !== 'thrown')) {
    return null;
  }
  return traceText(reason, FORGE_TRACE_CAPS.text, 'reason', cut);
}

/** Freezes `value` and every object and array inside it. A trace holds only its own copies, never a caller's object. */
function deepFreeze<T>(value: T): T {
  if (isObject(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Each trace's justification length as it arrived, for its log line; never a field of the trace. */
const JUSTIFICATION_CHARS = new WeakMap<ForgeTrace, number>();

/**
 * Builds a forge's trace: JSON-safe, every field under its cap, sized and deep-frozen. The request is filled when the
 * arguments have a request's shape (and the stage is not `schema_check`); otherwise `rawArguments` holds the
 * arguments' copy and `tests` is empty. Never throws: a field it cannot read becomes an `other` marker.
 *
 * @param input - What the layer that ended the forge knows.
 * @returns The trace.
 * @internal
 */
export function buildForgeTrace(input: ForgeTraceInput): ForgeTrace {
  const cut: string[] = [];
  const { record, stage } = input;
  const finishedMs = finiteOr(input.finishedAt, Date.now());
  const startedMs = finiteOr(record.startedAt, finishedMs);
  const startedAt = isoAt(startedMs);
  const reads = readArguments(input.args);
  const testCases = stage === 'schema_check' ? null : requestTestCases(reads);
  const runs = isList(input.testRuns) ? entriesOf(input.testRuns) : [];

  const forgeId = traceString(record.forgeId, FORGE_TRACE_CAPS.other, 'forgeId', cut);
  const agentId = readString(input.agentId, FORGE_TRACE_CAPS.other, 'agentId', cut);
  const sessionId = readString(input.sessionId, FORGE_TRACE_CAPS.other, 'sessionId', cut);
  const correlationId = readString(input.correlationId, FORGE_TRACE_CAPS.other, 'correlationId', cut);
  const toolName =
    reads !== null && typeof reads.name === 'string' ? traceText(reads.name, FORGE_TRACE_CAPS.name, 'toolName', cut) : null;
  const mode = reads !== null && (reads.mode === 'sandbox' || reads.mode === 'compose') ? reads.mode : null;
  const reason = reasonOf(stage, input.reason, cut);
  const built = testCases === null || reads === null ? null : buildRequest(reads, cut);
  const request = built === null ? null : built.request;
  const rawArguments =
    request === null ? traceValue(input.args, FORGE_TRACE_CAPS.rawArguments, 'rawArguments', cut) : undefined;
  const justificationRead = reads === null ? undefined : reads.justification;
  // An explicit null is a value the request carried, kept as its JSON text; only an absent key is no justification.
  const justification =
    justificationRead === undefined ? null : readText(justificationRead, FORGE_TRACE_CAPS.justification, 'justification', cut);
  const tests = testCases === null ? [] : buildTests(testCases, runs, cut);
  const executor = buildExecutor(input.executor, cut);
  const verdict = buildVerdict(input.verdict, cut);
  const judgeDetail = buildJudgeDetail(input.judgeDetail, cut);
  const toolId = readString(input.toolId, FORGE_TRACE_CAPS.other, 'toolId', cut);
  const provenance: ForgeTraceProvenance = {
    provenanceVersion: 1,
    request: requestAuthor(record.author, startedAt, 'provenance.request', cut),
    justification:
      justification === null ? null : requestAuthor(record.author, startedAt, 'provenance.justification', cut),
    verdict: verdict === null ? null : judgeAuthor(input.judge, isoAt(finiteOr(input.verdictAt, finishedMs)), cut),
    testResults: runs.length > 0 ? executionAuthor(isoAt(finiteOr(input.testsFinishedAt, finishedMs))) : null,
  };
  const duration = Math.round(finishedMs - startedMs);
  const sizes = {
    traceBytes: 0,
    codeBytes: built === null ? null : built.codeBytes,
    cut,
    testsOmitted: request === null || testCases === null ? 0 : Math.max(0, testCases.length - FORGE_TRACE_CAPS.tests),
  };
  const trace = {
    traceVersion: FORGE_TRACE_VERSION as typeof FORGE_TRACE_VERSION,
    forgeId,
    recordedBy: input.recordedBy,
    via: input.via,
    agentId,
    sessionId,
    correlationId,
    toolName,
    mode,
    outcome: STAGE_OUTCOME[stage] ?? 'failed',
    stage,
    reason,
    startedAt,
    finishedAt: isoAt(finishedMs),
    durationMs: Number.isFinite(duration) ? duration : 0,
    request,
    ...(rawArguments === undefined ? {} : { rawArguments }),
    justification,
    tests,
    executor,
    verdict,
    judgeDetail,
    toolId,
    provenance,
    sizes,
  } satisfies ForgeTrace;

  // traceBytes is the length of the trace's own JSON, its own digits included: measured with a placeholder, then again
  // with each measured figure until the figure holds, which takes at most three rounds.
  let measured = Buffer.byteLength(JSON.stringify(trace));
  for (let round = 0; round < 3 && measured !== sizes.traceBytes; round += 1) {
    sizes.traceBytes = measured;
    measured = Buffer.byteLength(JSON.stringify(trace));
  }

  const frozen = deepFreeze(trace) as ForgeTrace;
  JUSTIFICATION_CHARS.set(frozen, typeof justificationRead === 'string' ? justificationRead.length : 0);
  return frozen;
}

/**
 * The `reason` of a `thrown` trace: the error's `message` when it is an `Error` whose `message` reads as a string,
 * else the thrown value itself, which the builder writes as its JSON text (`Object.create(null)` gives `'{}'`). Never
 * throws, so the layer that caught the value rethrows the same value.
 *
 * @param error - The thrown value.
 * @returns The message, or the value.
 * @internal
 */
export function thrownReason(error: unknown): unknown {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string') {
        return message;
      }
    }
  } catch {
    // A `message` getter or a `Proxy` that throws: the value itself is the reason.
  }
  return error;
}

// ============================================================================
// DELIVERY
// ============================================================================

/**
 * A host's handler for every forge's trace.
 *
 * @internal
 */
export type ForgeTraceHook = (trace: ForgeTrace) => void | Promise<void>;

/**
 * The key of the package-internal delivery method on `EmergentCapabilityEngine` and `ForgeToolMetaTool`.
 *
 * @internal
 */
export const FORGE_TRACE_DELIVER: unique symbol = Symbol('agentos.emergent.forgeTraceDeliver');

const forgeLog = moduleLogger('emergent', 'library');

/** How the wait for a hook ended: it settled, it threw or rejected, or the bound came first. */
type HookEnd = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly error: unknown } | { readonly kind: 'slow' };

/** Writes `emergent.forge_done`: ints, words and enums alone, at info for an approved forge and warn for the rest. */
function writeForgeDone(trace: ForgeTrace): void {
  try {
    const fields = {
      outcome: trace.outcome,
      stage: trace.stage as KnownForgeTraceStage,
      recordedBy: trace.recordedBy,
      via: trace.via,
      mode: trace.mode ?? 'none',
      tests: trace.tests.length,
      testsPassed: trace.tests.filter((test) => test.result?.success === true).length,
      testsOmitted: trace.sizes.testsOmitted,
      ...(trace.sizes.codeBytes === null ? {} : { codeBytes: trace.sizes.codeBytes }),
      traceBytes: trace.sizes.traceBytes,
      cutFields: trace.sizes.cut.length,
      justificationChars: JUSTIFICATION_CHARS.get(trace) ?? 0,
      judgeRan: trace.verdict === null ? 'no' : 'yes',
      executorIsolates: trace.executor === null ? 'none' : trace.executor.isolates ? 'yes' : 'no',
      durationMs: trace.durationMs,
    } as const;
    if (trace.outcome === 'approved') {
      forgeLog.info('emergent.forge_done', fields);
    } else {
      forgeLog.warn('emergent.forge_done', fields);
    }
  } catch {
    // A line that cannot be written (a refused field under NODE_ENV=test) never keeps the trace from the hook.
  }
}

function writeHookFailed(error: unknown): void {
  try {
    forgeLog.warn('emergent.forge_trace_hook_failed', listedErrorFields(error));
  } catch {
    // The hook's failure is the forge's last step: a line that cannot be written changes nothing.
  }
}

function writeHookSlow(): void {
  try {
    forgeLog.warn('emergent.forge_trace_hook_slow', { boundMs: FORGE_TRACE_HOOK_BOUND_MS });
  } catch {
    // As above: the forge goes on.
  }
}

/** Calls the hook, and waits for it up to the bound. A throw, a rejection or the bound writes its line. */
async function awaitHook(trace: ForgeTrace, hook: ForgeTraceHook): Promise<void> {
  let running: Promise<void>;
  try {
    running = Promise.resolve(hook(trace));
  } catch (error) {
    writeHookFailed(error);
    return;
  }
  // The rejection handler is attached now, so a hook that rejects after the bound is caught here and writes nothing.
  const settled: Promise<HookEnd> = running.then(
    (): HookEnd => ({ kind: 'done' }),
    (error: unknown): HookEnd => ({ kind: 'failed', error }),
  );
  // The timer keeps its hold on the process: a lone script that awaits a forge returns at the bound at the latest.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<HookEnd>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'slow' }), FORGE_TRACE_HOOK_BOUND_MS);
  });
  const first = await Promise.race([settled, bound]);
  clearTimeout(timer);
  if (first.kind === 'slow') {
    writeHookSlow();
  } else if (first.kind === 'failed') {
    writeHookFailed(first.error);
  }
}

/**
 * Delivers a forge's trace: writes `emergent.forge_done`, then calls the hook, when one is set, and waits for the
 * promise it returns up to {@link FORGE_TRACE_HOOK_BOUND_MS}. The hook's synchronous work runs before that wait, to its
 * end. A hook that throws or rejects writes `emergent.forge_trace_hook_failed`; one
 * running at the bound writes `emergent.forge_trace_hook_slow` and is left running. Never throws.
 *
 * @param trace - The forge's trace.
 * @param hook - The host's handler, when it set one.
 * @internal
 */
export async function deliverForgeTrace(trace: ForgeTrace, hook: ForgeTraceHook | undefined): Promise<void> {
  writeForgeDone(trace);
  if (typeof hook !== 'function') {
    return;
  }
  try {
    await awaitHook(trace, hook);
  } catch {
    // awaitHook settles every path itself; nothing a hook does reaches the forge.
  }
}

/**
 * Settles a forge call's trace on its record: keeps the first trace a layer set, and delivers it once. Sets
 * `record.trace` when it is unset; when the record has not been delivered, marks it delivered and awaits
 * `deliver(record.trace)`. Both are set before the first await, so a second settle on the same record delivers
 * nothing. A `deliver` that throws changes nothing.
 *
 * @param record - The call's record.
 * @param trace - The trace this layer built or was handed.
 * @param deliver - The engine's delivery method, when the layer reaches one.
 * @returns The record's trace: the first one set.
 * @internal
 */
export async function settleForgeTrace(
  record: ForgeCallRecord,
  trace: ForgeTrace,
  deliver: ((trace: ForgeTrace) => Promise<void>) | undefined,
): Promise<ForgeTrace> {
  if (record.trace === undefined) {
    record.trace = trace;
  }
  const kept = record.trace;
  if (!record.delivered) {
    record.delivered = true;
    if (deliver !== undefined) {
      try {
        await deliver(kept);
      } catch {
        // A delivery that throws never changes the forge's result.
      }
    }
  }
  return kept;
}
