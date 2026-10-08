/**
 * @file approval-gate.ts
 * The tool-approval gate `agency()` installs when `hitl.approvals.beforeTool`
 * is listed. It rides the per-call options as `__approvalGate`; the native
 * tool loops of `generateText` and `streamText` and the prompt-tool shim call
 * it after `onBeforeToolExecution`, on the arguments that hook left. It never
 * throws: a rejection, a handler error, a timeout, a guardrail block and a
 * received gate that threw all skip the tool. A handler error or an
 * `onTimeout: 'error'` timeout is stored in the owner's slot, which `agency()`
 * checks when its strategy settles; the model is told only that the approval
 * handler failed, and the error itself goes to the slot and `on.error`.
 */
import type { AgencyOptions, ApprovalDecision, ApprovalRequest } from '../types.js';
import { AgencyConfigError } from '../types.js';

/**
 * The only value that approves a tool call. A registered symbol, so a gate
 * received from a parent agency loaded from another copy of this module
 * compares equal.
 */
export const APPROVAL_GRANTED: unique symbol = Symbol.for('agentos.approvalGate.approved');

/** What a gate receives: the tool call as the hook left it. */
export interface ApprovalGateInfo {
  /** Tool name. */
  name: string;
  /** Arguments the tool will run with. */
  args: Record<string, unknown>;
  /** Tool call ID from the model (`''` on the prompt-tool path). */
  id: string;
  /** Current step index of the tool loop. */
  step: number;
}

/** A refusal: the tool is skipped and the model is told why. */
export interface ApprovalRefusal {
  skipped: true;
  reason: string;
}

/** The per-call gate function. */
export type ApprovalGateFn = (info: ApprovalGateInfo) => Promise<typeof APPROVAL_GRANTED | ApprovalRefusal>;

/** The first handler error or `'error'` timeout of a call, a seat or a chair, and whether its owner settled. */
export interface ApprovalSlot {
  error?: unknown;
  settled: boolean;
}

/** Creates an empty slot for one call, seat or chair. */
export function createApprovalSlot(): ApprovalSlot {
  return { settled: false };
}

/**
 * The gate a call received from a parent agency: `undefined` when none was
 * passed (the key absent or holding `undefined`, which a forwarding strategy
 * may pass); the function when one was; and, for a value that is present but
 * not a function, a gate that refuses every tool and asks no handler. Fail
 * closed: a forwarded gate can only skip tools, never approve one.
 */
export function composeReceivedGate(value: unknown): ApprovalGateFn | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'function') return value as ApprovalGateFn;
  return async () => refusal('the received approval gate is not a function');
}

const refusal = (reason: string): ApprovalRefusal => ({ skipped: true, reason });

/**
 * What the model is told when the handler fails or an `'error'` timeout
 * fires. Fixed, because an error's message can name a URL or a credential
 * (fetch's for a webhook URL that carries one does), and the refusal reason
 * is sent to the model provider as the tool result.
 */
const HANDLER_FAILED = 'the approval handler failed';

/** Why an approval that names other arguments is refused: the gate approves or refuses, and never applies them. */
const TOOL_ARGS_NOT_APPLIED = 'the arguments the approval names (modifications.toolArgs) are not applied; rewrite them in onBeforeToolExecution';

/** Anything but the exact approval is a refusal; a refusal keeps its own string reason. */
function asVerdict(verdict: unknown, fallback: string): typeof APPROVAL_GRANTED | ApprovalRefusal {
  if (verdict === APPROVAL_GRANTED) return APPROVAL_GRANTED;
  const reason = verdict !== null && typeof verdict === 'object' && typeof (verdict as ApprovalRefusal).reason === 'string'
    ? (verdict as ApprovalRefusal).reason
    : fallback;
  return refusal(reason);
}

function safeCall<T>(fn: ((e: T) => void) | undefined, event: T): void {
  try {
    fn?.(event);
  } catch (err) {
    console.warn('[agentos] agency callback threw:', err);
  }
}

/**
 * Applies `timeoutMs` and `onTimeout` to the HITL handler: resolves with the
 * handler's decision, with an auto-decision on `'approve'` / `'reject'`
 * timeouts, and rejects on `'error'` timeouts or when the handler throws.
 */
export async function resolveApprovalDecision(
  hitlConfig: NonNullable<AgencyOptions['hitl']>,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const timeoutMs = hitlConfig.timeoutMs ?? 30_000;
  const onTimeout = hitlConfig.onTimeout ?? 'reject';
  return await new Promise<ApprovalDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout === 'approve') {
        resolve({ approved: true, reason: 'Auto-approved after HITL timeout' });
        return;
      }
      if (onTimeout === 'error') {
        reject(new AgencyConfigError('HITL approval timed out'));
        return;
      }
      resolve({ approved: false, reason: 'Auto-rejected after HITL timeout' });
    }, timeoutMs);
    // A handler that throws before returning a promise rejects here too, and
    // the timer is cleared either way.
    Promise.resolve()
      .then(() => hitlConfig.handler!(request))
      .then((decision) => {
        clearTimeout(timer);
        resolve(decision);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/** Options of {@link createApprovalGate}. */
export interface CreateApprovalGateOptions {
  /** The agency's HITL config; `approvals.beforeTool` lists the tools it covers. */
  hitl: NonNullable<AgencyOptions['hitl']>;
  /** The name the approval request carries as `agent` (the agency, or a panel seat). */
  agentName: string;
  /** The agency's callbacks; a callback that throws is logged. */
  on: AgencyOptions['on'];
  /** The slot of the call, seat or chair that owns this gate. */
  slot: ApprovalSlot;
  /** A parent agency's gate: it decides first; its refusal is final and its handler is asked first. */
  received?: ApprovalGateFn;
}

/**
 * Builds the gate for one call (or one panel seat or chair). The received
 * gate, if any, decides first; only its exact {@link APPROVAL_GRANTED}
 * approves, anything else (a throw, a refusal, a string) is a refusal and
 * nothing is stored in this slot. Then, for a tool listed in `beforeTool`
 * (or every tool, for `'*'`), the handler is asked through
 * {@link resolveApprovalDecision}; an approved decision runs the post-approval
 * guardrails over the arguments unless `hitl.guardrailOverride` is `false`.
 * An approval that carries `modifications.toolArgs` (anything but `undefined`
 * or `null`) is refused: the gate never applies other arguments, so the call
 * is skipped rather than run with the ones the approver meant to replace.
 * Argument rewriting belongs to `onBeforeToolExecution`, which ran first.
 * Once the slot holds an error (the call will reject) or its owner has
 * settled, the gate skips every tool without asking the handler or firing
 * approval events; after settlement it also drops any later error.
 */
export function createApprovalGate(o: CreateApprovalGateOptions): ApprovalGateFn {
  const listed = o.hitl.approvals?.beforeTool ?? [];
  const covers = (name: string): boolean => listed.includes('*') || listed.includes(name);
  /** The refusal of a gate whose call is over: its owner settled, or an earlier approval failed. */
  const stopped = (): ApprovalRefusal | undefined => {
    if (o.slot.settled) return refusal('the run has settled');
    if (o.slot.error !== undefined) return refusal('an earlier tool approval failed');
    return undefined;
  };
  return async (info) => {
    const early = stopped();
    if (early) return early;
    if (o.received) {
      let verdict: unknown;
      try {
        verdict = await o.received(info);
      } catch (err) {
        console.warn('[agentos] the approval gate received from the parent agency threw:', err);
        return refusal('not approved by the parent agency');
      }
      const parent = asVerdict(verdict, 'not approved by the parent agency');
      if (parent !== APPROVAL_GRANTED) return parent;
    }
    if (!covers(info.name)) return APPROVAL_GRANTED;
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      type: 'tool',
      agent: o.agentName,
      action: info.name,
      description: `Tool "${info.name}" is about to run`,
      details: { tool: info.name, args: info.args, step: info.step, callId: info.id },
      context: { agentCalls: [], totalTokens: 0, totalCostUSD: 0, elapsedMs: 0 },
    };
    safeCall(o.on?.approvalRequested, request);
    let decision: ApprovalDecision;
    try {
      decision = await resolveApprovalDecision(o.hitl, request);
    } catch (err) {
      if (!o.slot.settled) {
        // A rejection with no reason still fails the call.
        if (o.slot.error === undefined) o.slot.error = err === undefined ? new AgencyConfigError('HITL approval failed') : err;
        safeCall(o.on?.error, { agent: o.agentName, error: err instanceof Error ? err : new Error(String(err)), timestamp: Date.now() });
      }
      return refusal(HANDLER_FAILED);
    }
    // A decision that arrives after the call ended (a concurrent approval
    // failed, or the owner settled) fires nothing and runs nothing.
    const late = stopped();
    if (late) return late;
    safeCall(o.on?.approvalDecided, decision);
    if (!decision.approved) return refusal(decision.reason ?? 'rejected by the approval handler');
    // Arguments are rewritten in onBeforeToolExecution, never by a decision:
    // an approval that names other arguments is refused, so the call never
    // runs with the ones the approver meant to replace.
    if (decision.modifications?.toolArgs != null) return refusal(TOOL_ARGS_NOT_APPLIED);
    if (o.hitl.guardrailOverride !== false) {
      const { runPostApprovalGuardrails } = await import('../agency.js');
      const result = await runPostApprovalGuardrails(
        info.name,
        info.args,
        o.hitl.postApprovalGuardrails ?? ['pii-redaction', 'code-safety'],
        o.on,
      );
      // The guardrail check is awaited: a call that ended meanwhile fires nothing.
      const afterGuardrails = stopped();
      if (afterGuardrails) return afterGuardrails;
      if (!result.passed) {
        safeCall(o.on?.guardrailHitlOverride, { guardrailId: result.guardrailId!, reason: result.reason!, toolName: info.name, timestamp: Date.now() });
        return refusal(`guardrail ${result.guardrailId}: ${result.reason}`);
      }
    }
    return stopped() ?? APPROVAL_GRANTED;
  };
}

/**
 * Calls a gate from a tool loop. A gate that throws is a refusal, never a
 * rejected call, and any result but the exact approval is a refusal with a
 * string reason, so a gate passed through unchanged cannot break the loop.
 */
export async function askApprovalGate(gate: ApprovalGateFn, info: ApprovalGateInfo): Promise<typeof APPROVAL_GRANTED | ApprovalRefusal> {
  try {
    return asVerdict(await gate(info), 'not approved by the approval gate');
  } catch (err) {
    console.warn('[agentos] approval gate threw:', err);
    return refusal('the approval gate threw');
  }
}
