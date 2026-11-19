/**
 * @fileoverview Unit tests of the forge trace's JSON-safe copy and its cuts (each field's JSON within its cap, escaping
 * included, a cut that ends on a whole character, a marker in the place of each value JSON cannot write) and of its
 * builder, its per-call record and its delivery (the request's shape, the tests, provenance, the judge's detail, the
 * total, the freeze, hostile arguments, one delivery per record, and the hook's bound).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildForgeTrace,
  deliverForgeTrace,
  FORGE_TRACE_HOOK_BOUND_MS,
  FORGE_TRACE_STAGES,
  jsonSafeCopy,
  mintForgeId,
  newForgeCallRecord,
  settleForgeTrace,
  thrownReason,
  traceString,
  traceText,
  traceValue,
  type ForgeCallRecord,
  type ForgeTrace,
  type ForgeTraceCut,
  type ForgeTraceInput,
  type ForgeTraceJudgeDetail,
  type ForgeTraceVerdict,
  type KnownForgeTraceStage,
} from '../ForgeTrace.js';
import type { CreationVerdict, ForgeTestRun } from '../types.js';
import { AGENTOS_EVENTS, valid } from '../../../core/logging/events.js';
import { LogValidationError } from '../../../core/logging/forward.js';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';
import type { Logger } from '../../../core/logging/Logger.js';

/** The UTF-8 length of `value`'s JSON text. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The character of `text` that starts at `index`: a whole surrogate pair, or one unit. */
function characterAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index)!);
}

/** `start` is a start of `text` that does not end between the two halves of a surrogate pair. */
function expectWholeCharacterStart(text: string, start: string): void {
  expect(text.startsWith(start)).toBe(true);
  const end = start.length;
  const splitsAPair = end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
  expect(splitsAPair).toBe(false);
}

/**
 * `result` is the cut of `text` at `capBytes`: the whole text's UTF-8 length, its own JSON within the cap, and the
 * longest whole-character start that fits (one more character would not).
 */
function expectCutOf(text: string, capBytes: number, result: unknown): ForgeTraceCut {
  expect(result).toMatchObject({ $trace: 'cut' });
  const cut = result as ForgeTraceCut;
  expect(cut.bytes).toBe(Buffer.byteLength(text));
  expect(jsonBytes(cut)).toBeLessThanOrEqual(capBytes);
  expectWholeCharacterStart(text, cut.head);
  expect(jsonBytes({ ...cut, head: cut.head + characterAt(text, cut.head.length) })).toBeGreaterThan(capBytes);
  return cut;
}

const OTHER = { $trace: 'unserializable', kind: 'other' };

describe('forge trace: the copy and the cuts', () => {
  it('a text within its cap is kept whole', () => {
    const cut: string[] = [];
    expect(traceText('add_numbers', 256, 'toolName', cut)).toBe('add_numbers');
    // A text whose JSON, quotes included, is exactly the cap is kept: 254 ASCII letters, and 127 two-byte letters.
    expect(traceText('a'.repeat(254), 256, 'toolName', cut)).toBe('a'.repeat(254));
    expect(traceText('é'.repeat(127), 256, 'toolName', cut)).toBe('é'.repeat(127));
    // A value that is not a string is kept as its JSON text.
    expect(traceText({ code: 'E1', retry: false }, 256, 'reason', cut)).toBe('{"code":"E1","retry":false}');
    expect(traceText(42, 256, 'reason', cut)).toBe('42');
    expect(cut).toEqual([]);

    // One byte more is cut.
    expect(traceText('a'.repeat(255), 256, 'toolName', cut)).toMatchObject({ $trace: 'cut', bytes: 255 });
    expect(cut).toEqual(['toolName']);
  });

  it('a text over its cap keeps a whole-character head whose JSON fits the cap', () => {
    const texts = {
      ascii: 'a'.repeat(1000),
      emoji: 'ab' + '\u{1F600}'.repeat(300),
      cjk: '漢字かな'.repeat(200),
      loneSurrogates: 'x\ud800y\udc00z\ud800\u{1F600}'.repeat(80),
    };
    for (const [label, text] of Object.entries(texts)) {
      const cut: string[] = [];
      const result = traceText(text, 256, `texts.${label}`, cut);
      const marker = expectCutOf(text, 256, result);
      expect(marker.head.length).toBeGreaterThan(0);
      expect(cut).toEqual([`texts.${label}`]);
    }

    // In the emoji text the cap falls across a 4-byte character: the head stops before it, never inside it.
    const emoji = traceText(texts.emoji, 256, 'emoji', []) as ForgeTraceCut;
    expect(isHighSurrogate(texts.emoji.charCodeAt(emoji.head.length))).toBe(true);
    expect(isLowSurrogate(emoji.head.charCodeAt(emoji.head.length - 1))).toBe(true);
  });

  it('escaping counts toward the cap', () => {
    const text = '"\\\u0001'.repeat(5000);
    const cut: string[] = [];
    const result = traceText(text, 1024, 'reason', cut);
    expectCutOf(text, 1024, result);
    expect(cut).toEqual(['reason']);

    // A value's JSON holds the escapes once, and the cut's JSON escapes its head again: the cut fits all the same.
    const value = { text };
    const valueCut = traceValue(value, 1024, 'tests[0].input', cut);
    expectCutOf(JSON.stringify(value), 1024, valueCut);
    expect(cut).toEqual(['reason', 'tests[0].input']);
  });

  it('a value over its cap becomes a cut of its JSON text', () => {
    const value = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, label: `item ${i} ✓` })) };
    const json = JSON.stringify(value);
    const cut: string[] = [];
    const result = expectCutOf(json, 512, traceValue(value, 512, 'tests[0].input', cut));
    expect(result.bytes).toBe(Buffer.byteLength(json));
    expect(json.startsWith(result.head)).toBe(true);
    expect(cut).toEqual(['tests[0].input']);

    // The JSON text cut is the copy's, markers included.
    const odd = { big: 10n, pad: 'p'.repeat(600) };
    const oddJson = JSON.stringify(jsonSafeCopy(odd));
    const oddCut = expectCutOf(oddJson, 256, traceValue(odd, 256, 'tests[1].result.output', cut));
    expect(oddCut.head.startsWith('{"big":{"$trace":"unserializable","kind":"bigint"},"pad":"ppp')).toBe(true);

    // A value within its cap is its copy: equal, not the same object. undefined stays undefined.
    const small = { a: [1, 'two', null] };
    const kept = traceValue(small, 512, 'request.inputSchema', cut);
    expect(kept).toEqual(small);
    expect(kept).not.toBe(small);
    expect(traceValue(undefined, 512, 'request.outputSchema', cut)).toBeUndefined();
    expect(cut).toEqual(['tests[0].input', 'tests[1].result.output']);
  });

  it('values that cannot be written as JSON become markers in place', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const shared = { v: 1 };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    const copy = jsonSafeCopy({
      big: 10n,
      cyclic,
      fn: () => 1,
      sym: Symbol('s'),
      throwing: {
        ok: 1,
        get bad(): number {
          throw new Error('getter');
        },
      },
      badToJSON: {
        toJSON(): never {
          throw new Error('toJSON');
        },
      },
      proxy: new Proxy({ a: 1 }, {
        get(): never {
          throw new Error('get');
        },
      }),
      revoked,
      keyed: { toJSON: (key: string) => `key:${key}` },
      absent: undefined,
      list: [undefined, NaN, Infinity, -Infinity, 1, () => 2],
      when: new Date(Date.UTC(2026, 10, 18)),
      boxed: [new Number(3), new String('s'), new Boolean(false)],
      sharedTwice: { a: shared, b: [shared] },
    });

    expect(copy).toEqual({
      big: { $trace: 'unserializable', kind: 'bigint' },
      cyclic: { name: 'root', self: { $trace: 'unserializable', kind: 'cycle' } },
      fn: { $trace: 'unserializable', kind: 'function' },
      sym: { $trace: 'unserializable', kind: 'symbol' },
      throwing: { ok: 1, bad: OTHER },
      badToJSON: OTHER,
      proxy: OTHER,
      revoked: OTHER,
      keyed: 'key:keyed',
      list: [null, null, null, null, 1, { $trace: 'unserializable', kind: 'function' }],
      when: '2026-11-18T00:00:00.000Z',
      boxed: [3, 's', false],
      sharedTwice: { a: { v: 1 }, b: [{ v: 1 }] },
    });
    expect('absent' in (copy as object)).toBe(false);

    // A value that is itself one of these is its marker; undefined is undefined.
    expect(jsonSafeCopy(10n)).toEqual({ $trace: 'unserializable', kind: 'bigint' });
    expect(jsonSafeCopy(() => 1)).toEqual({ $trace: 'unserializable', kind: 'function' });
    expect(jsonSafeCopy(undefined)).toBeUndefined();

    // A key named __proto__ stays a key of the copy and changes no prototype.
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const protoCopy = jsonSafeCopy(parsed) as Record<string, unknown>;
    expect(Object.keys(protoCopy)).toEqual(['__proto__', 'x']);
    expect(Object.getPrototypeOf(protoCopy)).toBe(Object.prototype);
    expect(JSON.stringify(protoCopy)).toBe('{"__proto__":{"polluted":true},"x":1}');

    // A value nested 10,000 levels deep is copied without running out of stack: past 256 levels it is a marker.
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 10_000; level += 1) {
      deep = { a: deep };
    }
    const deepCopy = jsonSafeCopy(deep);
    expect(() => JSON.stringify(deepCopy)).not.toThrow();
    let node: unknown = deepCopy;
    for (let level = 0; level < 256; level += 1) {
      node = (node as { a: unknown }).a;
    }
    expect(node).toEqual(OTHER);
  });

  it('each cut pushes its path, and a field within its cap pushes none', () => {
    const cut: string[] = [];
    traceText('short', 256, 'request.name', cut);
    traceValue({ type: 'object' }, 256, 'request.inputSchema', cut);
    traceString('forge_1', 256, 'forgeId', cut);
    traceValue(undefined, 256, 'request.outputSchema', cut);
    expect(cut).toEqual([]);

    traceText('x'.repeat(300), 256, 'request.name', cut);
    traceValue({ type: 'object', description: 'y'.repeat(300) }, 256, 'request.inputSchema', cut);
    traceString('z'.repeat(300), 256, 'agentId', cut);
    traceText({ message: 'w'.repeat(300) }, 256, 'reason', cut);
    expect(cut).toEqual(['request.name', 'request.inputSchema', 'agentId', 'reason']);
  });

  it('a plain string over its cap keeps a whole-character start and lists its path', () => {
    const cut: string[] = [];
    expect(traceString('session-1', 256, 'sessionId', cut)).toBe('session-1');
    expect(cut).toEqual([]);

    const text = 'id-' + '\u{1F600}'.repeat(200);
    const start = traceString(text, 256, 'sessionId', cut);
    expectWholeCharacterStart(text, start);
    expect(jsonBytes(start)).toBeLessThanOrEqual(256);
    expect(jsonBytes(start + characterAt(text, start.length))).toBeGreaterThan(256);
    expect(cut).toEqual(['sessionId']);

    // A 1 MiB string keeps the same start a short one over the cap keeps.
    expect(traceString('n'.repeat(1 << 20), 256, 'forgeId', cut)).toBe('n'.repeat(254));
    expect(cut).toEqual(['sessionId', 'forgeId']);
  });
});

// ----------------------------------------------------------------------------
// The builder, the per-call record and the delivery
// ----------------------------------------------------------------------------

const KIB = 1024;
const ADD_CODE = 'function execute(input) { return { sum: input.a + input.b }; }';
/** 18 Nov 2026, 00:00 UTC. */
const T0 = Date.UTC(2026, 10, 18);

/** F1: a code forge that adds two numbers, with one test case. */
function f1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
    implementation: { mode: 'sandbox', code: ADD_CODE, allowlist: [] },
    testCases: [{ input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } }],
    ...overrides,
  };
}

function recordAt(startedAt: number, author?: ForgeCallRecord['author']): ForgeCallRecord {
  return { forgeId: 'forge_test', startedAt, ...(author ? { author } : {}), delivered: false, seen: false };
}

/** A code-validation refusal of F1 on a direct call, with `overrides` over it. */
function inputOf(overrides: Partial<ForgeTraceInput> = {}): ForgeTraceInput {
  return {
    record: recordAt(T0),
    recordedBy: 'engine',
    via: 'direct',
    stage: 'code_validation',
    reason: 'Code validation failed: eval',
    args: f1(),
    agentId: 'agent-1',
    sessionId: null,
    correlationId: 'turn-1',
    finishedAt: T0 + 40,
    ...overrides,
  };
}

const REJECTION: CreationVerdict = {
  approved: false,
  confidence: 0.2,
  safety: 0,
  correctness: 1,
  determinism: 0.5,
  bounded: 1,
  reasoning: 'Tool contains unsafe patterns.',
};

const PASSING_RUN: ForgeTestRun = { input: { a: 2, b: 3 }, output: { sum: 5 }, success: true };

/** A reply's detail as the class's judge keeps it, before the builder's caps. */
function judgeDetail(overrides: Partial<ForgeTraceJudgeDetail> = {}): ForgeTraceJudgeDetail {
  return {
    judgeModel: 'judge-model',
    replyParsed: true,
    judgeError: null,
    judgeApproved: false,
    safetyPassed: false,
    safetyConcerns: ['Reads the clock.'],
    correctnessPassed: true,
    failedTests: [],
    deterministic: false,
    determinismReasoning: 'Uses Date.',
    bounded: true,
    boundedReasoning: 'One loop.',
    ...overrides,
  };
}

const OUTCOMES: Record<KnownForgeTraceStage, string> = {
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
};

/** A pino-shaped logger that keeps every line it is handed, set as AgentOS's logger. */
function recordLines(): Array<{ level: string; line: Record<string, unknown> }> {
  const lines: Array<{ level: string; line: Record<string, unknown> }> = [];
  const at = (level: string) => (line: Record<string, unknown>) => {
    lines.push({ level, line });
  };
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (): unknown => logger,
  };
  setLogger(logger as unknown as Logger);
  return lines;
}

/** Every object and array inside `value`, `value` included. */
function containers(value: unknown, into: object[] = []): object[] {
  if (typeof value === 'object' && value !== null) {
    into.push(value);
    for (const child of Object.values(value)) {
      containers(child, into);
    }
  }
  return into;
}

describe('forge trace: the builder, the record and the delivery', () => {
  afterEach(() => {
    resetLoggerFactory();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('a well-formed request fills request and tests; other arguments fill rawArguments', () => {
    const args = f1();
    const trace = buildForgeTrace(inputOf({ args }));
    expect(trace.request).toEqual({
      name: 'add_numbers',
      description: 'Add two numbers.',
      inputSchema: args.inputSchema,
      outputSchema: args.outputSchema,
      implementation: { mode: 'sandbox', code: ADD_CODE, allowlist: [] },
    });
    expect('rawArguments' in trace).toBe(false);
    expect(trace.tests).toEqual([{ index: 0, input: { a: 2, b: 3 }, expectedOutput: { sum: 5 }, ran: false }]);
    expect(trace.toolName).toBe('add_numbers');
    expect(trace.mode).toBe('sandbox');
    expect(trace.sizes.codeBytes).toBe(Buffer.byteLength(ADD_CODE));

    const withoutTests = f1();
    delete withoutTests.testCases;
    const others: Array<[string, unknown]> = [
      ['a string', '{"name":1}'],
      ['an unknown mode', f1({ implementation: { mode: 'python', code: 'print(1)', allowlist: [] } })],
      ['no test cases', withoutTests],
      ['a test case that is not an object', f1({ testCases: [null] })],
    ];
    for (const [label, other] of others) {
      const refused = buildForgeTrace(inputOf({ args: other }));
      expect(refused.request, label).toBeNull();
      expect(refused.tests, label).toEqual([]);
      expect(refused.rawArguments, label).toEqual(other);
      expect(refused.sizes.codeBytes, label).toBeNull();
    }
    expect(buildForgeTrace(inputOf({ args: '{"name":1}' })).toolName).toBeNull();
    expect(buildForgeTrace(inputOf({ args: others[1][1] })).mode).toBeNull();

    // No outputSchema: the request is filled and holds no outputSchema key.
    const withoutOutput = f1();
    delete withoutOutput.outputSchema;
    const open = buildForgeTrace(inputOf({ args: withoutOutput }));
    expect(open.request).not.toBeNull();
    expect(Object.keys(open.request!)).toEqual(['name', 'description', 'inputSchema', 'implementation']);

    // A composition's steps are kept as a value, and its codeBytes is their JSON's length.
    const steps = [{ name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } }];
    const composed = buildForgeTrace(inputOf({ args: f1({ implementation: { mode: 'compose', steps } }) }));
    expect(composed.request!.implementation).toEqual({ mode: 'compose', steps });
    expect(composed.sizes.codeBytes).toBe(Buffer.byteLength(JSON.stringify(steps)));

    // At schema_check the arguments are rawArguments whatever their shape.
    const schema = buildForgeTrace(inputOf({ stage: 'schema_check', args: f1() }));
    expect(schema.request).toBeNull();
    expect(schema.tests).toEqual([]);
    expect(schema.rawArguments).toEqual(f1());
    expect(schema.toolName).toBe('add_numbers');
    expect(schema.sizes.testsOmitted).toBe(0);
  });

  it('the outcome follows the stage, and the reason is cut at 4 KiB', () => {
    expect(Object.keys(OUTCOMES)).toEqual([...FORGE_TRACE_STAGES]);
    for (const stage of FORGE_TRACE_STAGES) {
      const trace = buildForgeTrace(inputOf({ stage, reason: `ended at ${stage}` }));
      expect(trace.stage).toBe(stage);
      expect(trace.outcome, stage).toBe(OUTCOMES[stage]);
      // An approved forge has no reason, whatever the layer passed.
      expect(trace.reason).toBe(stage === 'approved' ? null : `ended at ${stage}`);
    }

    const long = 'r'.repeat(5 * KIB);
    const cut = buildForgeTrace(inputOf({ reason: long }));
    expect(cut.reason).toMatchObject({ $trace: 'cut', bytes: 5 * KIB });
    expect(jsonBytes(cut.reason)).toBeLessThanOrEqual(4 * KIB);
    expect(long.startsWith((cut.reason as ForgeTraceCut).head)).toBe(true);
    expect(cut.sizes.cut).toEqual(['reason']);

    // A thrown value that is not a string is its JSON text; a refusal with no text has none.
    expect(buildForgeTrace(inputOf({ stage: 'thrown', reason: { code: 'E1' } })).reason).toBe('{"code":"E1"}');
    expect(buildForgeTrace(inputOf({ stage: 'thrown', reason: undefined })).reason).toBe('undefined');
    expect(buildForgeTrace(inputOf({ reason: null })).reason).toBeNull();
  });

  it('tests keep the first 16 in order, ran and result follow testRuns, and the rest are counted', () => {
    const testCases = Array.from({ length: 20 }, (_, i) => ({ input: { a: i, b: 1 }, expectedOutput: { sum: i + 1 } }));
    testCases[0] = { ...testCases[0], stepOutputs: { say: { text: 'hi' } }, responses: [{ method: 'POST', url: 'items', status: 201 }] } as (typeof testCases)[number];
    const testRuns: ForgeTestRun[] = [
      { input: { a: 0, b: 1 }, output: { sum: 1 }, success: true },
      { input: { a: 1, b: 1 }, output: undefined, success: false, error: 'boom' },
      { input: { a: 2, b: 1 }, output: { sum: 3 }, success: true, effects: [{ capability: 'fs.read' }] },
    ];
    const trace = buildForgeTrace(inputOf({ stage: 'judge_rejected', args: f1({ testCases }), testRuns }));

    expect(trace.tests).toHaveLength(16);
    expect(trace.sizes.testsOmitted).toBe(4);
    for (const [index, test] of trace.tests.entries()) {
      expect(test.index).toBe(index);
      expect(test.input).toEqual({ a: index, b: 1 });
      expect(test.expectedOutput).toEqual({ sum: index + 1 });
      expect(test.ran).toBe(index < 3);
      expect('result' in test).toBe(index < 3);
    }
    expect(trace.tests[0]).toMatchObject({
      stepOutputs: { say: { text: 'hi' } },
      responses: [{ method: 'POST', url: 'items', status: 201 }],
    });
    expect('stepOutputs' in trace.tests[1]).toBe(false);
    expect(trace.tests[0].result).toEqual({ output: { sum: 1 }, success: true });
    expect(trace.tests[1].result).toEqual({ success: false, error: 'boom' });
    expect('output' in trace.tests[1].result!).toBe(false);
    expect(trace.tests[2].result).toEqual({ output: { sum: 3 }, success: true, effects: [{ capability: 'fs.read' }] });
    expect(trace.sizes.cut).toEqual([]);
  });

  it("provenance follows the record's author, the judge and the test runs", () => {
    const at = (ms: number) => new Date(ms).toISOString();

    // No author on the record: the direct caller, who is never guessed to be a model. No justification, judge or run.
    const direct = buildForgeTrace(inputOf());
    expect(direct.provenance).toEqual({
      provenanceVersion: 1,
      request: { kind: 'caller', role: 'direct_caller', aiGenerated: null, provider: null, model: null, modelSource: null, at: at(T0) },
      justification: null,
      verdict: null,
      testResults: null,
    });
    expect(direct.justification).toBeNull();
    expect(direct.startedAt).toBe(at(T0));
    expect(direct.finishedAt).toBe(at(T0 + 40));
    expect(direct.durationMs).toBe(40);

    // A forging agent whose answering model is known, a justification, the class's judge and one run.
    const author = { kind: 'model', role: 'forging_agent', provider: 'openai', model: 'gpt-x', modelSource: 'answered' } as const;
    const judged = buildForgeTrace(
      inputOf({
        record: recordAt(T0, author),
        via: 'forge_tool',
        stage: 'judge_rejected',
        reason: REJECTION.reasoning,
        args: f1({ justification: 'Fills a gap.' }),
        testRuns: [PASSING_RUN],
        testsFinishedAt: T0 + 10,
        verdict: REJECTION,
        verdictAt: T0 + 30,
        judge: { model: 'judge-model', providerId: 'judge-provider' },
      }),
    );
    const forgingAgent = { ...author, aiGenerated: true, at: at(T0) };
    expect(judged.provenance).toEqual({
      provenanceVersion: 1,
      request: forgingAgent,
      justification: forgingAgent,
      verdict: {
        kind: 'model',
        role: 'judge',
        aiGenerated: true,
        provider: 'judge-provider',
        model: 'judge-model',
        modelSource: 'requested',
        at: at(T0 + 30),
      },
      testResults: { kind: 'execution', role: 'executor', aiGenerated: false, provider: null, model: null, modelSource: null, at: at(T0 + 10) },
    });
    expect(judged.justification).toBe('Fills a gap.');
    expect(judged.verdict).toEqual(REJECTION);

    // A host's judge override: a verdict whose author names no provider or model.
    const overridden = buildForgeTrace(inputOf({ stage: 'judge_rejected', reason: 'no', verdict: REJECTION, judge: null }));
    expect(overridden.provenance.verdict).toMatchObject({ kind: 'model', role: 'judge', aiGenerated: true, provider: null, model: null, modelSource: null });
    expect(overridden.provenance.testResults).toBeNull();

    // A justification that is not a string is its JSON text, and is the request author's.
    const objectJustification = buildForgeTrace(inputOf({ args: f1({ justification: { gap: 'sensor data' } }) }));
    expect(objectJustification.justification).toBe('{"gap":"sensor data"}');
    expect(objectJustification.provenance.justification).toEqual(objectJustification.provenance.request);
    // An explicit null is a value the request carried: its JSON text, the request author's. Only an absent key is none.
    const nullJustification = buildForgeTrace(inputOf({ record: recordAt(T0, author), args: f1({ justification: null }) }));
    expect(nullJustification.justification).toBe('null');
    expect(nullJustification.provenance.justification).toEqual(nullJustification.provenance.request);
    expect(nullJustification.provenance.justification).toMatchObject({ kind: 'model', role: 'forging_agent', model: 'gpt-x' });
    const absent = buildForgeTrace(inputOf({ record: recordAt(T0, author), args: f1() }));
    expect(absent.justification).toBeNull();
    expect(absent.provenance.justification).toBeNull();
  });

  it("the judge's detail is cut and its lists shortened, with their paths", () => {
    const concerns = Array.from({ length: 20 }, (_, i) => `concern ${i} ` + 'c'.repeat(2 * KIB));
    const detail = judgeDetail({
      safetyConcerns: concerns,
      failedTests: Array.from({ length: 70 }, (_, i) => i + 1),
      determinismReasoning: 'n'.repeat(2 * KIB),
    });
    const trace = buildForgeTrace(inputOf({ stage: 'judge_rejected', reason: 'no', verdict: REJECTION, judgeDetail: detail }));

    const kept = trace.judgeDetail!;
    expect(kept.safetyConcerns).toHaveLength(16);
    for (const [index, concern] of kept.safetyConcerns.entries()) {
      expect(concern).toMatchObject({ $trace: 'cut', bytes: Buffer.byteLength(concerns[index]) });
      expect(jsonBytes(concern)).toBeLessThanOrEqual(KIB);
      expect((concern as ForgeTraceCut).head.startsWith(`concern ${index} `)).toBe(true);
    }
    expect(kept.failedTests).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(kept.determinismReasoning).toMatchObject({ $trace: 'cut', bytes: 2 * KIB });
    expect(jsonBytes(kept.determinismReasoning)).toBeLessThanOrEqual(KIB);
    expect(kept).toMatchObject({
      judgeModel: 'judge-model',
      replyParsed: true,
      judgeError: null,
      judgeApproved: false,
      safetyPassed: false,
      correctnessPassed: true,
      deterministic: false,
      bounded: true,
      boundedReasoning: 'One loop.',
    });
    expect(trace.sizes.cut).toEqual([
      'judgeDetail.safetyConcerns',
      ...Array.from({ length: 16 }, (_, i) => `judgeDetail.safetyConcerns[${i}]`),
      'judgeDetail.failedTests',
      'judgeDetail.determinismReasoning',
    ]);

    // A detail within its caps is kept as it is, and no judge means no detail.
    expect(buildForgeTrace(inputOf({ verdict: REJECTION, judgeDetail: judgeDetail() })).judgeDetail).toEqual(judgeDetail());
    expect(buildForgeTrace(inputOf()).judgeDetail).toBeNull();
  });

  it('the worst case with every field over its cap stays under 512 KiB, and traceBytes is its JSON length', () => {
    // Quotes, backslashes and control characters: JSON writes each as an escape of two to six bytes.
    const harsh = (bytes: number): string => '"\\\u0001'.repeat(Math.ceil(bytes / 3));
    const value = (bytes: number) => ({ v: harsh(bytes) });
    const testCases = Array.from({ length: 30 }, () => ({
      input: value(3 * KIB),
      expectedOutput: value(3 * KIB),
      stepOutputs: value(3 * KIB),
      responses: [value(3 * KIB)],
    }));
    const testRuns = Array.from({ length: 30 }, () => ({
      input: null,
      output: value(6 * KIB),
      success: true,
      error: harsh(6 * KIB),
      effects: [value(3 * KIB)],
    }));
    const args = {
      name: harsh(KIB),
      description: harsh(4 * KIB),
      inputSchema: { type: 'object', description: harsh(16 * KIB) },
      outputSchema: { type: 'object', description: harsh(16 * KIB) },
      implementation: { mode: 'sandbox', code: harsh(100 * KIB), allowlist: Array.from({ length: 200 }, () => harsh(KIB)) },
      justification: harsh(4 * KIB),
      testCases,
    };
    const plain = harsh(3 * KIB);
    const trace = buildForgeTrace({
      record: {
        forgeId: plain,
        startedAt: T0,
        author: { kind: 'model', role: 'forging_agent', provider: plain, model: plain, modelSource: 'requested' },
        delivered: false,
        seen: false,
      },
      recordedBy: 'engine',
      via: 'forge_tool',
      stage: 'judge_rejected',
      reason: harsh(8 * KIB),
      args,
      agentId: plain,
      sessionId: plain,
      correlationId: plain,
      testRuns,
      testsFinishedAt: T0 + 1,
      executor: { name: plain, isolates: true },
      verdict: { ...REJECTION, reasoning: 'x'.repeat(600 * KIB) },
      verdictAt: T0 + 2,
      judgeDetail: judgeDetail({
        judgeModel: plain,
        safetyConcerns: Array.from({ length: 20 }, () => harsh(2 * KIB)),
        failedTests: Array.from({ length: 100 }, (_, i) => i + 1),
        determinismReasoning: harsh(2 * KIB),
        boundedReasoning: harsh(2 * KIB),
      }),
      judge: { model: plain, providerId: plain },
      toolId: plain,
      finishedAt: T0 + 3,
    });

    const bytes = jsonBytes(trace);
    expect(bytes).toBe(trace.sizes.traceBytes);
    expect(bytes).toBeLessThan(524_288);
    expect(trace.tests).toHaveLength(16);
    expect(trace.sizes.testsOmitted).toBe(14);
    expect(trace.request!.implementation).toMatchObject({ mode: 'sandbox' });
    expect((trace.request!.implementation as { allowlist: readonly unknown[] }).allowlist).toHaveLength(64);

    // Each plain string keeps a start within 2 KiB, and each is listed.
    const plainStrings = [
      trace.forgeId,
      trace.agentId,
      trace.sessionId,
      trace.correlationId,
      trace.toolId,
      trace.executor!.name,
      trace.judgeDetail!.judgeModel,
      trace.provenance.request.provider,
      trace.provenance.request.model,
      trace.provenance.justification!.provider,
      trace.provenance.verdict!.provider,
      trace.provenance.verdict!.model,
    ];
    for (const text of plainStrings) {
      expect(typeof text).toBe('string');
      expect(jsonBytes(text)).toBeLessThanOrEqual(2 * KIB);
      expect(plain.startsWith(text as string)).toBe(true);
    }
    expect(trace.sizes.cut).toEqual(
      expect.arrayContaining([
        'forgeId',
        'agentId',
        'sessionId',
        'correlationId',
        'toolName',
        'reason',
        'request.name',
        'request.description',
        'request.inputSchema',
        'request.outputSchema',
        'request.implementation.code',
        'request.implementation.allowlist',
        'request.implementation.allowlist[63]',
        'justification',
        'tests[15].input',
        'tests[15].expectedOutput',
        'tests[15].stepOutputs',
        'tests[15].responses',
        'tests[15].result.output',
        'tests[15].result.error',
        'tests[15].result.effects',
        'executor.name',
        'verdict.reasoning',
        'judgeDetail.judgeModel',
        'judgeDetail.safetyConcerns',
        'judgeDetail.failedTests',
        'judgeDetail.boundedReasoning',
        'toolId',
        'provenance.request.provider',
        'provenance.justification.model',
        'provenance.verdict.provider',
      ]),
    );
  });

  it('sizes.cut lists cuts as they are made, not values shaped like a marker', () => {
    const marker = { $trace: 'cut', bytes: 1, head: 'x' };
    const trace = buildForgeTrace(
      inputOf({ args: f1({ testCases: [{ input: marker, expectedOutput: { $trace: 'unserializable', kind: 'other' } }] }) }),
    );
    expect(trace.tests[0].input).toEqual(marker);
    expect(trace.sizes.cut).toEqual([]);
  });

  it('the trace is deep-frozen', () => {
    const args = f1();
    const trace = buildForgeTrace(
      inputOf({
        record: recordAt(T0, { kind: 'model', role: 'forging_agent', provider: null, model: null, modelSource: null }),
        stage: 'judge_rejected',
        reason: 'no',
        args,
        testRuns: [PASSING_RUN],
        executor: { name: 'in-process', isolates: false },
        verdict: REJECTION,
        judgeDetail: judgeDetail(),
        judge: { model: 'judge-model', providerId: null },
      }),
    );
    const all = containers(trace);
    expect(all.length).toBeGreaterThan(20);
    for (const container of all) {
      expect(Object.isFrozen(container)).toBe(true);
    }
    expect(() => {
      (trace.tests[0] as { ran: boolean }).ran = false;
    }).toThrow(TypeError);
    expect(() => {
      (trace.request!.inputSchema as { type: string }).type = 'string';
    }).toThrow(TypeError);
    expect(() => {
      (trace.sizes.cut as string[]).push('x');
    }).toThrow(TypeError);
    // The trace holds copies: the caller's arguments are neither shared nor frozen.
    expect(trace.request!.inputSchema).not.toBe(args.inputSchema);
    expect(Object.isFrozen(args.inputSchema)).toBe(false);
  });

  it('the builder never throws on hostile arguments', () => {
    const OTHER_MARKER = { $trace: 'unserializable', kind: 'other' };
    const everyGetThrows = new Proxy(
      {},
      {
        get(): never {
          throw new Error('get');
        },
      },
    );
    const proxied = buildForgeTrace(inputOf({ args: everyGetThrows }));
    expect(proxied.request).toBeNull();
    expect(proxied.tests).toEqual([]);
    expect(proxied.rawArguments).toEqual(OTHER_MARKER);
    expect(proxied.toolName).toBeNull();
    expect(proxied.mode).toBeNull();
    expect(jsonBytes(proxied)).toBe(proxied.sizes.traceBytes);

    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(buildForgeTrace(inputOf({ args: revoked })).rawArguments).toEqual(OTHER_MARKER);

    const getters = f1();
    for (const key of ['name', 'testCases']) {
      Object.defineProperty(getters, key, {
        enumerable: true,
        get(): never {
          throw new Error(key);
        },
      });
    }
    const unread = buildForgeTrace(inputOf({ args: getters }));
    expect(unread.request).toBeNull();
    expect(unread.toolName).toBeNull();
    expect(unread.mode).toBe('sandbox');
    expect(unread.rawArguments).toMatchObject({ name: OTHER_MARKER, testCases: OTHER_MARKER, description: 'Add two numbers.' });

    // A well-formed request whose test case has a getter that throws keeps the case, with a marker in its place.
    const testCase = { expectedOutput: { sum: 5 } };
    Object.defineProperty(testCase, 'input', {
      enumerable: true,
      get(): never {
        throw new Error('input');
      },
    });
    const kept = buildForgeTrace(inputOf({ args: f1({ testCases: [testCase] }) }));
    expect(kept.request).not.toBeNull();
    expect(kept.tests[0]).toMatchObject({ index: 0, input: OTHER_MARKER, expectedOutput: { sum: 5 }, ran: false });

    // A verdict and a run that throw on every read.
    const hostile = buildForgeTrace(
      inputOf({ stage: 'judge_rejected', verdict: everyGetThrows as CreationVerdict, testRuns: [everyGetThrows as ForgeTestRun] }),
    );
    expect(hostile.verdict).toMatchObject({ approved: OTHER_MARKER, reasoning: JSON.stringify(OTHER_MARKER) });
    expect(hostile.tests[0].result).toEqual({ output: OTHER_MARKER, success: false, effects: OTHER_MARKER, error: JSON.stringify(OTHER_MARKER) });
  });

  it('settleForgeTrace keeps the first trace and delivers once', async () => {
    const record = newForgeCallRecord();
    const first = buildForgeTrace(inputOf({ record }));
    const second = buildForgeTrace(inputOf({ record, stage: 'thrown', reason: 'later' }));
    const deliver = vi.fn(async (_trace: ForgeTrace) => undefined);

    const settling = settleForgeTrace(record, first, deliver);
    // Both flags are set before the first await, so a second settle in the same turn delivers nothing.
    expect(record.trace).toBe(first);
    expect(record.delivered).toBe(true);
    const again = settleForgeTrace(record, second, deliver);
    await expect(settling).resolves.toBe(first);
    await expect(again).resolves.toBe(first);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(first);
    expect(record.trace).toBe(first);

    // With no delivery method the record is marked delivered all the same; a delivery that throws changes nothing.
    const quiet = newForgeCallRecord();
    await expect(settleForgeTrace(quiet, second, undefined)).resolves.toBe(second);
    expect(quiet.delivered).toBe(true);
    const failing = newForgeCallRecord();
    await expect(
      settleForgeTrace(failing, first, async () => {
        throw new Error('delivery failed');
      }),
    ).resolves.toBe(first);
  });

  it('mintForgeId gives forge_ and a UUID', () => {
    const uuid = /^forge_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(mintForgeId()).toMatch(uuid);
    expect(mintForgeId()).not.toBe(mintForgeId());
    const record = newForgeCallRecord();
    expect(record.forgeId).toMatch(uuid);
    expect(record).toMatchObject({ delivered: false, seen: false });
    expect(record.author).toBeUndefined();
    expect(record.trace).toBeUndefined();
    expect(newForgeCallRecord('forge_given').forgeId).toBe('forge_given');
  });

  it('every stage code is a value the forge_done line accepts', () => {
    const stage = AGENTOS_EVENTS['emergent.forge_done'].stage;
    expect([...stage.enum]).toEqual([...FORGE_TRACE_STAGES]);
    for (const code of FORGE_TRACE_STAGES) {
      expect(valid(stage, code, 'stage'), code).toBe(true);
    }
    // A word field would refuse 12 of them as credential-shaped.
    expect(FORGE_TRACE_STAGES.filter((code) => !valid('word', code, 'stage'))).toHaveLength(12);
  });

  it("the forge_done line holds the trace's figures and no content", async () => {
    const lines = recordLines();
    const approved = buildForgeTrace(
      inputOf({
        stage: 'approved',
        reason: null,
        args: f1({ justification: 'Fills a gap.' }),
        testRuns: [PASSING_RUN],
        executor: { name: 'in-process', isolates: false },
        verdict: { ...REJECTION, approved: true },
        toolId: 'emergent:tool-1',
      }),
    );
    await deliverForgeTrace(approved, undefined);
    const refused = buildForgeTrace(inputOf({ args: '{not json' }));
    await deliverForgeTrace(refused, undefined);

    expect(lines.map(({ level }) => level)).toEqual(['info', 'warn']);
    expect(lines[0].line).toEqual({
      component: 'emergent',
      event: 'emergent.forge_done',
      outcome: 'approved',
      stage: 'approved',
      recordedBy: 'engine',
      via: 'direct',
      mode: 'sandbox',
      tests: 1,
      testsPassed: 1,
      testsOmitted: 0,
      codeBytes: Buffer.byteLength(ADD_CODE),
      traceBytes: approved.sizes.traceBytes,
      cutFields: 0,
      justificationChars: 'Fills a gap.'.length,
      judgeRan: 'yes',
      executorIsolates: 'no',
      durationMs: 40,
    });
    // No request: no codeBytes, mode none.
    expect(lines[1].line).toMatchObject({ outcome: 'refused', mode: 'none', tests: 0, judgeRan: 'no', executorIsolates: 'none' });
    expect('codeBytes' in lines[1].line).toBe(false);
    const printed = JSON.stringify(lines);
    for (const content of ['add_numbers', 'Fills a gap', 'forge_test', 'agent-1', 'turn-1', 'Code validation', '{not json']) {
      expect(printed).not.toContain(content);
    }
  });

  it("a hook that hangs holds a ref'd timer until the bound", async () => {
    const lines = recordLines();
    const trace = buildForgeTrace(inputOf());
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');

    const started = performance.now();
    const delivering = deliverForgeTrace(trace, () => new Promise<void>(() => undefined));
    const index = timers.mock.calls.findIndex(([, ms]) => ms === FORGE_TRACE_HOOK_BOUND_MS);
    expect(index).toBeGreaterThanOrEqual(0);
    const handle = timers.mock.results[index].value as ReturnType<typeof setTimeout>;
    expect(handle.hasRef()).toBe(true);
    await delivering;
    expect(performance.now() - started).toBeGreaterThanOrEqual(FORGE_TRACE_HOOK_BOUND_MS - 50);
    expect(lines.filter(({ line }) => line.event === 'emergent.forge_trace_hook_slow').map(({ line }) => line.boundMs)).toEqual([
      FORGE_TRACE_HOOK_BOUND_MS,
    ]);

    // A hook that settles at once clears its timer, and writes no slow line.
    timers.mockClear();
    clears.mockClear();
    await deliverForgeTrace(trace, () => undefined);
    const quickIndex = timers.mock.calls.findIndex(([, ms]) => ms === FORGE_TRACE_HOOK_BOUND_MS);
    expect(quickIndex).toBeGreaterThanOrEqual(0);
    expect(clears).toHaveBeenCalledWith(timers.mock.results[quickIndex].value);
    expect(lines.filter(({ line }) => line.event === 'emergent.forge_trace_hook_slow')).toHaveLength(1);

    // A hook that throws at once or rejects writes its listed type and code, and delivery resolves.
    await deliverForgeTrace(trace, () => {
      throw new TypeError('private words');
    });
    await deliverForgeTrace(trace, async () => {
      throw new RangeError('private words');
    });
    const failed = lines.filter(({ line }) => line.event === 'emergent.forge_trace_hook_failed').map(({ line }) => line.type);
    expect(failed).toEqual(['TypeError', 'RangeError']);
    expect(JSON.stringify(lines)).not.toContain('private words');
  });

  it('a forge_done write that throws never skips the hook', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const warn = vi.fn().mockImplementationOnce(() => {
      throw new LogValidationError('bad_value');
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn(), child: (): unknown => logger };
    setLogger(logger as unknown as Logger);
    const trace = buildForgeTrace(inputOf());
    const hook = vi.fn();

    await expect(deliverForgeTrace(trace, hook)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'emergent.forge_done' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(trace);
  });

  it('thrownReason never throws', () => {
    expect(thrownReason(new Error('register failed'))).toBe('register failed');

    const bare: unknown = Object.create(null);
    expect(thrownReason(bare)).toBe(bare);
    expect(buildForgeTrace(inputOf({ stage: 'thrown', reason: thrownReason(bare) })).reason).toBe('{}');

    const sly = new Error('hidden');
    Object.defineProperty(sly, 'message', {
      get(): never {
        throw new Error('getter');
      },
    });
    expect(thrownReason(sly)).toBe(sly);
    expect(() => buildForgeTrace(inputOf({ stage: 'thrown', reason: thrownReason(sly) }))).not.toThrow();

    const noPrototype = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('prototype');
        },
      },
    );
    expect(thrownReason(noPrototype)).toBe(noPrototype);

    expect(thrownReason('text')).toBe('text');
    expect(thrownReason(7)).toBe(7);
    expect(thrownReason(undefined)).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// A bounded walk: a value's copy and its JSON text stop once the field's cap is passed and its measure is spent
// ----------------------------------------------------------------------------

/** `count` objects whose one key is a getter that counts its reads, and the plain list JSON writes the same way. */
function countedList(count: number): { value: unknown[]; plain: unknown[]; reads: () => number } {
  let reads = 0;
  const value = Array.from({ length: count }, (_, i) => ({
    get v(): number {
      reads += 1;
      return i;
    },
  }));
  const plain = Array.from({ length: count }, (_, i) => ({ v: i }));
  return { value, plain, reads: () => reads };
}

/**
 * `result` is a cut of `text` at `capBytes` whose whole size was not measured: `bytes` is null, its own JSON fits the
 * cap, and its head is the longest start of `text` that fits (one more character would not).
 */
function expectUnmeasuredCutOf(text: string, capBytes: number, result: unknown): ForgeTraceCut {
  expect(result).toMatchObject({ $trace: 'cut' });
  const cut = result as ForgeTraceCut;
  expect(cut.bytes).toBeNull();
  expect(cut.head.length).toBeGreaterThan(0);
  expect(text.startsWith(cut.head)).toBe(true);
  expect(jsonBytes(cut)).toBeLessThanOrEqual(capBytes);
  expect(jsonBytes({ ...cut, head: text.slice(0, cut.head.length + 1) })).toBeGreaterThan(capBytes);
  return cut;
}

/**
 * Every score of a trace's verdict admits null, the copy of a number JSON cannot write. Type check is the check: with
 * a score typed number alone, `scoresAdmitNull` takes the type `false` and fails to compile.
 */
type ScoresAdmitNull = [
  ForgeTraceVerdict['confidence'],
  ForgeTraceVerdict['safety'],
  ForgeTraceVerdict['correctness'],
  ForgeTraceVerdict['determinism'],
  ForgeTraceVerdict['bounded'],
] extends [infer A, infer B, infer C, infer D, infer E]
  ? null extends A & B & C & D & E
    ? true
    : false
  : false;
const scoresAdmitNull: ScoresAdmitNull = true;

describe('forge trace: a bounded walk of each field', () => {
  it('a value far over its cap keeps the start that fits, lists its path, and is not read to its end', () => {
    const count = 200_000;
    const { value, plain, reads } = countedList(count);
    const cut: string[] = [];

    expectUnmeasuredCutOf(JSON.stringify(plain), 512, traceValue(value, 512, 'tests[0].input', cut));
    expect(cut).toEqual(['tests[0].input']);
    // The walk stopped far short of the value: most of its getters never ran.
    expect(reads()).toBeGreaterThan(0);
    expect(reads()).toBeLessThan(count / 4);
  });

  it('a text field given a value far over its cap is cut the same way, from its JSON text', () => {
    const count = 200_000;
    const { value, plain, reads } = countedList(count);
    const cut: string[] = [];

    expectUnmeasuredCutOf(JSON.stringify(plain), 512, traceText(value, 512, 'reason', cut));
    expect(cut).toEqual(['reason']);
    expect(reads()).toBeLessThan(count / 4);
  });

  it('a value over its cap whose walk ends within its measure keeps its whole size', () => {
    const value = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, label: `item ${i} ✓ \u{1F600} "q" \\ \u0001` })) };
    const json = JSON.stringify(value);
    const result = traceValue(value, 512, 'tests[0].input', []) as ForgeTraceCut;
    expect(result.bytes).toBe(Buffer.byteLength(json));
    expect(json.startsWith(result.head)).toBe(true);
  });

  it("the walk's text is the copy's JSON text, markers, key order and escapes included", () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = {
      keys: JSON.parse('{"b":1,"2":"two","1":"one","__proto__":"p"}') as unknown,
      big: 10n,
      cyclic,
      fn: () => 1,
      throwing: {
        ok: 1,
        get bad(): number {
          throw new Error('getter');
        },
      },
      revoked,
      keyed: { toJSON: (key: string) => `key:${key}` },
      absent: undefined,
      list: [undefined, NaN, -0, 1e21, () => 2, new Date(Date.UTC(2026, 10, 18))],
      boxed: [new Number(3), new String('s'), new Boolean(false)],
      text: 'x\ud800y\udc00z\u{1F600}"\\\u0000\u001f\u007f  tab\t',
    };
    const copy = jsonSafeCopy(hostile);
    const json = JSON.stringify(copy);
    expect(json.length).toBeGreaterThan(256);

    // Within the cap the field is the copy itself; over it, the cut's head is the start of the copy's JSON text.
    expect(traceValue(hostile, 64 * KIB, 'tests[0].input', [])).toEqual(copy);
    expectCutOf(json, 256, traceValue(hostile, 256, 'tests[0].input', []));
    expect(traceText(hostile, 64 * KIB, 'reason', [])).toBe(json);
  });

  it("a composition's steps are read once, and codeBytes is the size the walk measured", () => {
    let reads = 0;
    const step = {
      name: 'say',
      tool: 'echo',
      get inputMapping(): Record<string, string> {
        reads += 1;
        return { text: '$input.text' };
      },
    };
    const trace = buildForgeTrace(inputOf({ args: f1({ implementation: { mode: 'compose', steps: [step] } }) }));
    expect(reads).toBe(1);
    const plain = [{ name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } }];
    expect(trace.request!.implementation).toEqual({ mode: 'compose', steps: plain });
    expect(trace.sizes.codeBytes).toBe(Buffer.byteLength(JSON.stringify(plain)));
  });

  it('steps whose JSON runs past what the walk measures have an unknown codeBytes and a cut with an unknown size', () => {
    const huge = 'w'.repeat(5 * 1024 * KIB);
    const steps = [{ name: 'say', tool: 'echo', inputMapping: { text: huge } }];
    const trace = buildForgeTrace(inputOf({ args: f1({ implementation: { mode: 'compose', steps } }) }));
    expect(trace.sizes.codeBytes).toBeNull();
    const implementation = trace.request!.implementation as { steps: ForgeTraceCut };
    expectUnmeasuredCutOf(JSON.stringify(steps), 64 * KIB, implementation.steps);
    expect(trace.sizes.cut).toContain('request.implementation.steps');
    expect(jsonBytes(trace)).toBe(trace.sizes.traceBytes);
  });

  it("a verdict score JSON cannot write (an infinity from the judge's reply) is null in the trace", () => {
    const trace = buildForgeTrace(
      inputOf({
        stage: 'judge_rejected',
        reason: 'no',
        verdict: { ...REJECTION, confidence: Number.POSITIVE_INFINITY, safety: Number.NEGATIVE_INFINITY },
      }),
    );
    expect(trace.verdict!.confidence).toBeNull();
    expect(trace.verdict!.safety).toBeNull();
    expect(trace.verdict!.correctness).toBe(REJECTION.correctness);
    expect(scoresAdmitNull).toBe(true);
  });
});
