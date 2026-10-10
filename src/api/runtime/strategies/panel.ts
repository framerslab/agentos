/**
 * @file panel.ts
 * The `panel` strategy: every seated seat answers the same prompt on its own
 * model, under a deadline and a concurrency cap; each seat gets one status;
 * healthy seats are counted against a quorum of seats, providers and
 * vendors; a chair synthesizes, or `chair: false` returns the seats'
 * outputs under their names. Compiled per call with the seating result.
 */
import { agent as createAgent } from '../agent.js';
import type {
  AgencyOptions,
  AgencyStreamPart,
  Agent,
  AgentCallRecord,
  CompiledStrategy,
  PanelLedger,
  PanelQuorumRecord,
  PanelSeatRecord,
  SeatingSeatRecord,
} from '../types.js';
import { AgencyConfigError, AgencyPanelError, AgencyQuorumError } from '../types.js';
import type { FallbackSignal } from '../generateText.js';
import {
  isAgent,
  mergeDefaults,
  checkBeforeAgent,
  accumulateExtraUsage,
  buildAgentCallUsage,
  callRecordExtras,
} from './shared.js';
import type { SeatedRoster, SeatedConfig } from '../pool/seating.js';
import { vendorOf, makerOfHostedModel, isHostProvider } from '../pool/vendor.js';
import {
  createApprovalGate,
  createApprovalSlot,
  composeReceivedGate,
  type ApprovalGateFn,
  type ApprovalSlot,
} from '../approval-gate.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type UsageSnapshot = Parameters<typeof buildAgentCallUsage>[0];

type Callbacks = NonNullable<AgencyOptions['on']>;

type Notify = (event: unknown) => void;

/** How one call of a seat or the chair ended. */
type Outcome =
  | { kind: 'returned'; result: Record<string, unknown>; durationMs: number }
  | { kind: 'threw'; error: unknown; durationMs: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'rejected'; reason: string; durationMs: number }
  | { kind: 'error'; message: string; durationMs: number };

/** What a call that returned says about who answered it, and with what. */
interface Answered {
  provider?: string;
  model?: string;
  responseModel?: string;
  substituted?: true;
  vendor?: string;
  finishReason?: string;
  text: string;
  usage: AgentCallRecord['usage'];
  fallback?: FallbackSignal;
}

const CHAIR_FRAME =
  'You are the chair of a panel. Several seats answered the same task independently; their answers follow, each under its seat name. ' +
  "Synthesize them into one answer for the task. Do not mention the seats' models or vendors.";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

const textOf = (result: Record<string, unknown>): string => (typeof result.text === 'string' ? result.text : '');

const nonWhitespace = (text: string): number => text.replace(/\s/g, '').length;

const usageOf = (value: unknown): UsageSnapshot => (isRecord(value) ? (value as NonNullable<UsageSnapshot>) : undefined);

const isFallbackSignal = (value: unknown): value is FallbackSignal =>
  isRecord(value) && typeof value.fired === 'boolean';

/** A property of a thrown value, read without throwing. */
function readProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The message of a thrown value, as a string. */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  const message = readProperty(error, 'message');
  if (typeof message === 'string') return message;
  try {
    return String(error);
  } catch {
    return 'error';
  }
}

/**
 * The redacted message and stack of what a seat, the chair or a gate's
 * handler threw. Each is read as a string and passed through the call's
 * mask, so the thrown object is never written: a handler's error belongs to
 * the caller, and a pre-built seat's to that seat.
 */
function maskedText(error: unknown, mask: (error: unknown) => unknown): { message: string; stack?: string } {
  const redact = (text: string): string => {
    const masked = mask(text);
    return typeof masked === 'string' ? masked : '[redacted]';
  };
  const stack = readProperty(error, 'stack');
  return { message: redact(messageOf(error)), ...(typeof stack === 'string' ? { stack: redact(stack) } : {}) };
}

/** A new Error with only the redacted message and stack: never the thrown object, its `details` or its `cause`. */
function freshError(error: unknown, mask: (error: unknown) => unknown): Error {
  const { message, stack } = maskedText(error, mask);
  const out = new Error(message);
  if (stack !== undefined) out.stack = stack;
  return out;
}

/**
 * The callbacks the panel and its gates fire. Each runs inside a try/catch,
 * so a callback that throws is logged and changes no status, and every
 * `error` event carries a new Error built from the redacted message and stack.
 */
function panelCallbacks(on: AgencyOptions['on'], mask: (error: unknown) => unknown): Callbacks {
  const out: Record<string, Notify> = {};
  for (const [name, fn] of Object.entries(on ?? {})) {
    if (typeof fn !== 'function') continue;
    out[name] = (event: unknown) => {
      try {
        const payload =
          name === 'error' && isRecord(event) ? { ...event, error: freshError(event.error, mask) } : event;
        (fn as Notify).call(on, payload);
      } catch (err) {
        console.warn(`[AgentOS][Panel] ${name} callback threw:`, err);
      }
    };
  }
  return out as Callbacks;
}

/** The callbacks a seat's or the chair's gates fire: dropped, not caught, once that seat has settled. */
function droppedOnceSettled(on: Callbacks, settled: () => boolean): Callbacks {
  const out: Record<string, Notify> = {};
  for (const [name, fn] of Object.entries(on)) {
    out[name] = (event: unknown) => {
      if (!settled()) (fn as Notify)(event);
    };
  }
  return out as Callbacks;
}

/** Races `work` against a deadline; with none, waits for it. A late settlement is swallowed. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number | undefined,
): Promise<{ timedOut: true } | { timedOut: false; value: T } | { timedOut: false; error: unknown }> {
  const settled = work.then(
    (value) => ({ timedOut: false as const, value }),
    (error: unknown) => ({ timedOut: false as const, error }),
  );
  if (ms === undefined) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A counting semaphore for `panel.concurrency`. A release hands its slot straight to the next waiter. */
function semaphore(limit: number): { acquire(): Promise<void>; release(): void } {
  let running = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (running < limit) {
        running++;
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else running--;
    },
  };
}

/** A seat record without the keys whose value is undefined. */
function seatRecord(fields: PanelSeatRecord): PanelSeatRecord {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out as unknown as PanelSeatRecord;
}

/**
 * The vendor of the model that answered a config seat or the chair. After a
 * hop of its own chain, the answering leg's: read with the hop's declared
 * vendor and the URL the resolver wrote for it, never carried over from the
 * primary. Then, on a host, the maker a prefixed reported model names
 * replaces it, a declared vendor included.
 */
function answeredVendor(
  cfg: SeatedConfig,
  assigned: string | undefined,
  provider: string | undefined,
  model: string | undefined,
  responseModel: string | undefined,
  fallback: FallbackSignal | undefined,
): string | undefined {
  let vendor = assigned;
  if (fallback?.fired && provider && model) {
    const hop = cfg.fallbackProviders?.find(
      (h) => h.provider === provider && (h.model === undefined || h.model === model || h.model === `${provider}:${model}`),
    );
    vendor = vendorOf(provider, model, { vendor: hop?.vendor, baseUrl: hop?.baseUrl });
  }
  if (provider && responseModel && isHostProvider(provider)) vendor = makerOfHostedModel(responseModel) ?? vendor;
  return vendor;
}

/**
 * Who answered a call that returned, on what, with what text and usage. A
 * pre-built seat (no `cfg`) has no vendor: the agency cannot see what it runs on.
 */
function answeredBy(
  result: Record<string, unknown>,
  cfg: SeatedConfig | undefined,
  assigned: SeatingSeatRecord | undefined,
): Answered {
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const provider = str(result.provider) ?? assigned?.provider;
  const model = str(result.model) ?? assigned?.model;
  const responseModel = str(result.responseModel);
  const fallback = isFallbackSignal(result.fallback) ? result.fallback : undefined;
  // Substituted: the provider answered from another model than the one asked for, neither id a prefix of the other.
  const substituted =
    responseModel !== undefined && model !== undefined && !responseModel.startsWith(model) && !model.startsWith(responseModel);
  return {
    provider,
    model,
    responseModel,
    ...(substituted ? { substituted: true as const } : {}),
    vendor: cfg ? answeredVendor(cfg, assigned?.vendor, provider, model, responseModel, fallback) : undefined,
    finishReason: typeof result.finishReason === 'string' ? result.finishReason : undefined,
    text: textOf(result),
    usage: buildAgentCallUsage(usageOf(result.usage)),
    // Present when the seat's chain fired.
    ...(fallback?.fired ? { fallback } : {}),
  };
}

/**
 * Compiles the `panel` strategy over one call's seating. Every seat answers
 * the same prompt on its own model. A seat takes a slot (`panel.concurrency`,
 * default all), passes its `beforeAgent` gate and calls its model under
 * `panel.seatDeadlineMs`; it ends `ok`, `empty`, `error`, `timeout`,
 * `rejected` or `unseated`. Healthy seats (`ok`) are counted against the
 * quorum; the chair synthesizes them, or with `chair: false` the result's
 * text is their outputs under their names. Each seat and the chair run with
 * a tool-approval gate and a slot of their own, wrapping a gate received
 * from a parent agency.
 *
 * @param agents - The seated roster: seated copies of the config seats, and
 *   the pre-built seats as they are; an unseated seat is absent.
 * @param agencyConfig - The agency options as they stand at call time.
 * @param seating - The call's seating: its record, the seated chair, the
 *   chair's line and the call's error mask. Undefined at the construction-time
 *   compile, which gives a strategy that refuses to run; a panel is compiled
 *   again for every call.
 * @returns A compiled strategy whose `execute` resolves with the text,
 *   `seats`, `chair`, `quorum`, `seating`, `agentCalls` and `usage`, and
 *   rejects with {@link AgencyQuorumError} or {@link AgencyPanelError}
 *   carrying the ledger; `stream` resolves its `result` with the same.
 */
export function compilePanel(
  agents: Record<string, SeatedConfig | Agent>,
  agencyConfig: AgencyOptions,
  seating: SeatedRoster | undefined,
): CompiledStrategy {
  if (!seating) {
    return {
      execute: async () => {
        throw new AgencyConfigError('panel: no seating for this call');
      },
      stream: () => {
        throw new AgencyConfigError('panel: no seating for this call');
      },
    };
  }
  const panelOpts = agencyConfig.panel ?? {};
  const minChars = panelOpts.minChars ?? 1;
  const seatDeadlineMs = panelOpts.seatDeadlineMs;
  const chairDeadlineMs = panelOpts.chairDeadlineMs ?? seatDeadlineMs;
  const mask = seating.mask;
  const on = panelCallbacks(agencyConfig.on, mask);
  const gateEnabled = (agencyConfig.hitl?.approvals?.beforeTool?.length ?? 0) > 0;
  const redacted = (error: unknown): string => maskedText(error, mask).message;

  const run = async (prompt: string, opts: Record<string, unknown> | undefined): Promise<Record<string, unknown>> => {
    const seatedChair = seating.chair;
    if (seatedChair === undefined) throw new AgencyConfigError('panel: the seating for this call seated no chair');
    const callOpts: Record<string, unknown> = { ...opts };
    // A parent agency's gate: each seat's and the chair's own gate wraps it,
    // so the handler is asked once per tool call.
    const received = composeReceivedGate(callOpts.__approvalGate);
    delete callOpts.__approvalGate;
    const requested = callOpts.requestTimeout;
    const callTimeout = typeof requested === 'number' ? requested : undefined;
    const sem = semaphore(panelOpts.concurrency ?? Number.POSITIVE_INFINITY);
    const seatNames = Object.keys(agencyConfig.agents);
    const records = new Map<string, PanelSeatRecord>();
    // Empty while the seats run, so no gate sees a sibling's record; filled
    // in roster order after the fan-out, as parallel builds its records.
    const agentCalls: AgentCallRecord[] = [];
    const callRecords = new Map<string, AgentCallRecord>();
    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const addUsage = (value: unknown): void => {
      const call = usageOf(value);
      if (!call) return;
      usage.promptTokens += call.promptTokens ?? 0;
      usage.completionTokens += call.completionTokens ?? 0;
      usage.totalTokens += call.totalTokens ?? 0;
      accumulateExtraUsage(usage, call);
    };
    const ledger = (quorum?: PanelQuorumRecord): PanelLedger => ({
      seats: seatNames.map((n) => records.get(n)).filter((r): r is PanelSeatRecord => r !== undefined),
      seating: seating.record,
      ...(quorum ? { quorum } : {}),
      usage: { ...usage },
    });

    /** The tool gate of a seat or the chair: its own, wrapping the received one; else the received one; else none. */
    const gateFor = (owner: string, slot: ApprovalSlot, ownerOn: Callbacks): ApprovalGateFn | undefined =>
      gateEnabled && agencyConfig.hitl
        ? createApprovalGate({ hitl: agencyConfig.hitl, agentName: owner, on: ownerOn, slot, received })
        : received;

    /** Runs one seat or the chair: its `beforeAgent` gate, then its model call, under its deadline. */
    const runAgent = async (
      owner: string,
      target: SeatedConfig | Agent,
      input: string,
      deadlineMs: number | undefined,
      slot: ApprovalSlot,
    ): Promise<Outcome> => {
      const started = Date.now();
      const elapsed = (): number => Date.now() - started;
      const remaining = (): number | undefined =>
        deadlineMs === undefined ? undefined : Math.max(0, deadlineMs - elapsed());
      // Once this seat has settled, the notifications of its gates are dropped.
      const ownerOn = droppedOnceSettled(on, () => slot.settled);
      // An async boundary of its own: a generate that throws synchronously
      // rejects this promise, and cannot escape the seat or keep its slot.
      const work = (async (): Promise<Outcome> => {
        const decision = await checkBeforeAgent(owner, input, agentCalls.slice(), { ...agencyConfig, on: ownerOn });
        if (decision && !decision.approved) {
          return { kind: 'rejected', reason: decision.reason ?? 'rejected by HITL', durationMs: elapsed() };
        }
        // No model call starts after the seat has settled.
        const left = remaining();
        if (slot.settled || left === 0) return { kind: 'timeout', durationMs: elapsed() };
        const effective = decision?.modifications?.instructions
          ? `${input}\n\n[Additional instructions]: ${decision.modifications.instructions}`
          : input;
        const cfg = isAgent(target) ? undefined : target;
        // A call with no chain of its own cannot be answered while its
        // provider's breaker is open. A chain walks past an open provider.
        if (cfg?.provider && !cfg.fallbackProviders?.length && globalLLMProviderHealth.isOpen(cfg.provider)) {
          return { kind: 'error', message: 'circuit open', durationMs: elapsed() };
        }
        // Every seated config passes through mergeDefaults, the chair included:
        // agency-level tools reach the seats, and the seated config's own
        // provider, model, key and URL (undefined included) win the spread.
        const instance: Agent = isAgent(target) ? target : createAgent({ ...mergeDefaults(target, agencyConfig) });
        const bounds = [left, cfg?.controls?.maxDurationMs, callTimeout].filter((b): b is number => typeof b === 'number');
        const requestTimeout = bounds.length > 0 ? Math.min(...bounds) : undefined;
        const agentOpts: Record<string, unknown> = { ...callOpts };
        const gate = gateFor(owner, slot, ownerOn);
        if (gate) agentOpts.__approvalGate = gate;
        if (requestTimeout !== undefined) agentOpts.requestTimeout = requestTimeout;
        // Our deadline is the smallest bound: a timeout then says nothing about
        // the provider, and the flag keeps it off the breaker. A received flag
        // rides on only with the received requestTimeout it was set for.
        if (left !== undefined && requestTimeout === left) agentOpts.__panelDeadline = true;
        else if (requestTimeout !== callTimeout) delete agentOpts.__panelDeadline;
        on.agentStart?.({ agent: owner, input: effective, timestamp: Date.now() });
        const result = await instance.generate(effective, agentOpts);
        return { kind: 'returned', result: isRecord(result) ? result : {}, durationMs: elapsed() };
      })();
      work.catch(() => undefined);
      const raced = await withDeadline(work, remaining());
      if (raced.timedOut) {
        // Settled first: from here on the seat's gates drop their notifications and skip every tool.
        slot.settled = true;
        return { kind: 'timeout', durationMs: elapsed() };
      }
      if ('error' in raced) return { kind: 'threw', error: raced.error, durationMs: elapsed() };
      return raced.value;
    };

    /** A seat's tool calls for its call record, every tool error passed through the call's mask. */
    const toolCallsOf = (value: unknown): AgentCallRecord['toolCalls'] =>
      (Array.isArray(value) ? (value as AgentCallRecord['toolCalls']) : []).map((t) =>
        isRecord(t) && typeof t.error === 'string' ? { ...t, error: redacted(t.error) } : t,
      );

    /** The record of a seat whose call ended, and the callbacks its status fires. */
    const settleSeat = (
      name: string,
      cfg: SeatedConfig | undefined,
      assigned: SeatingSeatRecord | undefined,
      outcome: Outcome,
      slot: ApprovalSlot,
    ): PanelSeatRecord => {
      const base = { seat: name, entry: assigned?.entry, provider: cfg?.provider, model: cfg?.model, vendor: cfg ? assigned?.vendor : undefined };
      const { durationMs } = outcome;
      if (outcome.kind === 'returned') {
        const answered = answeredBy(outcome.result, cfg, assigned);
        // A tool approval that failed during the call makes the seat an error,
        // whatever text it returned. The gate reported that error to on.error.
        const failed = slot.error !== undefined;
        const status: PanelSeatRecord['status'] = failed ? 'error' : nonWhitespace(answered.text) >= minChars ? 'ok' : 'empty';
        addUsage(outcome.result.usage);
        callRecords.set(name, {
          agent: name,
          input: prompt,
          output: answered.text,
          toolCalls: toolCallsOf(outcome.result.toolCalls),
          usage: answered.usage,
          durationMs,
          ...callRecordExtras({ provider: answered.provider, model: answered.model, finishReason: answered.finishReason, fallback: outcome.result.fallback }),
        });
        if (!failed) on.agentEnd?.({ agent: name, output: answered.text, durationMs, timestamp: Date.now() });
        return seatRecord({
          ...base,
          ...answered,
          status,
          truncated: status === 'ok' && (answered.finishReason === 'length' || answered.finishReason === 'tool-calls') ? true : undefined,
          durationMs,
          error: failed ? redacted(slot.error) : undefined,
        });
      }
      if (outcome.kind === 'threw') {
        on.error?.({ agent: name, error: freshError(outcome.error, mask), timestamp: Date.now() });
        return seatRecord({ ...base, status: 'error', text: '', durationMs, error: redacted(outcome.error) });
      }
      if (outcome.kind === 'timeout') {
        const error = `seat "${name}" timed out after ${seatDeadlineMs}ms`;
        on.error?.({ agent: name, error: new Error(error), timestamp: Date.now() });
        return seatRecord({ ...base, status: 'timeout', text: '', durationMs, error });
      }
      if (outcome.kind === 'error') {
        on.error?.({ agent: name, error: new Error(outcome.message), timestamp: Date.now() });
        return seatRecord({ ...base, status: 'error', text: '', durationMs, error: outcome.message });
      }
      // Rejected by the beforeAgent gate, which fired its own approval events.
      return seatRecord({ ...base, status: 'rejected', text: '', durationMs, error: redacted(outcome.reason) });
    };

    // ---- seats ----
    await Promise.all(
      seatNames.map(async (name) => {
        const assigned: SeatingSeatRecord | undefined = seating.record.seats[name];
        const seat: SeatedConfig | Agent | undefined = agents[name];
        if (assigned?.unseated || seat === undefined) {
          records.set(name, seatRecord({ seat: name, status: 'unseated', text: '', durationMs: 0, error: assigned?.reason ?? 'not seated' }));
          return;
        }
        // The deadline starts when the seat takes its slot, and the slot is
        // given up when the seat settles, a timed-out call included.
        await sem.acquire();
        const slot = createApprovalSlot();
        let outcome: Outcome;
        try {
          outcome = await runAgent(name, seat, prompt, seatDeadlineMs, slot);
        } finally {
          slot.settled = true;
          sem.release();
        }
        records.set(name, settleSeat(name, isAgent(seat) ? undefined : seat, assigned, outcome, slot));
      }),
    );
    for (const n of seatNames) {
      const c = callRecords.get(n);
      if (c) agentCalls.push(c);
    }

    // ---- quorum ----
    const seats = seatNames.map((n) => records.get(n)).filter((r): r is PanelSeatRecord => r !== undefined);
    const healthy = seats.filter((s) => s.status === 'ok');
    const providers = [...new Set(healthy.map((s) => s.provider).filter((p): p is string => !!p))];
    const vendors = [...new Set(healthy.map((s) => s.vendor).filter((v): v is string => !!v))];
    const q = agencyConfig.quorum ?? {};
    // Under panel the floor is two seats for a roster of two or more, quorum set or not.
    const minAgents = q.minAgents ?? (seatNames.length >= 2 ? 2 : 0);
    const shortfalls: string[] = [];
    if (healthy.length === 0) shortfalls.push(`no seat returned text (0/${seatNames.length} healthy)`);
    else if (healthy.length < minAgents) shortfalls.push(`${healthy.length}/${seatNames.length} seats healthy (need ${minAgents})`);
    if ((q.minProviders ?? 0) > providers.length) shortfalls.push(`${providers.length} distinct providers (need ${q.minProviders})`);
    if ((q.minVendors ?? 0) > vendors.length) shortfalls.push(`${vendors.length} distinct vendors (need ${q.minVendors})`);
    const quorum: PanelQuorumRecord = {
      met: shortfalls.length === 0,
      healthy: healthy.length,
      providers,
      vendors,
      ...(shortfalls.length > 0 ? { shortfall: `panel quorum shortfall: ${shortfalls.join(', ')}` } : {}),
    };
    if (!quorum.met) {
      // Zero healthy seats always throws, whatever onShortfall says.
      if (healthy.length === 0 || (q.onShortfall ?? 'error') === 'error') {
        throw new AgencyQuorumError(quorum.shortfall ?? 'panel quorum shortfall', ledger(quorum));
      }
      console.warn(`[AgentOS][Panel] ${quorum.shortfall}: proceeding (onShortfall=proceed)`);
    }

    // ---- chair ----
    const block = healthy.map((s) => `--- ${s.seat} ---\n${s.text}`).join('\n\n');
    if (seatedChair === false) {
      return { text: block, seats, quorum, seating: seating.record, agentCalls, usage };
    }
    const chairCfg: SeatedConfig = {
      ...seatedChair,
      instructions: `${CHAIR_FRAME}\n\n${seatedChair.instructions ?? agencyConfig.instructions ?? ''}`.trim(),
      maxSteps: 1,
    };
    // The task and the healthy seats' outputs under their names: no model or vendor name reaches the chair.
    const chairInput = `The task:\n"${prompt}"\n\n${block}`;
    const chairSlot = createApprovalSlot();
    let chairOutcome: Outcome;
    try {
      chairOutcome = await runAgent('chair', chairCfg, chairInput, chairDeadlineMs, chairSlot);
    } finally {
      chairSlot.settled = true;
    }
    if (chairOutcome.kind !== 'returned') {
      const reason =
        chairOutcome.kind === 'threw' ? redacted(chairOutcome.error)
        : chairOutcome.kind === 'timeout' ? `chair timed out after ${chairDeadlineMs}ms`
        : chairOutcome.kind === 'rejected' ? redacted(chairOutcome.reason)
        : chairOutcome.message;
      throw new AgencyPanelError(`panel chair failed: ${reason}`, ledger(quorum));
    }
    // The chair's call returned, so its usage is billed even when it fails below.
    addUsage(chairOutcome.result.usage);
    if (chairSlot.error !== undefined) {
      throw new AgencyPanelError(`panel chair failed: ${redacted(chairSlot.error)}`, ledger(quorum));
    }
    // The chair's line from seating: the entry `from` seated it on, and that entry's vendor.
    const chairLine = seating.chairSeat;
    const answered = answeredBy(chairOutcome.result, chairCfg, chairLine);
    if (nonWhitespace(answered.text) === 0) throw new AgencyPanelError('panel chair returned no text', ledger(quorum));
    const chair = seatRecord({
      seat: 'chair',
      entry: chairLine?.entry,
      ...answered,
      status: 'ok',
      truncated: answered.finishReason === 'length' || answered.finishReason === 'tool-calls' ? true : undefined,
      durationMs: chairOutcome.durationMs,
    });
    on.agentEnd?.({ agent: 'chair', output: answered.text, durationMs: chairOutcome.durationMs, timestamp: Date.now() });
    return {
      text: answered.text,
      seats,
      chair,
      quorum,
      seating: seating.record,
      agentCalls,
      usage,
      provider: chair.provider,
      model: chair.model,
      finishReason: chair.finishReason,
    };
  };

  return {
    execute(prompt, opts) {
      return run(prompt, opts);
    },

    /**
     * Runs the panel as `execute` does and yields the final text as one
     * chunk, as `parallel` does. Before it, one error part per seat recorded
     * `error` or `timeout`, naming the seat, so a stream does not drop a
     * failed seat's error; a run that fails yields those of its ledger and
     * then throws.
     */
    stream(prompt, opts) {
      const resultPromise = run(prompt, opts);
      // Every member below derives from the run; each is marked handled, so a
      // caller that reads only some of them leaves no rejection unhandled.
      const handled = <T>(promise: Promise<T>): Promise<T> => {
        promise.catch(() => undefined);
        return promise;
      };
      handled(resultPromise);
      const textPromise = handled(resultPromise.then(textOf));
      // Built from the redacted message the seat's record holds.
      const seatErrors = (seats: unknown): AgencyStreamPart[] =>
        (Array.isArray(seats) ? seats : [])
          .filter((s): s is PanelSeatRecord => isRecord(s) && (s.status === 'error' || s.status === 'timeout'))
          .map((s) => ({ type: 'error' as const, error: new Error(s.error ?? `seat "${s.seat}" failed`), agent: s.seat }));
      return {
        textStream: (async function* () {
          yield await textPromise;
        })(),
        fullStream: (async function* (): AsyncGenerator<AgencyStreamPart> {
          let result: Record<string, unknown>;
          try {
            result = await resultPromise;
          } catch (error) {
            yield* seatErrors(readProperty(error, 'seats'));
            throw error;
          }
          yield* seatErrors(result.seats);
          yield { type: 'text', text: textOf(result) };
        })(),
        text: textPromise,
        usage: handled(resultPromise.then((r) => r.usage as Usage)),
        agentCalls: handled(resultPromise.then((r) => (Array.isArray(r.agentCalls) ? (r.agentCalls as AgentCallRecord[]) : []))),
        result: resultPromise,
      };
    },
  };
}
