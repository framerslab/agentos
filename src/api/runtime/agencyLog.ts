/**
 * @fileoverview agency()'s callback guard writes here. Its one line, `agency.callback_failed`, names the callback and
 * the error's listed type and code. It never holds the error's message: a callback is handed what the call sent, a
 * tool call's arguments among it, and can throw it back.
 *
 * @module agentos/api/runtime/agencyLog
 */
import { listedErrorFields } from '../../core/logging/events.js';
import { moduleLogger } from '../../core/logging/loggerFactory.js';

const agencyLog = moduleLogger('agency', 'agency');

const CALLBACKS = [
  'agentStart', 'agentEnd', 'handoff', 'toolCall', 'error', 'emergentForge', 'guardrailResult', 'limitReached',
  'approvalRequested', 'approvalDecided', 'guardrailHitlOverride',
] as const;

/**
 * One `agency.callback_failed` line for a callback that threw, or whose promise rejected.
 *
 * @param name - The callback's name. A name outside `AgencyCallbacks` is left out of the line.
 * @param error - What it threw. Its listed type and code are written, and nothing else of it.
 */
export function callbackFailed(name: string, error: unknown): void {
  const callback = (CALLBACKS as readonly string[]).includes(name) ? (name as (typeof CALLBACKS)[number]) : undefined;
  agencyLog.warn('agency.callback_failed', { ...(callback !== undefined ? { callback } : {}), ...listedErrorFields(error) });
}
