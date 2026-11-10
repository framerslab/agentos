/**
 * @fileoverview The typed log handle of the memory layer.
 * @module memory/io/memoryLog
 */
import { lazyLogger } from '../../../core/logging/loggerFactory.js';

/**
 * Writes the memory layer's events (the `memory.*` entries of `AGENTOS_EVENTS`). A line carries counts and declared
 * words alone: never a user id, a page id, a trace's text or an error's message.
 */
export const memoryLog = lazyLogger('memory');
