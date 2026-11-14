/**
 * @fileoverview The memory module's event handle. Each line is one of the `memory.*` events in `AGENTOS_EVENTS`: a
 * reason, a count, a hook's name, an error's type and code; never a user id, a session id, a page id, a trace's
 * words or an error's message.
 *
 * @module agentos/cognition/memory/log
 */
import { moduleLogger } from '../../core/logging/loggerFactory.js';

/** Writes the `memory.*` events to the logger current when each is written. */
export const memoryLog = moduleLogger('memory', 'library');
