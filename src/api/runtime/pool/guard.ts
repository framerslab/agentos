/**
 * @fileoverview The per-call guard of a pooled or panel agency: what
 * `generate(prompt, opts)` and `stream(prompt, opts)` may carry. It tests
 * whether a key is present, not whether its value is defined:
 * `{ fallbackProviders: undefined }` would replace a seat's empty chain with
 * the default one. A key counts as present when it is an own enumerable
 * property, the keys a seat receives when the call's options are spread into
 * its own.
 */
import { AgencyConfigError } from '../../types.js';

/** Keys a call may not carry in an agency with a pool, under any strategy. */
export const POOL_DENIED_KEYS = [
  'model', 'provider', 'apiKey', 'baseUrl', 'fallbackProviders', 'onFallback', 'router', 'routerParams', 'hostPolicy', 'policyTier',
  '__strictCredentials', '__maskError',
] as const;

/** `customModelParams` keys a call may not carry in a pooled agency: each would change the model on the wire. */
export const CUSTOM_MODEL_PARAMS_DENIED_POOL = ['model', 'models'] as const;

/**
 * The only keys a call may carry under `panel`. `budget`, `hookErrors` and
 * `abortSignal` can stop a seat's call (a refused spend, a hook's error, the
 * caller's abort) but change no seat's provider, model, key, URL, prompt or
 * tools. A `budget` given as settings makes one budget per seat call; pass a
 * `SpendBudget` instance to cap the whole run.
 */
export const PANEL_ALLOWED_KEYS = [
  'temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxTokens', 'thinking', 'effort', 'requestTimeout', 'cache',
  'promptCacheKey', 'promptCacheRetention', 'serviceTier', 'cacheDiagnostics', 'sessionId', 'usageLedger', 'source', 'toolChoice',
  'chainOfThought', 'planning', 'onAfterGeneration', 'onBeforeToolExecution', '__approvalGate', '__panelDeadline', 'customModelParams',
  'budget', 'hookErrors', 'abortSignal',
] as const;

/** `customModelParams` keys a panel call may not carry: each would give every seat one shared prompt, tool set or model. */
export const CUSTOM_MODEL_PARAMS_DENIED_PANEL = [
  'model', 'models', 'system', 'messages', 'tools', 'tool_choice', 'response_format', 'contents', 'systemInstruction',
] as const;

const POOL_DENIED = new Set<string>(POOL_DENIED_KEYS);
const PANEL_ALLOWED = new Set<string>(PANEL_ALLOWED_KEYS);

const quoted = (keys: readonly string[]): string => keys.map((k) => `"${k}"`).join(', ');

/**
 * Throws {@link AgencyConfigError} when `opts` carries a key the agency's
 * mode forbids: under `'pool'` a key of {@link POOL_DENIED_KEYS}, under
 * `'panel'` any key outside {@link PANEL_ALLOWED_KEYS}, and in both a
 * `customModelParams` that holds a barred key.
 *
 * @param opts - The per-call options of `generate()` or `stream()`; `undefined` passes.
 * @param mode - `'panel'` for a panel agency, `'pool'` for any other agency with a `modelPool`.
 * @throws {AgencyConfigError} When a forbidden key is present, whatever its value.
 */
export function guardPerCallOptions(opts: Record<string, unknown> | undefined, mode: 'pool' | 'panel'): void {
  if (!opts || typeof opts !== 'object') return;
  const keys = Object.keys(opts);
  if (mode === 'panel') {
    const rejected = keys.filter((k) => !PANEL_ALLOWED.has(k));
    if (rejected.length > 0) {
      throw new AgencyConfigError(
        `A panel call cannot carry ${quoted(rejected)}: every seat and the chair would share it. ` +
          `Allowed per call: ${PANEL_ALLOWED_KEYS.join(', ')}.`,
      );
    }
  } else {
    const rejected = keys.filter((k) => POOL_DENIED.has(k));
    if (rejected.length > 0) {
      throw new AgencyConfigError(
        `A call on an agency with a modelPool cannot carry ${quoted(rejected)}: it would move every seat off its seating.`,
      );
    }
  }
  const cmp = opts.customModelParams;
  if (cmp && typeof cmp === 'object') {
    const denied: readonly string[] = mode === 'panel' ? CUSTOM_MODEL_PARAMS_DENIED_PANEL : CUSTOM_MODEL_PARAMS_DENIED_POOL;
    const barred = denied.filter((k) => Object.prototype.hasOwnProperty.call(cmp, k));
    if (barred.length > 0) {
      throw new AgencyConfigError(
        `customModelParams.${barred[0]} cannot be passed per call to ${mode === 'panel' ? 'a panel' : 'a pooled agency'}`,
      );
    }
  }
}
