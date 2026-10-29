# Content-safe voice diagnostics

Enable the host sink once before provider work, in every process that loads AgentOS. State belongs to the loaded package copy. Worker installation does not configure a different process or an independently loaded copy.

```ts
import { enableContentSafeTelemetry, type ContentSafeLogSink } from '@framers/agentos/logging';

/** Forward only the fixed event into the host's checked diagnostic boundary. */
export function installDiagnostics(receive: ContentSafeLogSink): void {
  enableContentSafeTelemetry(receive, { minLevel: 'info' });
}
```

An event has exactly `kind: 'library_event'`, `state`, `n: 1` and `component`. It is frozen. State is debug, info, warn or error. Component is a member of the exported frozen `CONTENT_SAFE_COMPONENTS` tuple, with type `ContentSafeLogComponent`. The module binds that constant; a host logger name, binding, provider id, record field or path cannot create a component. Factory loggers use logger_factory, direct pino wrappers use pino_logger, and covered console modules use their declared source words.

The minimum source level is optional and defaults to debug, preserving one-argument installation. A lower level is discarded before calling the sink and never falls through to the raw destination. A repeat with the same sink and effective minimum is harmless; replacing either is refused with a fixed error. There is no disable or reset. The host still decides its own output severity, counts and burst budget. A recursive library log from the sink is discarded. A sink throw is swallowed without replaying the source record. An object or function the sink returns is resolved as `await` resolves it, and its rejection is swallowed the same way, whether it is an async sink's promise, a promise from another realm or a thenable.

Existing and future factory and pino loggers are intercepted at call time. Covered console modules use local bindings; the global console object is unchanged. Existing LLM/provider, router, health, embedding, model, generation, observer, runtime helper and agency launch tool coverage remains, and the listen session, reconnecting STT, streaming STT chain and LiveKit transport console fallbacks are covered. The existing observability guards still disable library trace/metric/log exports and the global usage observer while the mode is enabled.

A listen session additionally accepts `onWarning?: (kind: ListenWarningKind) => void`, where `ListenWarningKind` is stt_warning or speaker_failed. The first represents a warning from the opened STT session; the second represents a throwing speaker hook. The callback receives no original error, text, provider id or transcript. A callback throw is swallowed and has no effect on hearing. An object or function the callback returns is resolved as `await` resolves it, and its rejection is swallowed the same way, whether it is an async callback's promise, a promise from another realm or a thenable. A speaker failure still writes the turn without a speaker. The owned STT warning listener remains through drain and is removed at terminal cleanup. Warnings emitted before the provider's startSession promise resolves cannot be captured through the returned session. Omitting the callback preserves the provider's ordinary unlistened-warning behavior.

Voice fallback paths check safe mode before reading a warning message or describing a thrown speaker value. Existing diagnostic argument expressions in other covered modules still evaluate before the console binding intercepts the record. Safe-mode output does not imply that all upstream computations avoided reading input.

An explicit LiveKit transport logger and existing warning event listeners are host-owned. They retain their original contracts; the host must sanitize what it writes. A strict streaming-chain policy retains its existing silent fallback when nobody listens. Audio, transcript, usage, replay, drain, purge and caller-owned transport behavior are unchanged. This feature does not intercept rtc-node, other third-party loggers, arbitrary host output, every other voice module or a static initializer that ran before installation. It adds no file, spool, database record or retention promise.

CI exercises fixed components and all source thresholds, immutable setup, prior and new loggers, hostile data, ordinary off-mode delegation, real voice wrappers and room readers, callback cleanup, default behavior and the built package's public export. Existing lifecycle, observability and browser-entry suites remain required. The public declarations and registry version from the resulting release are the adoption contract.
