/**
 * @fileoverview The governed tools' event handle. Its lines are `action.ended` and `action.audit_failed`: an action's
 * name, an outcome, a code the wrapper built and an error's listed type and code, never an argument, a quote, an id a
 * model supplied or an error's message.
 *
 * @module agentos/safety/runtime/actionLog
 */
import { moduleLogger } from '../../core/logging/loggerFactory.js';

/** Writes the `action.*` events to the logger current when each is written. */
export const actionLog = moduleLogger('action_governance', 'action_governance');
