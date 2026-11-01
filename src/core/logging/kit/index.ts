/**
 * @fileoverview The allow-list kit: a typed logger over a product's event map with fixed
 * refusal reasons and burst budgets shared across the process, console capture, and opt-in
 * process handlers.
 *
 * @module agentos/core/logging/kit
 */

export { createAllowListLogger, type AllowListLogger } from './allowList.js';
export { captureConsole } from './consoleCapture.js';
export { installProcessHandlers } from './processHandlers.js';
export { LogValidationError } from '../forward.js';
