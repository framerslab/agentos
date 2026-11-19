/**
 * @fileoverview What a forge_tool call looks like to the model, to a host's
 * stream and to a wrapper's capture, pinned as it stood at commit
 * fd17f220b43352ceab1a8746d0d52dc5b28fa681. Every value here is written from
 * that commit's code, and the CI run of the commit that added this file is its
 * record: the pins that read these values passed there on code that had not
 * changed. A change that moves one of these representations fails its pin.
 *
 * The values are those of the forges `pinArgs` names, made under
 * `freezeClock()`: the clock holds at 2026-11-18T00:00:00.000Z and
 * `Math.random` at 0.5, so a forged tool's id is `emergent_1794960000000_i`.
 */

import { vi } from 'vitest';
import type { ITool, JSONSchemaObject } from '../../../../core/tools/ITool.js';
import { EmergentToolRegistry } from '../../EmergentToolRegistry.js';
import { APPROVED_JSON, REJECTED_JSON, composeArgs, wrapperArgs } from '../helpers/forge-trace-harness.js';

/** The ends of a forge the pins cover: one approved, one the judge rejects, two refusals and one that throws. */
export const PIN_OUTCOMES = ['approved', 'judge_rejected', 'code_validation', 'description_missing', 'thrown'] as const;

/** One of {@link PIN_OUTCOMES}. */
export type PinOutcome = (typeof PIN_OUTCOMES)[number];

/**
 * The forge_tool arguments that end at `outcome`: the two-test code forge of `wrapperArgs()`, with code the
 * validator refuses for `code_validation` and an empty description for `description_missing`. `judge_rejected` and
 * `thrown` take the same arguments as `approved`; their ends come from `pinJudgeReply` and `failNextRegistration`.
 */
export function pinArgs(outcome: PinOutcome): Record<string, unknown> {
  if (outcome === 'code_validation') {
    return wrapperArgs({
      implementation: { mode: 'sandbox', code: 'function execute(input) { return eval("1"); }', allowlist: [] },
    });
  }
  if (outcome === 'description_missing') {
    return wrapperArgs({ description: '' });
  }
  return wrapperArgs();
}

/** The judge's reply for `outcome`: a rejection for `judge_rejected`, an approval for every other one. */
export function pinJudgeReply(outcome: PinOutcome): string {
  return outcome === 'judge_rejected' ? REJECTED_JSON : APPROVED_JSON;
}

/**
 * Makes the registry's next `register` throw `Error('register failed')`, which is how the `thrown` outcome ends: the
 * forge has passed its tests and its judge, and throws out of the engine. `vi.restoreAllMocks()` undoes it.
 */
export function failNextRegistration(): void {
  vi.spyOn(EmergentToolRegistry.prototype, 'register').mockImplementationOnce(() => {
    throw new Error('register failed');
  });
}

/**
 * The details of a failed call without the two stack texts the `thrown` outcome carries: `details.stack` and
 * `details.errorDetailsFromGMIError.underlyingError.stack`. Both name source lines and the paths of the machine the
 * test runs on, so a pin compares that outcome without them and keeps every other byte. Returns a JSON copy with its
 * keys in their order; `errorDetails` is not changed.
 */
export function withoutThrownStacks(errorDetails: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(errorDetails)) as {
    details?: { stack?: unknown; errorDetailsFromGMIError?: { underlyingError?: { stack?: unknown } } };
  } | null;
  if (copy?.details) {
    delete copy.details.stack;
    if (copy.details.errorDetailsFromGMIError?.underlyingError) {
      delete copy.details.errorDetailsFromGMIError.underlyingError.stack;
    }
  }
  return copy;
}

/** A host tool with no side effects whose output holds a date, a function, a list with an empty place and a nested object. */
export function richOutputTool(): ITool {
  return {
    id: 'rich-output-v1',
    name: 'rich_output',
    displayName: 'Rich output',
    description: 'Returns a date, a function, a list with an empty place and a nested object.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    hasSideEffects: false,
    execute: async () => ({
      success: true,
      output: { when: new Date(Date.UTC(2026, 10, 18)), fn: () => 1, list: [undefined, 1], nested: { a: 'x' } },
    }),
  };
}

/** The forge whose judge prompt `PINS.judgePrompt` holds: a one-step composition over `rich_output`, with one test case. */
export function judgePromptArgs(): Record<string, unknown> {
  return composeArgs([{ name: 'read', tool: 'rich_output', inputMapping: { text: '$input.text' } }], {
    name: 'rich_reader',
    description: 'Returns what rich_output gives for a text.',
    testCases: [{ input: { text: 'hi' } }],
  });
}

/**
 * forge_tool's input schema at fd17f220: the text of `ForgeToolMetaTool.ts` lines 132 to 252 of that commit, with each
 * of its three long dashes written as its escape.
 */
export const FD17F220_SCHEMA: JSONSchemaObject = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Machine-readable name for the new tool: an ASCII letter, then ASCII letters, digits, underscores ' +
        'or hyphens, at most 200 characters.',
    },
    description: {
      type: 'string',
      description: 'Natural language description of what the tool does.',
    },
    inputSchema: {
      type: 'object',
      description: 'JSON Schema for the tool input arguments.',
    },
    outputSchema: {
      type: 'object',
      description: 'JSON Schema for the tool output (optional).',
    },
    implementation: {
      description: 'Implementation: compose existing tools or write sandboxed code.',
      oneOf: [
        {
          type: 'object',
          properties: {
            mode: { type: 'string', const: 'compose' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tool: { type: 'string' },
                  inputMapping: { type: 'object' },
                },
                required: ['name', 'tool', 'inputMapping'],
              },
              minItems: 1,
            },
          },
          required: ['mode', 'steps'],
        },
        {
          type: 'object',
          properties: {
            mode: { type: 'string', const: 'sandbox' },
            code: {
              type: 'string',
              description:
                'Pure JavaScript (ES2020). MUST define `function execute(input) { ... }` ' +
                '(or an async equivalent) at the top level. RULES that block the judge from ' +
                'approving otherwise-correct tools: ' +
                '(1) NO TypeScript: no `: type` annotations, no `interface`, no `type` aliases, no `<T>` generics, no `enum`. ' +
                '(2) Every `if`/`for`/`while`/`else` body uses BLOCK BRACES `{ ... }` \u2014 ' +
                'single-line bodies with declarations are forbidden. ' +
                '(3) Arrow functions that declare variables must use `(...) => { const x = ...; return x; }` \u2014 ' +
                'never `(...) => const x = ...` (a SyntaxError). ' +
                '(4) Output MUST conform exactly to `outputSchema` \u2014 no extra fields. ' +
                'If the schema has `additionalProperties: false`, return ONLY the declared keys.',
            },
            allowlist: {
              type: 'array',
              description:
                'The capabilities the code uses: fetch, fs.read (in code, the function fs.readFile), ' +
                'fs.write (fs.writeFile(path, data)), fs.delete (fs.unlink(path)) and crypto; the function names ' +
                'are accepted too. The host decides what it grants: a name it does not grant refuses the forge, ' +
                'and the refusal names what it grants.',
              items: {
                type: 'string',
                enum: ['fetch', 'fs.read', 'fs.readFile', 'fs.write', 'fs.writeFile', 'fs.delete', 'fs.unlink', 'crypto'],
              },
            },
          },
          required: ['mode', 'code', 'allowlist'],
        },
      ],
    },
    testCases: {
      type: 'array',
      description: 'One or more test cases for the judge to evaluate.',
      items: {
        type: 'object',
        properties: {
          input: { type: 'object' },
          expectedOutput: {},
          stepOutputs: {
            type: 'object',
            description:
              'For a composition: the output of each step whose tool has side effects, keyed by step name. ' +
              'Those steps are not executed while the tool is forged.',
          },
          responses: {
            type: 'array',
            description:
              'For a code tool that sends POST, PUT, PATCH or DELETE requests: the answer each such request ' +
              'gets while the tool is forged, since none is sent then. A request takes the first unused answer ' +
              'with its method and URL; one with no answer gets a 204. Writes and deletes made while forging ' +
              'land in a temporary directory and are read back from it.',
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'HEAD'] },
                url: { type: 'string' },
                status: { type: 'integer', minimum: 200, maximum: 599 },
                headers: { type: 'object', additionalProperties: { type: 'string' } },
                body: { type: 'string' },
              },
              required: ['method', 'url', 'status'],
            },
          },
        },
        required: ['input'],
      },
      minItems: 1,
    },
  },
  required: ['name', 'description', 'inputSchema', 'implementation', 'testCases'],
};

// ----------------------------------------------------------------------------
// The pinned values
// ----------------------------------------------------------------------------

/** The id a tool forged under `freezeClock()` is given. */
const TOOL_ID = 'emergent_1794960000000_i';

/** The verdict the engine builds from the approving reply. */
const APPROVED_VERDICT = {
  approved: true,
  confidence: 0.95,
  safety: 1,
  correctness: 1,
  determinism: 1,
  bounded: 1,
  reasoning: 'Tool is safe and correct.',
};

/** The verdict the engine builds from the rejecting reply. */
const REJECTED_VERDICT = {
  approved: false,
  confidence: 0.3,
  safety: 0,
  correctness: 1,
  determinism: 1,
  bounded: 1,
  reasoning: 'Tool contains unsafe patterns.',
};

/** The arguments of the approved forge, as a failed call's details repeat them. */
const ADD_NUMBERS_ARGS = {
  name: 'add_numbers',
  description: 'Add two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
  implementation: {
    mode: 'sandbox',
    code: 'function execute(input) { return { sum: input.a + input.b }; }',
    allowlist: [],
  },
  testCases: [
    { input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } },
    { input: { a: 1, b: 1 }, expectedOutput: { sum: 2 } },
  ],
};

/** The result of the approved forge, for the agent that forged it and the session it forged in. */
function approvedResult(agentId: string, sessionId: string): Record<string, unknown> {
  return {
    success: true,
    toolId: TOOL_ID,
    tool: {
      id: TOOL_ID,
      name: 'add_numbers',
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
      implementation: {
        mode: 'sandbox',
        code: 'function execute(input) { return { sum: input.a + input.b }; }',
        allowlist: [],
      },
      tier: 'session',
      createdBy: agentId,
      createdAt: '2026-11-18T00:00:00.000Z',
      judgeVerdicts: [APPROVED_VERDICT],
      usageStats: {
        totalUses: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTimeMs: 0,
        lastUsedAt: null,
        confidenceScore: 0.95,
      },
      source: `forged by agent ${agentId} during session ${sessionId}`,
    },
    verdict: APPROVED_VERDICT,
  };
}

/** What the GMI's tool message begins with when the call failed. */
const TOOL_ERROR = "Error from tool 'forge_tool': ";

/** The message of the executor's result when forge_tool's `execute` throws. */
const THROWN_MESSAGE = "Critical unhandled error during the execution of tool 'forge_tool'.: register failed";

/** A failed call as the TOOL_RESULT chunk carries it: no output, and the error's message. */
function failedChunk(message: string): Record<string, unknown> {
  return { toolCallId: 'call_forge', name: 'forge_tool', result: null, isError: true, errorDetails: { message } };
}

/**
 * The judge's rubric, the fixed part of its prompt: the text of `EmergentJudge.ts` lines 450 to 468 at fd17f220, with
 * each of its two long dashes written as its escape.
 */
const JUDGE_RUBRIC = `You are a security auditor reviewing a tool an AI agent created at runtime.

Evaluate the tool against four concrete criteria. Each criterion is binary: pass or fail with a specific cause. Do not hedge.

1. SAFETY: Does the implementation access network, filesystem, or secrets beyond the declared allowlist? Does it explicitly exfiltrate data, contain a known-unbounded loop, or allocate without a bound? PASS unless you can name the offending construct.
2. CORRECTNESS: Did each provided testCase actually run (success: true)? Does each test output conform to the declared output schema (no extra fields, all declared required fields present)? PASS when those two conditions hold for every test that ran. Disagreement between testCase expectedOutput and observed output is the AUTHOR'S problem, not yours \u2014 if the code computes something different from expectedOutput, that means the AUTHOR'S expectedOutput was a guess; the code is the source of truth as long as it conforms to the schema and is deterministic.
3. DETERMINISM: Does the code use Math.random, Date.now, time-of-day, or other non-determinism for its return value? PASS unless you can point at the specific source of non-determinism.
4. BOUNDED: Is there an unbounded loop or recursion without a terminating condition? PASS unless you can name the unbounded construct.

APPROVAL RULES (hard):
- If all four criteria PASS, set approved=true with confidence in [0.7, 1.0].
- If any criterion FAILS, set approved=false and put the specific code construct or test failure in reasoning.
- Do NOT reject because you "cannot confidently verify" something. Cannot-verify is not a violation. If the code does not exhibit a concrete failure of one of the four criteria, approve it.
- Do NOT reject because you wish there were more test cases or different test cases. The author chose the tests; your job is to evaluate the tool against the tests provided, not to design a better test plan.
- Do NOT reject for stylistic preferences (try/catch presence or absence, naming, formatting, code length).
- A discrepancy between an author-supplied expectedOutput and the code's actual output is NOT a correctness failure on the code \u2014 it is the author setting an inaccurate expectation. As long as the code's actual output matches the schema and the test ran successfully, that is a PASS.

Respond ONLY with JSON:
{"safety":{"passed":true/false,"concerns":[]},"correctness":{"passed":true/false,"failedTests":[]},"determinism":{"likely":true/false,"reasoning":""},"bounded":{"likely":true/false,"reasoning":""},"confidence":0.0-1.0,"approved":true/false,"reasoning":""}`;

/** The part of the judge's prompt that names the forge of `judgePromptArgs()` and its one test run. */
const JUDGE_CANDIDATE = [
  'Tool name: rich_reader',
  'Description: Returns what rich_output gives for a text.',
  'Input schema: {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}',
  'Output schema: {"type":"object","properties":{"text":{"type":"string"}}}',
  'Implementation mode: compose',
  'Source code:',
  '{"mode":"compose","steps":[{"name":"read","tool":"rich_output","inputMapping":{"text":"$input.text"}}]}',
  'Requested sandbox APIs: []',
  'Test cases and results:',
  'Test 1: input={"text":"hi"} output={"when":"2026-11-18T00:00:00.000Z","list":[null,1],"nested":{"a":"x"}} success=true',
].join('\n');

/**
 * Each representation's value at fd17f220.
 *
 * - `gmiToolMessage`: the content of the `tool` message the GMI writes for the call and sends with its next model
 *   call. The forge is made by persona `scripted-persona` in turn `t1`.
 * - `gmiToolResultChunk`: the content of the TOOL_RESULT chunk the GMI yields for the same call.
 * - `captureOutput`: `CapturedForge.output` of a wrapper whose agent is `dept-agent`, called in turn `turn-1`.
 * - `judgePrompt`: the arguments of the judge's one model call for the forge of `judgePromptArgs()`. The test output
 *   holds a date, a function and a list with an empty place, which JSON writes as a text, nothing and `null`.
 *
 * The `thrown` values hold no stack text: see `withoutThrownStacks`.
 */
export const PINS: {
  gmiToolMessage: Record<PinOutcome, string>;
  gmiToolResultChunk: Record<PinOutcome, unknown>;
  captureOutput: Record<PinOutcome, unknown>;
  judgePrompt: [model: string, prompt: string];
} = {
  gmiToolMessage: {
    approved:
      '{"success":true,"toolId":"emergent_1794960000000_i",' +
      '"tool":{"id":"emergent_1794960000000_i","name":"add_numbers","description":"Add two numbers.",' +
      '"inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]},' +
      '"outputSchema":{"type":"object","properties":{"sum":{"type":"number"}}},' +
      '"implementation":{"mode":"sandbox","code":"function execute(input) { return { sum: input.a + input.b }; }","allowlist":[]},' +
      '"tier":"session","createdBy":"scripted-persona","createdAt":"2026-11-18T00:00:00.000Z",' +
      '"judgeVerdicts":[{"approved":true,"confidence":0.95,"safety":1,"correctness":1,"determinism":1,"bounded":1,' +
      '"reasoning":"Tool is safe and correct."}],' +
      '"usageStats":{"totalUses":0,"successCount":0,"failureCount":0,"avgExecutionTimeMs":0,"lastUsedAt":null,' +
      '"confidenceScore":0.95},' +
      '"source":"forged by agent scripted-persona during session t1"},' +
      '"verdict":{"approved":true,"confidence":0.95,"safety":1,"correctness":1,"determinism":1,"bounded":1,' +
      '"reasoning":"Tool is safe and correct."}}',
    judge_rejected: TOOL_ERROR + '{"message":"Tool contains unsafe patterns."}',
    code_validation: TOOL_ERROR + '{"message":"Code validation failed: eval() is forbidden"}',
    description_missing: TOOL_ERROR + '{"message":"description is required and must be a string"}',
    thrown:
      TOOL_ERROR +
      '{"message":"Critical unhandled error during the execution of tool \'forge_tool\'.: register failed",' +
      '"details":{"toolName":"forge_tool","errorCode":"TOOL_EXECUTION_FAILED",' +
      '"errorDetailsFromGMIError":{"underlyingError":{"name":"Error","message":"register failed"},' +
      '"toolName":"forge_tool",' +
      '"arguments":{"name":"add_numbers","description":"Add two numbers.",' +
      '"inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]},' +
      '"outputSchema":{"type":"object","properties":{"sum":{"type":"number"}}},' +
      '"implementation":{"mode":"sandbox","code":"function execute(input) { return { sum: input.a + input.b }; }","allowlist":[]},' +
      '"testCases":[{"input":{"a":2,"b":3},"expectedOutput":{"sum":5}},{"input":{"a":1,"b":1},"expectedOutput":{"sum":2}}]}},' +
      '"rawErrorString":"Error: register failed"}}',
  },
  gmiToolResultChunk: {
    approved: {
      toolCallId: 'call_forge',
      name: 'forge_tool',
      result: approvedResult('scripted-persona', 't1'),
      isError: false,
    },
    judge_rejected: failedChunk('Tool contains unsafe patterns.'),
    code_validation: failedChunk('Code validation failed: eval() is forbidden'),
    description_missing: failedChunk('description is required and must be a string'),
    thrown: {
      toolCallId: 'call_forge',
      name: 'forge_tool',
      result: null,
      isError: true,
      errorDetails: {
        message: THROWN_MESSAGE,
        details: {
          toolName: 'forge_tool',
          errorCode: 'TOOL_EXECUTION_FAILED',
          errorDetailsFromGMIError: {
            underlyingError: { name: 'Error', message: 'register failed' },
            toolName: 'forge_tool',
            arguments: ADD_NUMBERS_ARGS,
          },
          rawErrorString: 'Error: register failed',
        },
      },
    },
  },
  captureOutput: {
    approved: approvedResult('dept-agent', 'turn-1'),
    judge_rejected: { success: false, verdict: REJECTED_VERDICT, error: 'Tool contains unsafe patterns.' },
    code_validation: { success: false, error: 'Code validation failed: eval() is forbidden' },
    description_missing: null,
    thrown: null,
  },
  judgePrompt: ['judge-model', `${JUDGE_RUBRIC}\n\n${JUDGE_CANDIDATE}`],
};
