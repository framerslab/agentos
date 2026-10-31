/**
 * Compile-only probes for the two public additions; included by the existing strict typecheck.
 *
 * @module
 */
import { CONTENT_SAFE_COMPONENTS, enableContentSafeTelemetry, type ContentSafeLogComponent, type ContentSafeLogEvent, type ContentSafeLogSink, type ContentSafeTelemetryOptions } from '../index.js';
import type { ListenSessionOverrides, ListenWarningKind } from '../../../io/voice-pipeline/index.js';

/** Existing receiver/installation forms stay valid, while new fields and options stay finite. */
export function checkContentSafeContracts(sink: ContentSafeLogSink, options: ListenSessionOverrides): void {
  const component: ContentSafeLogComponent = CONTENT_SAFE_COMPONENTS[0];
  const event: ContentSafeLogEvent = { kind: 'library_event', state: 'warn', n: 1, component };
  const policy: ContentSafeTelemetryOptions = { minLevel: 'info' };
  sink(event);
  enableContentSafeTelemetry(sink);
  enableContentSafeTelemetry(sink, policy);
  options.onWarning?.('stt_warning');
  const warning: ListenWarningKind = 'speaker_failed';
  options.onWarning?.(warning);
  // @ts-expect-error: source levels are the existing four levels
  enableContentSafeTelemetry(sink, { minLevel: 'fatal' });
  // @ts-expect-error: a host name is not a library component
  const invalid: ContentSafeLogComponent = 'caller-provided-name';
  // @ts-expect-error: no warning payload or arbitrary word reaches this callback
  options.onWarning?.('provider supplied words');
  void invalid;
}
