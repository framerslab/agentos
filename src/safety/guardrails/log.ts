/**
 * @fileoverview The guardrail dispatchers' event handle. Each line is one of the `guardrail.*` events in
 * `AGENTOS_EVENTS`: a guard's id, a stage, a posture, a cause and an error's listed type and code, never a guard's
 * reason, the content it judged or an error's message.
 *
 * @module agentos/safety/guardrails/log
 */
import { moduleLogger } from '../../core/logging/loggerFactory.js';

/** Writes the `guardrail.*` events to the logger current when each is written. */
export const guardrailLog = moduleLogger('guardrails', 'guardrails');
