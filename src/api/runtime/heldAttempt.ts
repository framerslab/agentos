/**
 * @file heldAttempt.ts
 * The completion gateway attempts of a gmi() turn checked against the turn's spend budget: an attempt the budget
 * refused, which sends nothing, and an attempt held in the budget's spend meter from before its request is sent until
 * it ends.
 */
import type { ModelCompletionResponse } from '../../core/llm/providers/IProvider.js';
import { reportLateUsage, type CompletionAttempt, type CompletionOutcome, type LateAttemptUsage } from './completionGateway.js';
import { holdCall, type CallEnd, type CallHold, type HeldCallOptions, type HelperCall, type SpendBudget } from './spendBudget.js';

/** How an attempt the budget refused ends: its hop fails with no retry, so the GMI ends the turn with the refusal. */
function refusedOutcome(refusal: unknown): CompletionOutcome {
  return { kind: 'hopFailed', error: refusal instanceof Error ? refusal : new Error(String(refusal)), retryable: false };
}

/**
 * An attempt the turn's budget refused: it sends no request and fails its hop with no retry, so the GMI ends the
 * turn (`LLM_PROVIDER_ERROR`, the budget's message) without trying a fallback hop.
 */
export function refusedAttempt(refusal: unknown): CompletionAttempt {
  return {
    async *[Symbol.asyncIterator]() {
      // Nothing is sent.
    },
    outcome: Promise.resolve(refusedOutcome(refusal)),
  };
}

/** What a held attempt saw of its chunks: the last usage, whether output came, and the error chunk that ended it. */
interface Seen {
  usage: unknown;
  output: boolean;
  failure?: { error: unknown; afterOutput: boolean };
}

/**
 * How a held attempt ended, which decides its settle. An error chunk the gateway passed on came after output; an
 * attempt the gateway failed before any output says so in its outcome, with the usage its bill reported; one whose
 * reader stopped reading was left, at whatever usage it had reported.
 */
async function endOf(attempt: CompletionAttempt, finished: boolean, seen: Seen): Promise<CallEnd> {
  if (seen.failure) return { kind: 'failed', ...seen.failure, usage: seen.usage };
  if (!finished) return { kind: 'left', usage: seen.usage };
  const outcome = await attempt.outcome;
  if (outcome.kind === 'hopFailed') return { kind: 'failed', error: outcome.error, afterOutput: false, usage: outcome.usage ?? seen.usage };
  if (outcome.kind === 'abandoned') return { kind: 'left', usage: seen.usage };
  return { kind: 'completed', usage: seen.usage };
}

/**
 * An attempt of a call on a budget that holds its calls in a spend meter. Before `send` makes the gateway's attempt,
 * the call's largest cost is reserved in the meter under an operation id of its own ({@link holdCall}); a refusal
 * sends nothing and fails the hop with no retry, as {@link refusedAttempt} does, and a stop that came while the
 * reservation was made frees it, the gateway then ending the attempt as stopped without sending it. The reservation
 * settles by how the attempt ended, as the generation helpers settle theirs: at the usage its chunks reported when it
 * delivered; by its outcome's error and bill when the gateway failed it before any output (freed when the provider
 * refused it, held when it may have been billed); at its usage, or held until a reconcile decides from evidence, when
 * an error chunk ended it after output or its reader stopped reading. Usage the provider reports after the attempt was
 * stopped goes to the hold, which settles a held reservation at it, and then to `onLateUsage` as the gateway hands it.
 *
 * @param budget - The turn's budget.
 * @param call - The attempt's call, as the budget holds it.
 * @param send - Makes the gateway's attempt with the options to give the provider (the attempt report, and the operation
 *   id the reservation is under, which the provider sends in its operation id header) and the late-usage listener.
 * @param onLateUsage - The turn's own late-usage listener.
 */
export function heldAttempt(
  budget: SpendBudget,
  call: HelperCall,
  send: (held: HeldCallOptions, onLateUsage: (report: LateAttemptUsage) => void) => CompletionAttempt,
  onLateUsage: ((report: LateAttemptUsage) => void) | undefined,
): CompletionAttempt {
  let inner: CompletionAttempt | undefined;
  let finish!: (outcome: CompletionOutcome) => void;
  const outcome = new Promise<CompletionOutcome>((resolve) => {
    finish = resolve;
  });

  async function* run(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    let hold: CallHold | undefined;
    try {
      hold = await holdCall(budget, call);
    } catch (refusal) {
      if (!call.abortSignal?.aborted) {
        finish(refusedOutcome(refusal));
        return;
      }
      // Stopped while the reservation was made, which holdCall freed: the gateway ends the attempt as stopped.
    }
    const held = hold;
    const attempt = send(held ? held.providerOptions : call.onAttempt ? { onAttempt: call.onAttempt } : {}, (report) => {
      held?.lateUsage(report.usage);
      reportLateUsage(report, onLateUsage);
    });
    inner = attempt;
    void attempt.outcome.then(finish);
    if (!held) {
      yield* attempt;
      return;
    }
    // A stop between the reservation and the attempt's start: the gateway sends nothing, so nothing is held.
    if (call.abortSignal?.aborted) await held.settle({ kind: 'unsent' });
    const seen: Seen = { usage: undefined, output: false };
    let finished = false;
    try {
      // Read through the hold, which renews the reservation's lease while the attempt runs.
      for await (const chunk of held.reading(attempt)) {
        if (chunk.usage) seen.usage = chunk.usage;
        if (chunk.error) seen.failure ??= { error: chunk.error, afterOutput: seen.output };
        else seen.output = true;
        yield chunk;
      }
      finished = true;
    } finally {
      await held.settle(await endOf(attempt, finished, seen));
    }
  }

  const attempt: CompletionAttempt = { [Symbol.asyncIterator]: () => run(), outcome };
  // Read once the attempt's stream has ended, as the gateway's own attempt is: the gateway's attempt's answers.
  for (const key of ['schemaInPayload', 'schemaRoute'] as const) {
    Object.defineProperty(attempt, key, { enumerable: true, get: () => inner?.[key] });
  }
  return attempt;
}
