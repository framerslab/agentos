/**
 * @fileoverview The language module's event handle. Each line is one of the `language.*`
 * events in `AGENTOS_EVENTS`: a provider's name, a reason, a status and an error's type and
 * code, never the text being translated or the provider's answer.
 *
 * @module agentos/cognition/nlp/language/log
 */
import { moduleLogger } from '../../../core/logging/loggerFactory.js';
import { listedErrorFields } from '../../../core/logging/events.js';

/** Writes the `language.*` events to the logger current when each is written. */
export const languageLog = moduleLogger('language', 'language_service');

/** The HTTP status an error carries (`httpStatus`, `status`, `statusCode` or `response.status`), when it has one. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { httpStatus?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [e.httpStatus, e.status, e.statusCode, e.response?.status]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

/**
 * Writes one `language.translation_failed` line for a failed translation: the request failed, the answer was empty,
 * the call ran past the translator's own timeout (`timeout`), the answer stopped at the output cap (`truncated`), or
 * it stopped for another reason before its end, a content filter among them (`incomplete`).
 */
export function logTranslationFailed(
  provider: 'openai' | 'deepl',
  reason: 'request_failed' | 'empty_output' | 'timeout' | 'truncated' | 'incomplete',
  status: number | undefined,
  error?: unknown,
): void {
  languageLog.warn('language.translation_failed', {
    provider,
    reason,
    status: status ?? 0,
    ...(error === undefined ? {} : listedErrorFields(error)),
  });
}
