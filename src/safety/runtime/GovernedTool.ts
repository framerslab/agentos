/**
 * @module safety/runtime/GovernedTool
 *
 * Turns a tool into a governed tool: a call acts only with evidence the host's store confirms, inside limits counted
 * in a shared store, and with an audit record written before and after. The wrapper mints every id it records and
 * builds every code itself: nothing a model, a tool or a thrown error supplies reaches a record or a log line as it
 * came.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '../../core/tools/ITool.js';
import { listedErrorFields } from '../../core/logging/events.js';
import { SchemaChecks, checkValue } from '../../core/utils/schemaChecks.js';
import { isModerationId } from '../guardrails/ModerationContext.js';
import {
  ACTION_EVIDENCE_SCHEMA, assertEvidenceRule, isActionEvidence, verifyActionEvidence,
  type ActionEvidence, type EvidenceCheck, type EvidenceFailure, type EvidenceRule, type EvidenceSource, type RuleBook,
} from './ActionEvidence.js';
import type { ActionLimitAnswer, ActionLimiter, ActionLimitRule } from './ActionLimiter.js';
import { actionLog } from './actionLog.js';

/** Who acts: an agent (a model's tool loop) or the host's own code. */
export interface ActionActor {
  id: string;
  kind: 'agent' | 'system';
  model?: string;
}

/** How a governed call ended. */
export type ActionOutcome =
  | 'executed' | 'failed' | 'would_execute'
  | 'refused_arguments' | 'voided_evidence' | 'limit_reached' | 'duplicate'
  | 'limiter_unavailable' | 'audit_unavailable';

/** Every code an end may carry. The wrapper builds it; it never copies a code from a result, an error or a store. */
export type ActionEndCode =
  | EvidenceFailure
  | 'ARGUMENT_SHAPE' | 'POLICY_ERROR' | 'TARGET_MISMATCH' | 'LIMIT_SCOPE_MISSING' | 'RETRIES_EXHAUSTED'
  | 'LEASE_EXPIRED' | 'REVERSAL_DROPPED'
  /** The wrapped tool's own `refusalBeforeApproval()` refused the call. */
  | 'TOOL_REFUSED'
  /** The id of one of the governed tool's own limit rules (`policy.limits`), for `limit_reached`. */
  | ActionLimitRule['id'];

/** The audit record of one governed call, written before its action runs. */
export interface ActionAuditRecord {
  /** Minted by the wrapper for this call: `act_` and a random UUID. */
  id: string;
  startedAt: string;
  actor: ActionActor;
  action: string;
  tool: string;
  mode: 'enforce' | 'dryRun';
  target: { accountId?: string; roomId?: string; messageIds: string[] };
  evidence: { ruleId?: string; policyVersion?: string; quotes: EvidenceCheck['quotes']; verdictRefs?: string[] };
  /** The SHA-256, in hex, of the default key or of what `policy.idempotencyKey()` returned. */
  idempotencyKey: string;
  /** What `policy.expiresAt()` returned, read as an instant and written by the library's own `toISOString()`. */
  expiresAt?: string;
  // No tool call id: a provider or a model supplies it, so it is never recorded; `id` is the call's id in the record
  // and in the tool result.
}

/** Where a host writes its audit records. */
export interface ActionAuditSink {
  /** Written before the action runs. A throw refuses the action. */
  begin(record: ActionAuditRecord): Promise<void>;
  /**
   * Written when it has ended. A throw is written as an event; the action's result stands. `reversalRef` is the key
   * the library minted for this call and handed to the tool ({@link GovernedActionIds}), present only when the tool
   * said it filed its reversal record under that key; never a value the tool returned.
   */
  finish(recordId: string, end: { outcome: ActionOutcome; code?: ActionEndCode; reversalRef?: string; endedAt: string }): Promise<void>;
}

/** Ids the library made for one governed call, handed to the tool's own `execute()` beside its usual context. */
export interface GovernedActionIds {
  /** The audit record's id: `act_` and a random UUID. */
  recordId: string;
  /** The key the tool files its reversal record under, when it writes one: `rev_` and a random UUID. */
  reversalRef: string;
}

/** The context a governed tool's own `execute()` receives: the caller's context with `governedAction` added. */
export type GovernedToolContext = ToolExecutionContext & { governedAction: GovernedActionIds };

/** What one governed tool does, about whom, within which limits. */
export interface GovernedToolPolicy<TInput> {
  /** The action kind the audit names: `hold_message`, `mute_in_room`. A word of at most 19 characters, for the reason a rule id is. */
  action: string;
  /** What the tool will act on, read from its own arguments. It must match the evidence. */
  target(args: TInput): { accountId: string; roomId?: string; messageId?: string };
  limits: readonly ActionLimitRule[];
  evidence?: EvidenceRule;
  /**
   * When the action lifts by itself, for the audit record: an instant in the form `YYYY-MM-DDTHH:mm:ss.sssZ`. The
   * record holds the library's own `toISOString()` of it, never the string returned.
   */
  expiresAt?(args: TInput): string | undefined;
  /**
   * What the model receives in a dry run in place of the tool's output. Default `{ dryRun: true }`. Never recorded.
   * When the tool has an `outputSchema`, the answer must meet it, or the call ends `refused_arguments` with
   * `POLICY_ERROR` before anything is reserved.
   */
  dryRunOutput?(args: TInput): unknown;
  /**
   * Default: the actor, action, account, room, unique sorted evidence ids and optional target message. The limiter and the record hold
   * the SHA-256 of the string, never the string.
   */
  idempotencyKey?(args: TInput): string;
}

/** Who acts and with what: the mode, the limiter, the host's store, its rule book and its audit sink. */
export interface ActionGovernance {
  actor: ActionActor;
  mode: 'enforce' | 'dryRun';
  limiter: ActionLimiter;
  evidenceSource: EvidenceSource;
  /** The only policy versions and rule ids a governed call may cite. */
  ruleBook: RuleBook;
  audit: ActionAuditSink;
  /** The clock the audit record's times are read from, in epoch milliseconds. Default `Date.now()`. */
  now?: () => number;
}

type Refusal = Exclude<ActionOutcome, 'executed' | 'would_execute'>;
interface PolicyAnswers {
  target: { accountId: string; roomId?: string; messageId?: string };
  expiresAt?: string;
  keyHash: string;
  dryOutput?: unknown;
}

const WORD_19 = /^[a-z][a-z0-9_]{0,18}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The sentence a refusal carries, one per outcome. Fixed: no argument, code or id is ever part of one. */
const SENTENCES: Record<Refusal, string> = {
  failed: 'The action failed and changed nothing.',
  refused_arguments: 'The action was refused: its arguments are not valid.',
  voided_evidence: 'The action was refused: its evidence could not be confirmed. A person will review it.',
  limit_reached: 'The action was refused: a limit was reached. A person will review it.',
  duplicate: 'The action was refused: it was already taken.',
  limiter_unavailable: 'The action was refused: its limits could not be checked.',
  audit_unavailable: 'The action was refused: it could not be recorded.',
};

/** A dry run's answer is checked as `ToolExecutor` checks a tool's output, with the same options. */
const OUTPUT_CHECKS = new SchemaChecks({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Runs a host's or a limiter's settle step and drops what it throws, whether it throws at once or rejects. */
async function quietly(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // the outcome is already decided; a settle the store did not take is left to the limiter's lease
  }
}

/**
 * The default idempotency key: the actor, action, account, room, unique sorted evidence ids and optional target message.
 *
 * @internal Not exported from the folder's index.
 */
export function defaultIdempotencyKey(actor: ActionActor, action: string, target: { accountId: string; roomId?: string; messageId?: string }, messageIds: readonly string[]): string {
  // Repeating a quote cannot create a fresh operation or reset its retry allowance.
  // Keep the original key format for account actions; message actions also name the message they change.
  return JSON.stringify([
    actor.kind, actor.id, action, target.accountId, target.roomId ?? null, [...new Set(messageIds)].sort(),
    ...(target.messageId !== undefined ? [target.messageId] : []),
  ]);
}

/**
 * The ids the library made for a governed call, read from the context its tool's `execute()` receives.
 *
 * @param context - The context a tool was called with.
 * @returns The ids, when the context is a governed call's; undefined otherwise.
 */
export function governedActionOf(context: ToolExecutionContext | undefined): GovernedActionIds | undefined {
  const ids = (context as Partial<GovernedToolContext> | undefined)?.governedAction;
  return ids !== undefined && ids !== null && typeof ids.recordId === 'string' && typeof ids.reversalRef === 'string' ? ids : undefined;
}

/** The tool's input schema with `evidence` required. */
function withEvidence(schema: JSONSchemaObject | undefined): JSONSchemaObject {
  const base: JSONSchemaObject = schema !== null && typeof schema === 'object' ? schema : {};
  const required: unknown[] = Array.isArray(base.required) ? base.required.filter((name: unknown) => name !== 'evidence') : [];
  return { ...base, type: 'object', properties: { ...(base.properties ?? {}), evidence: ACTION_EVIDENCE_SCHEMA }, required: [...required, 'evidence'] };
}

/**
 * The tool as a governed tool. A call runs, in order: its arguments' shape and the policy's own functions; its
 * evidence against the host's store and rule book; the audit record's first half; one unit under every limit; the
 * action (or, in a dry run, the answer the tool would give); the audit record's second half. Every refusal answers
 * `{ success: false, error, details: { governance: { outcome, code, recordId } } }` with a fixed sentence.
 *
 * @param tool - The tool to govern. Its `execute()` receives the caller's context with `governedAction` added.
 * @param policy - The action's name, its target, its limits and its evidence rule.
 * @param governance - The actor, the mode, the limiter, the store, the rule book and the audit sink.
 * @returns A tool with the same name and members, `hasSideEffects: true`, and `evidence` required in its input.
 * @throws TypeError when the action name or a rule id is not a word of at most 19 characters, or no limit is given.
 */
export function governTool<TInput extends { evidence: ActionEvidence }, TOutput>(
  tool: ITool<TInput, TOutput>,
  policy: GovernedToolPolicy<TInput>,
  governance: ActionGovernance,
): ITool<TInput, TOutput> {
  if (typeof policy.action !== 'string' || !WORD_19.test(policy.action)) throw new TypeError('governTool(): policy.action is a lower-case letter and at most 18 more lower-case letters, digits or underscores');
  if (!Array.isArray(policy.limits) || policy.limits.length === 0) throw new TypeError('governTool(): a governed tool needs at least one limit');
  for (const rule of policy.limits) {
    if (typeof rule.id !== 'string' || !WORD_19.test(rule.id)) throw new TypeError('governTool(): a limit rule id is a lower-case letter and at most 18 more lower-case letters, digits or underscores');
  }
  const limitIds: ReadonlySet<string> = new Set(policy.limits.map((rule) => rule.id));
  const now = governance.now ?? ((): number => Date.now());
  const mode = governance.mode;
  const actor: ActionActor = { id: governance.actor.id, kind: governance.actor.kind, ...(governance.actor.model !== undefined ? { model: governance.actor.model } : {}) };
  const instant = (): string => new Date(now()).toISOString();

  /** One `action.ended` line. */
  const line = (outcome: ActionOutcome, code: ActionEndCode | undefined): void => {
    const fields = { action: policy.action, outcome, ...(code !== undefined ? { code } : {}), mode: mode === 'dryRun' ? 'dry_run' as const : 'enforce' as const };
    if (outcome === 'executed' || outcome === 'would_execute') actionLog.info('action.ended', fields);
    else actionLog.warn('action.ended', fields);
  };
  const governanceOf = (outcome: ActionOutcome, code: ActionEndCode | undefined, recordId: string): { outcome: ActionOutcome; code?: ActionEndCode; recordId: string } =>
    ({ outcome, ...(code !== undefined ? { code } : {}), recordId });
  const refusal = (outcome: Refusal, code: ActionEndCode | undefined, recordId: string): ToolExecutionResult<TOutput> =>
    ({ success: false, error: SENTENCES[outcome], details: { governance: governanceOf(outcome, code, recordId) } });

  /** The record's second half, then the line. A sink that throws is written, and the outcome stands. */
  const finish = async (recordId: string, outcome: ActionOutcome, code: ActionEndCode | undefined, reversalRef?: string): Promise<void> => {
    try {
      await governance.audit.finish(recordId, { outcome, ...(code !== undefined ? { code } : {}), ...(reversalRef !== undefined ? { reversalRef } : {}), endedAt: instant() });
    } catch (error) {
      actionLog.error('action.audit_failed', { action: policy.action, half: 'finish', ...listedErrorFields(error) });
    }
    line(outcome, code);
  };

  /**
   * A refusal before the evidence was confirmed: both halves at once, best effort. The record holds nothing taken
   * from the arguments or from the call's context, because a steered model may have filled any of them with text.
   */
  const refuseEarly = async (recordId: string, startedAt: string, outcome: 'refused_arguments' | 'voided_evidence', code: ActionEndCode): Promise<ToolExecutionResult<TOutput>> => {
    const record: ActionAuditRecord = {
      id: recordId, startedAt, actor, action: policy.action, tool: tool.name, mode,
      target: { messageIds: [] }, evidence: { quotes: [] }, idempotencyKey: sha256(recordId),
    };
    let begun = false;
    try {
      await governance.audit.begin(record);
      begun = true;
    } catch (error) {
      actionLog.error('action.audit_failed', { action: policy.action, half: 'begin', ...listedErrorFields(error) });
    }
    if (begun) await finish(recordId, outcome, code);
    else line(outcome, code);
    return refusal(outcome, code, recordId);
  };

  /** What the policy's own functions answer for a call, or undefined when one throws or answers another shape. */
  const readPolicy = (args: TInput, evidence: ActionEvidence): PolicyAnswers | undefined => {
    try {
      assertEvidenceRule(policy.evidence);
      const target = policy.target(args);
      if (!isModerationId(target?.accountId) || (target.roomId !== undefined && !isModerationId(target.roomId)) || (target.messageId !== undefined && !isModerationId(target.messageId))) return undefined;
      let expiresAt: string | undefined;
      const expires = policy.expiresAt?.(args);
      if (expires !== undefined) {
        // read as an instant of one fixed form and written by the library's own clock code, never as returned
        if (typeof expires !== 'string' || !INSTANT.test(expires) || Number.isNaN(Date.parse(expires))) return undefined;
        expiresAt = new Date(Date.parse(expires)).toISOString();
      }
      const key = policy.idempotencyKey ? policy.idempotencyKey(args) : defaultIdempotencyKey(actor, policy.action, target, evidence.quotes.map((quote) => quote.messageId));
      if (typeof key !== 'string' || key.length === 0) return undefined;
      let dryOutput = mode === 'dryRun' ? (policy.dryRunOutput ? policy.dryRunOutput(args) : { dryRun: true }) : undefined;
      if (dryOutput !== undefined && tool.outputSchema) {
        // an answer the tool's own output schema refuses would end as a failure after the dry run was counted
        const checked = checkValue(OUTPUT_CHECKS.check(tool.outputSchema), dryOutput);
        if (!checked.valid) return undefined;
        dryOutput = checked.value;
      }
      return {
        target: { accountId: target.accountId, ...(target.roomId !== undefined ? { roomId: target.roomId } : {}), ...(target.messageId !== undefined ? { messageId: target.messageId } : {}) },
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        keyHash: sha256(key),
        dryOutput,
      };
    } catch {
      return undefined;
    }
  };

  async function execute(args: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult<TOutput>> {
    const recordId = `act_${randomUUID()}`;
    const startedAt = instant();

    // The caller may retain its arguments across the store and audit awaits. Execute only the copy we check.
    try {
      args = structuredClone(args);
    } catch {
      return refuseEarly(recordId, startedAt, 'refused_arguments', 'ARGUMENT_SHAPE');
    }

    // 1. Arguments: the evidence's shape in code, then the policy's own functions, before anything is reserved.
    const evidence = (args as { evidence?: unknown } | null | undefined)?.evidence;
    if (!isActionEvidence(evidence)) return refuseEarly(recordId, startedAt, 'refused_arguments', 'ARGUMENT_SHAPE');
    const answers = readPolicy(args, evidence);
    if (!answers) return refuseEarly(recordId, startedAt, 'refused_arguments', 'POLICY_ERROR');

    // 2. Evidence: the tool's own target is the evidence's, then the store and the rule book confirm the rest.
    const { target } = answers;
    const sameRoom = (target.roomId ?? null) === (evidence.roomId ?? null);
    const namesQuoted = target.messageId === undefined || evidence.quotes.some((quote) => quote.messageId === target.messageId);
    if (target.accountId !== evidence.targetId || !sameRoom || !namesQuoted) return refuseEarly(recordId, startedAt, 'voided_evidence', 'TARGET_MISMATCH');
    let check: EvidenceCheck;
    try {
      check = await verifyActionEvidence(evidence, governance.evidenceSource, governance.ruleBook, policy.evidence);
    } catch {
      return refuseEarly(recordId, startedAt, 'voided_evidence', 'SOURCE_UNAVAILABLE');
    }
    if (!check.ok) return refuseEarly(recordId, startedAt, 'voided_evidence', check.failure ?? 'SOURCE_UNAVAILABLE');

    // 3. The audit's first half, with the values step 2 confirmed: each equals what the store or the rule book holds,
    // by exact comparison. Nothing is reserved yet, and nothing automatic runs unrecorded.
    const record: ActionAuditRecord = {
      id: recordId, startedAt, actor, action: policy.action, tool: tool.name, mode,
      target: { accountId: evidence.targetId, ...(evidence.roomId !== undefined ? { roomId: evidence.roomId } : {}), messageIds: check.quotes.map((quote) => quote.messageId) },
      evidence: {
        ruleId: evidence.ruleId, policyVersion: evidence.policyVersion, quotes: check.quotes,
        ...(evidence.verdictRefs && evidence.verdictRefs.length > 0 ? { verdictRefs: [...evidence.verdictRefs] } : {}),
      },
      idempotencyKey: answers.keyHash,
      ...(answers.expiresAt !== undefined ? { expiresAt: answers.expiresAt } : {}),
    };
    try {
      await governance.audit.begin(record);
    } catch (error) {
      actionLog.error('action.audit_failed', { action: policy.action, half: 'begin', ...listedErrorFields(error) });
      line('audit_unavailable', undefined);
      return refusal('audit_unavailable', undefined, recordId);
    }

    // 4. The limits: one unit under every rule. From here to the tool's start nothing is awaited but the limiter.
    let answer: ActionLimitAnswer;
    try {
      answer = await governance.limiter.reserve({
        rules: policy.limits,
        target: { accountId: evidence.targetId, ...(evidence.roomId !== undefined ? { roomId: evidence.roomId } : {}) },
        operationId: answers.keyHash,
        dryRun: mode === 'dryRun',
      });
    } catch {
      await finish(recordId, 'limiter_unavailable', undefined);
      return refusal('limiter_unavailable', undefined, recordId);
    }
    if (answer.status === 'denied') {
      const [outcome, code]: [Refusal, ActionEndCode | undefined] =
        answer.reason === 'limit_reached' ? ['limit_reached', answer.ruleId !== undefined && limitIds.has(answer.ruleId) ? answer.ruleId : undefined]
        : answer.reason === 'retries_exhausted' ? ['limit_reached', 'RETRIES_EXHAUSTED']
        : answer.reason === 'unresolvable' ? ['refused_arguments', 'LIMIT_SCOPE_MISSING']
        : ['duplicate', undefined];
      await finish(recordId, outcome, code);
      return refusal(outcome, code, recordId);
    }
    const reserved = answer;
    // The lease is the limiter's, in the process clock's epoch milliseconds. A reservation past it may already be
    // settled by a reconcile pass, and a unit counts from when it was reserved: the action does not start, and the
    // units are given back where they still can be.
    if (reserved.expiresAt !== undefined && Date.now() >= reserved.expiresAt) {
      // the tool never started, so the units go back without taking one of the action's attempts
      await quietly(() => (reserved.cancel ? reserved.cancel() : reserved.release()));
      await finish(recordId, 'limiter_unavailable', 'LEASE_EXPIRED');
      return refusal('limiter_unavailable', 'LEASE_EXPIRED', recordId);
    }

    // 5. The action.
    if (mode === 'dryRun') {
      // counted under the dry keys: a dry run meets the same ceilings and never touches a real count
      await quietly(() => reserved.commit());
      await finish(recordId, 'would_execute', undefined);
      return { success: true, output: answers.dryOutput as TOutput, details: { dryRun: true, governance: governanceOf('would_execute', undefined, recordId) } };
    }
    const reversalRef = `rev_${randomUUID()}`;
    const governed: GovernedToolContext = { ...context, governedAction: { recordId, reversalRef } };
    let result: ToolExecutionResult<TOutput> | undefined;
    const stopRenewal = renewWhileRunning(reserved);
    try {
      result = await tool.execute(args, governed);
    } catch {
      // the thrown value is the tool's: it reaches neither the record, the line nor the model
      result = undefined;
    } finally {
      stopRenewal();
    }
    // Strip returned reversal payloads on both success and failure. Only the minted key may reach the audit.
    const resultDetails = result?.details;
    const returned: Record<string, any> = isPlainRecord(resultDetails) ? resultDetails : {};
    const { reversalRef: returnedKey, reversal: returnedReversal, ...details } = returned;
    const code: ActionEndCode | undefined = returnedKey !== undefined || returnedReversal !== undefined ? 'REVERSAL_DROPPED' : undefined;
    if (result === null || typeof result !== 'object' || result.success !== true) {
      // released and not counted: a governed tool reports failure only when it changed nothing
      await quietly(() => reserved.release());
      await finish(recordId, 'failed', code);
      if (result === null || typeof result !== 'object') return refusal('failed', code, recordId);
      return { ...result, details: { ...details, governance: governanceOf('failed', code, recordId) } };
    }
    // a commit that fails leaves the reservation to its lease, and a reconcile pass counts it
    await quietly(() => reserved.commit());
    await finish(recordId, 'executed', code, details.reversible === true ? reversalRef : undefined);
    return { ...result, details: { ...details, governance: governanceOf('executed', code, recordId) } };
  }

  /**
   * The shape refusal, answered before anyone is asked to approve a call that cannot act, and then the wrapped tool's
   * own refusal. Each is recorded as a governed call that ended `refused_arguments`; the records are written without
   * being waited for, and refuseEarly catches what the sink throws.
   */
  function refusalBeforeApproval(args: Record<string, any>, context: ToolExecutionContext): ToolExecutionResult<TOutput> | undefined {
    if (!isActionEvidence(args?.evidence)) {
      const recordId = `act_${randomUUID()}`;
      void refuseEarly(recordId, instant(), 'refused_arguments', 'ARGUMENT_SHAPE').catch(() => undefined);
      return refusal('refused_arguments', 'ARGUMENT_SHAPE', recordId);
    }
    const own = tool.refusalBeforeApproval?.(args, context);
    // only a failure is a refusal; the orchestrator gates any other answer as it would no answer
    if (!own || own.success !== false) return own;
    const recordId = `act_${randomUUID()}`;
    void refuseEarly(recordId, instant(), 'refused_arguments', 'TOOL_REFUSED').catch(() => undefined);
    // as for a failed result: a key or a reversal the tool returns is not passed on
    const details: Record<string, any> = isPlainRecord(own.details) ? { ...own.details } : {};
    delete details.reversalRef;
    delete details.reversal;
    return { ...own, details: { ...details, governance: governanceOf('refused_arguments', 'TOOL_REFUSED', recordId) } };
  }

  // A plain object whose members are all its own, so a host can spread it. The members of the tool are named one by
  // one because a class instance keeps its methods and getters on its prototype.
  return {
    ...tool,
    id: tool.id,
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.requiredCapabilities !== undefined ? { requiredCapabilities: tool.requiredCapabilities } : {}),
    ...(tool.category !== undefined ? { category: tool.category } : {}),
    ...(tool.version !== undefined ? { version: tool.version } : {}),
    ...(typeof tool.validateArgs === 'function' ? { validateArgs: (args: Record<string, any>) => tool.validateArgs!(args) } : {}),
    ...(typeof tool.shutdown === 'function' ? { shutdown: () => tool.shutdown!() } : {}),
    hasSideEffects: true,
    inputSchema: withEvidence(tool.inputSchema),
    execute,
    refusalBeforeApproval,
  };
}

/**
 * Renews a reservation's lease three times a lease while its tool runs, so a reconcile pass does not count as used an
 * action that is still running and may yet fail. A renewal that fails is dropped: the next one tries again, and a lease
 * that runs out is counted, the cautious reading. A limiter without `renew()` or without a lease is not renewed.
 *
 * @returns The function that stops the renewals.
 */
function renewWhileRunning(reserved: Extract<ActionLimitAnswer, { status: 'reserved' }>): () => void {
  if (typeof reserved.renew !== 'function' || reserved.expiresAt === undefined || !Number.isFinite(reserved.expiresAt)) return () => undefined;
  const every = Math.max(50, Math.floor((reserved.expiresAt - Date.now()) / 3));
  const timer = setInterval(() => { void quietly(() => reserved.renew?.()); }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Whether a value is an object a tool's `details` may be read from. */
function isPlainRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
