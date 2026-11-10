/**
 * @fileoverview The soul module's event handle. Each line is one of the `soul.*` events in `AGENTOS_EVENTS`: a field
 * name, a reason, an error's type and code; never a soul's path, its text or an error's message.
 *
 * @module agentos/cognition/substrate/personas/soulLog
 */
import { moduleLogger } from '../../../core/logging/loggerFactory.js';

/** Writes the `soul.*` events to the logger current when each is written. */
export const soulLog = moduleLogger('souls', 'library');
