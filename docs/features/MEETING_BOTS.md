# Meeting bots

The meeting-participant channel manages a bot that joins a meeting as a listener on a person's behalf, posts a notice, feeds audio into a LiveKit room for transcription, and leaves and purges captured content when a participant asks. The host supplies a provider, its room service, storage and policy.

## What the library owns

`MeetingManager` (`@framers/agentos/io/channels/meetings`) owns a run's life: the state machine (`requested`, `scheduled`, `dispatching`, `joining`, `waiting_room`, `in_call_notice_pending`, `in_call`, `leaving`, `left`, `purging`, `done`, `failed`), the capture interlock, the stop phrase, the purge sequence behind a fence, the limits, settlement and reconciliation. The host supplies `IRunStore`, `IJobStore`, `ITranscriptStore`, `IEventStore`, `IOutbox`, its billing through `IEntitlementHook`, an `IClock`, and `IMeetingRoomService` implemented on its LiveKit server SDK.

Providers implement `IMeetingBotProvider` and may ship as extension packs of kind `meeting-provider`. `EXTENSION_KIND_MEETING_PROVIDER` and `MeetingProviderDescriptor` are exported from `@framers/agentos` and `@framers/agentos/extensions`; the host registers the descriptor's payload with `manager.registerProvider()`. The library includes `MockMeetingBotProvider` for tests. A platform in `MeetingPlatform` is a type declaration, not a bundled production provider.

The host owns route authentication, authorization, notice wording, webhook destinations and sending, billing policy, and deletion of its own copies through purge hooks. A provider's `MeetingBotCapabilities` declares its audio and stop paths, chat support, whether it joins as a visible participant, and that it records no audio, transcribes nothing and keeps nothing. Construct the notice from those capabilities. The manager does not generate notice text or prove a participant's consent.

## Stores

`InMemoryRunStore`, `InMemoryJobStore`, `InMemoryTranscriptStore`, `InMemoryEventStore` and `InMemoryOutbox` support tests and a single process. `SystemClock.now()` uses the wall clock; `FakeClock(initialMs)` supports `set(ms)` and `advance(ms)`.

`InMemoryEntitlementHook(maxSeconds = 14400)` reserves up to the requested limit, capped per reservation, with no external billing policy or shared account allowance. Reservations are keyed by run. `revalidate` accepts an unsettled, unreleased reservation; `meter` keeps the largest running total; `settle` and `release` are idempotent. `get(reservationId)` returns a copy for inspection, and `forget(runId)` removes its reservations. A production host implements `IEntitlementHook` for its own allowance and payments.

The Postgres implementations are `SqlRunStore`, `SqlJobStore`, `SqlTranscriptStore`, `SqlEventStore` and `SqlOutbox`, over `@framers/sql-storage-adapter`. Pass the same `SqlStoreOptions` (`db`, optional `tablePrefix`) to all five stores; `SqlRunStoreOptions` also requires `box: SecretBox`. The adapter must identify as Postgres and support transactions, persistence and concurrent access. Constructors validate the adapter and prefix; they do not create tables.

Apply `meetingStoresDdl(prefix)` through the host's migration before constructing the stores. `DEFAULT_TABLE_PREFIX` is `agentos_meeting`; `MEETING_STORES_DDL` is the DDL with that prefix. `meetingStoreTables(prefix)` returns `MeetingStoreTables`: names for runs, jobs, turns, events, outbox and the run anchors. A prefix is a lower-case letter followed by at most 37 lower-case letters, digits or underscores. The DDL creates missing tables and indexes; it does not upgrade existing table definitions. The run schema includes the nullable millisecond timers `leave_commanded_at`, `capture_suspended_at` and `alone_since`, and the nullable `provider_connection_ref`. A runs table made before that column existed takes `meetingProvenanceDdl(prefix)`, one idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, in the host's migration before a `SqlRunStore` of this version writes to it.

A run's `providerConnectionRef` is the provider's opaque reference for the connection the run was sent through, such as a credential's generation; `contentFreeRun` keeps it. `connectionRuns(db, runs, prefix, ownerRef, provider, generation)` reads the ids of every run an owner sent through that connection from the runs table, whatever their state, and returns them through the run store, ordered by run id, so a host can purge what one connection gathered after the connection itself is gone. `meetingProvenanceDdl` and `connectionRuns` refuse a prefix the stores refuse, with the error `meetingStoreTables` throws, before they build any SQL.

A job lease uses one statement with `FOR UPDATE SKIP LOCKED`. Run updates re-read and check the expected state under the run anchor; entering `purging` sets the shared content fence in that transaction. Transcript allocation, event numbering and content writes use that anchor too. `SqlRunStore` seals only the meeting URL with the run id as authenticated context and opens it on read. It does not encrypt every column.

The store contracts are:

| Surface | Contract |
| --- | --- |
| `IRunStore`, `RunFilter` | Insert, read, update with an optional expected state, replace, list and find by owner/idempotency key. Lists default to 500, newest requested time first, then run id; `states: []` applies no state filter. Duplicate owner/key inserts throw `DuplicateIdempotencyKeyError`. |
| `IJobStore`, `MeetingJob` | Schedule, lease, renew, record dispatch, release, cancel, read, list dispatched and remove. Rescheduling preserves lease and cancellation state. Dispatch recording and release require the holder. A cancel during dispatch becomes a leave. |
| `ITranscriptStore` | Append a numbered turn or atomically allocate one with `appendNext`; read after a sequence cursor, fence and purge. A repeated `(runId, seq)` keeps the first turn. A fenced append throws `FencedError`. Purging keeps the fence. `SqlTranscriptStore` keeps a turn's start and end in whole milliseconds, rounded. |
| `IEventStore`, `MeetingEvent` | Store stable event ids and per-run sequence numbers; read after a cursor. An id is unique across runs: an append of an id an event already holds answers that event's sequence, in `SqlEventStore` also when another run's append of it commits while this one waits. Fenced content events keep their metadata with no payload and `purged: true`. `purgePayloads` strips content payloads. |
| `IOutbox`, `OutboxDelivery` | Enqueue, read due deliveries, mark delivered/failed, replay, purge content and list by run. A repeated delivery id keeps its first copy. A failure recorded for a delivery that is no longer pending (delivered, or dead) changes nothing. Due deliveries default to 100, ordered by `nextAt` then id. |
| `IEntitlementHook`, `ReserveResult` | Reserve, revalidate, meter a running total, settle or release; settlement and release must tolerate retries. The optional `recordSupplierUsage` records a supplier's stream and capture totals and keeps the largest of each. |
| `IClock` | Supply the manager's current time in milliseconds. |

`nextAttemptAt(attempts, now)` schedules retries after 5 seconds, then 10, 20 and so on, capped at one hour. `OUTBOX_GIVE_UP_MS` is 86400000: a failure at least a day after the first failure marks the delivery dead. Manual `replay` resets its attempts. The host calls these methods from its delivery worker; the manager does not send HTTP deliveries.

Memory stores implement optional whole-run `forget` methods. The manager evicts eligible terminal runs after `forgetAfterMs` (two days by default, at least one day), only when no delivery is pending; it lists them when the first can go and at least once a minute, not on every tick. Unpurged kept runs remain. Durable stores omit eviction. Forgetting also removes fences, so producers must have stopped.

## A run

A host builds one manager when it starts and sends every run through it, so the runs it sends and the reports its events route applies meet in the same stores. This factory takes the host's provider and room service and uses memory storage; replace its entitlement hook and stores for a durable deployment.

```ts
import {
  MeetingManager, MeetingRoom, InMemoryRunStore, InMemoryJobStore,
  InMemoryTranscriptStore, InMemoryEventStore, InMemoryOutbox,
  InMemoryEntitlementHook, SystemClock,
  type IMeetingBotProvider, type IMeetingRoomService,
} from '@framers/agentos/io/channels/meetings';

/** Builds the host's one meeting manager, once, when the host starts. */
function createMeetingManager(provider: IMeetingBotProvider, roomService: IMeetingRoomService) {
  const manager = new MeetingManager({
    stores: {
      runs: new InMemoryRunStore(), jobs: new InMemoryJobStore(),
      transcript: new InMemoryTranscriptStore(), events: new InMemoryEventStore(),
      outbox: new InMemoryOutbox(), entitlement: new InMemoryEntitlementHook(),
      clock: new SystemClock(),
    },
    room: new MeetingRoom(roomService),
    reportUrlFor: (runId, providerName) => `https://example.test/events/${providerName}/${runId}`,
  });
  manager.registerProvider(provider);
  manager.start();
  return manager;
}

/** Sends a bot through the host's manager, the one its events route hands reports to. */
async function sendMeetingBot(manager: MeetingManager) {
  return manager.sendBot({
    ownerRef: 'acct_1', platform: 'google_meet',
    meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Meeting notes',
    keep: 'account', idempotencyKey: 'meeting-1', stopPhrase: 'stop taking notes',
    notice: {
      text: 'Meeting notes is taking notes. Type stop taking notes to stop and delete them.',
      version: '1',
      lateArrivalText: 'Meeting notes is taking notes. Type stop taking notes to stop and delete them.',
    },
  });
}
```

`SendBotRequest` supplies the owner, platform, meeting URL, name, Keep choice, notice and stop phrase. Optional fields select a provider, `joinAt`, limits, an idempotency key, transcriber and consent record id. `SendBotResult` returns the run and `repeated`, or a `SendBotRefusal` with a message. Repeating an owner's key returns its existing run even if the platform was paused meanwhile. Invalid nonfinite join times and negative or nonfinite limits throw before reserving. A reservation below ten minutes is refused by default; `minReservationSeconds` overrides that floor. Scheduled reservations are revalidated at dispatch. `NoCapacityError` from provider dispatch ends the run as `no_capacity`.

`start(intervalMs = 1000)` schedules ticks, one at a time: a pass still running when the next is due is not joined by it. `stop()` stops that timer without stopping bots. Hosts may drive `tick()` themselves. Each tick dispatches due jobs, enforces limits, resumes cleanup and periodically reconciles. `reconcile()` queries provider usage for dispatched runs, ends workers reported gone, resumes purges and restores missing jobs for waiting runs. It ignores, and logs, a provider's answer about a run it did not ask that provider about. A job whose dispatcher lost its lease after the bot had reported is recorded as dispatched when the next dispatcher leases it, so reconcile watches that run too. The manager stores leave, suspension and alone timers on `MeetingRunRecord`, so a replacement manager can continue them.

| Manager method | Purpose |
| --- | --- |
| `registerProvider`, `getProvider`, `providerFor` | Register by name, look up by name, or select the first provider declaring a platform unless a name is given. |
| `pausePlatform`, `resumePlatform`, `isPaused` | Control new sends on this manager instance; existing runs continue. |
| `getRun`, `listRuns` | Read a run or filtered runs. |
| `leaveBot` | Leave while retaining content according to `keep`; cancel a pending send. A run already told to leave keeps the reason it was told, which decides its billing, and its kill deadline. |
| `purgeRun` | Leave and delete content; on a run that is over (done, or failed before it joined), delete what is kept and run the purge hooks. Returns false for a run that does not exist. |
| `postChat` | Post only while `in_call` and the provider declares chat posting. |
| `pageSeen` | Refresh the page-presence timestamp for an enabled `pageAwayMs` limit; a run that is over is left as it is. |
| `addPurgeHook` | Add deletion of host-owned copies. |
| `on` | Receive `MeetingManagerEvent`; returns an unsubscribe function. |
| `processProviderEvent` | Verify, parse and apply a provider report. |
| `transcriptSink`, `recordTranscript` | Obtain the allocating sink, or emit an event for a turn already persisted by a caller. |

`MeetingManagerConfig` and `MeetingManagerStores` type the setup; `MeetingManagerEventHandler` types subscriptions. The host's report route passes `ProviderEventContext` to `processProviderEvent(providerName, ctx)`. The provider's `verifyEvent(ctx, run)` returns `ProviderVerificationResult`; its `parseEvent` returns `ProviderParseResult` with `NormalizedMeetingEvent` entries and stable ids. Events verified against a run are applied only to that run. `ProviderEventType` describes incoming reports; `MeetingEventType` describes outgoing `bot:*` events. State reports emit their transitions, and heartbeats add no event rows. A report is applied once. One the worker sends again changes nothing, with two exceptions: its event's deliveries are enqueued again, which the outbox keeps once each, so a delivery the first attempt never enqueued goes out; and a stop the first attempt did not carry out is carried out. Deduplication is not an atomic transaction spanning event storage and every side effect: the rest of a report whose application failed after its event was stored is not applied again, and a handler that missed the event then does not receive it.

`DispatchInput` carries the run, publish token, per-run worker token and report URL; `DispatchResult` supplies worker references. `ProviderCommand` covers `startCapture`, `suspendCapture`, `postChat`, `leave` and `kill`. `ProviderUsage` reports whether a worker holds a run and its elapsed seconds, and, for a provider that measures it, its `supplierUsage`. These operations belong to the provider, not the outbound webhook envelope.

### A dispatch the provider refuses

A provider's `dispatch` throws `DispatchRefusedError(reason, message)` when the run will never start: `permission_denied` when the platform refused it for good, `no_capacity` when no worker has a slot (`NoCapacityError`). The manager ends the run at once with that reason: the job is removed, the room deleted, the reservation released, nothing billed, and `bot:left` carries the message for the host to read. Any other error is retried every `dispatchRetryDelayMs` until `dispatchRetryMs` has passed.

A worker's report may arrive before the provider's `dispatch` returns. The manager writes the worker's id to the run in whatever active state the report left it, and a cancel that arrived in the same window still becomes a leave.

A `left` report may carry a `message`: a provider's code word for why the run ended. `bot:left` carries it beside the reason, as it carries the message of a refused dispatch; a provider keeps it to a fixed list of words and never puts a word of the meeting there.

## Capture, limits and billing

Capture opens only in `in_call`, after the provider confirms the notice and a monitor heartbeat at or after that confirmation is still fresh. Providers must forward no audio before `startCapture`, or after `suspendCapture` until another start. The notice alone never opens capture. The host must connect its listener only to that controlled audio path. The transcript sink and `recordTranscript` drop a turn for a run whose capture has not started, as well as turns behind the fence; that is not proof that audio was captured with permission.

With default manager options, an unconfirmed notice times out after 30 seconds. A monitor with an observed heartbeat becomes stale at 30 seconds, triggering suspension; another 30 seconds without recovery causes a leave. A report's time counts as at most one heartbeat interval past the manager's clock (10 seconds with the defaults), so a worker whose clock runs ahead keeps a quiet monitor counted healthy, or the notice and alone limits open, for no more than that. A notice followed by no heartbeat keeps capture closed, and the run leaves with `stop_monitor_failed` once the window and the recovery wait have passed without one (60 seconds after the notice with the defaults). A late participant gets `MeetingNotice.lateArrivalText` when the provider supports chat. Any chat message containing the stop phrase, case-insensitively, or a `stop_command` report starts a participant purge. The purge goes ahead even when the message's delivery fails, whose error is raised after it.

`DEFAULT_RUN_LIMITS` gives ten minutes in the waiting room, five minutes alone and four hours total. Total time starts at dispatch; the waiting-room limit counts from the bot's arrival in the waiting room (`joinedAt`, which admission then moves to the time the bot entered the call), or from dispatch when no waiting room was reported. The alone timer follows reports of zero participants besides the bot. There is no default page-away limit: a page host can pass `limits: { pageAwayMs: 120000 }` and call `pageSeen`. API clients can omit it.

`MeetingRunState`, `RUN_TRANSITIONS`, `TERMINAL_RUN_STATES` and `canTransition` expose the state graph. `MeetingRunLimits`, `MeetingLeaveReason`, `MeetingNotice` and `MeetingDispatchRecord` type run policy and metadata. `isBilledEnd` requires capture and excludes every `UNBILLED_REASONS` entry: `not_admitted`, `notice_failed`, `stop_monitor_failed`, `permission_denied` and `no_capacity`, even after capture. Otherwise settlement uses the largest total the worker reported (a report sent again, or one that arrives late, never lowers it), or elapsed seconds from dispatch when no total was reported. A crash reported after the bot left changes neither its leaving time nor that total. Each usage report emits `bot:usage`, and it is metered through `entitlement.meter` when the run holds a reservation and its capture has started: a usage report before capture emits `bot:usage` alone. The provider's reports set the cadence; the manager emits no `bot:usage` of its own between them.

A provider whose supplier bills for the media it carries may report `supplierUsage` (`SupplierUsage`: the seconds the supplier's stream was open and the seconds of it during which capture was open, both running totals, with `final` on the last) on any report, and in `ProviderUsage` for reconciliation. The manager hands a report's totals to `entitlement.recordSupplierUsage` when the hook has that method, before its terminal and fence checks, so a run that ends unbilled, or has already ended, still records what it cost; reconciliation hands over the totals the provider's usage answers for each run it polls. The hook may receive the same totals again and keeps the largest of each. Without the method nothing is recorded, and metering, settlement and release are unchanged.

A report's totals the hook refuses never stop the report: a `left` or `crashed` report still ends the run, settles or releases its reservation and cleans up. With `supplierUsageInbox` in the manager's stores (an `IDurableInbox<PendingSupplierUsage>`, such as a `SqlDurableInbox`), the refused totals wait there, and the next `reconcile()` hands them to the hook again and acknowledges each one it records. A total recorded but not acknowledged is handed over again at the next pass (the hook keeps the largest of each), and the first such failure is the error that `reconcile()` throws once its work is done. Reconciliation treats the totals a provider's usage answers the same way: a run whose worker is gone still ends as crashed, its job removed with the cleanup, and its refused final totals wait in the inbox. Without an inbox, `processProviderEvent` throws the hook's error once the report is applied, and `reconcile()` throws it at the end of the pass.

## Rooms and listening

`MeetingRoom.create(runId)` creates `bot-<runId>` at dispatch, with at most two participants, a 60-second empty timeout, a 45-second departure timeout and 600-second tokens. `MeetingRoomOptions` overrides the prefix, timeouts, token lifetime and identities (`bot` and `agent`). `MeetingRoomHandle` holds the room name, service URL, identities and both tokens. The host's `IMeetingRoomService` must create existing rooms idempotently, mint the requested publish/subscribe rights with no data-publishing grant, and report an absent room on delete with `status: 404`. `MeetingRoom.delete` ignores that status and passes on any other rejection as it is, for retry. A room whose token cannot be minted is deleted again and the mint's failure passed on.

The manager passes the publish-only token to the provider and retains only room metadata and the worker token's hash. It does not expose or retain the subscribe token the helper minted. When the listener connects, the host takes a fresh subscribe-only token for the run's room from `MeetingRoom.agentToken(run.dispatch.roomName)`, minted for the agent's identity with the helper's token lifetime: one minted at dispatch may have expired by then, since a run can wait in the waiting room longer than a token lives. Tokens must not go into events or the outbox.

`startListenSession(transport, manager.transcriptSink(runId), { streamingSTT, runId })` comes from `@framers/agentos/io/voice-pipeline`. It needs no synthesis, barge-in handler or agent turn. `LiveKitStreamTransport`, from `@framers/agentos/io/hearing/livekit`, subscribes to the bot's audio at the transcriber's rate; see [LiveKit Rooms](VOICE_PIPELINE.md#livekit-rooms).

`MeetingTranscriptSink` implements `ITranscriptInputSink`: each `TranscriptInput` becomes a `TranscriptTurn` with `<runId>:<n>` assigned atomically across sink instances, followed by `bot:transcript`. It requires a store implementing `appendNext`. The older `ITranscriptSink.append` takes an already numbered turn. Turns for a missing, terminal or purging run, or for a run whose capture has not started, and fenced writes are dropped. Read turns and events using their separate sequence cursors.

The listen session wraps one provider in `ReconnectingSTT` by default, with up to three reconnect attempts per minute and buffered replay before queued live audio. Pass `reconnect: false` for a multi-provider failover chain. An optional endpoint detector groups finals into turns; otherwise each final is a turn. A slow sink asks the transport to pause. The LiveKit transport holds two seconds by default and reports overflow with a `gap` event. `close('stopped')` hands the transcriber the audio the transport held before it flushes; audio dropped beyond the buffer is lost, as the `gap` reports, and a purge, or a transport that closes, drops what is held.

End reasons are `stopped`, `purged`, `stt_failed`, `transport_closed`, `transport_failed` and `sink_failed`. `close('stopped')` flushes the transcriber and waits for pending detector output; `close('purged')` drops queued turns without flushing. Every end releases a pause and removes the session's transport listeners, but leaves the transport open. The host closes it and maps session failures to its run policy; the session does not call `leaveBot` itself. Fence the run before closing for purge so an in-flight write is refused too.

## The purge

Use `purgeRun` for an owner's deletion or a decline. `leaveBot` alone preserves the Keep choice. A run that ends with `permission_denied` (a provider's `left` report with that reason) runs the purge sequence whatever its Keep, and participant stop messages invoke it through the manager's lifecycle.

An active purge changes the run to `purging`, fences transcripts and event payloads, and fences and scrubs the outbox. The bot is told to suspend capture and leave; a bot not reported gone after the configured leave deadline gets a kill command. Store content is removed immediately, without waiting for that exit. Once the bot has left or the kill path records its end, the manager runs host purge hooks, provider deletion, room deletion, settlement and job removal, emits `bot:purged` and `bot:done`, and then atomically writes the terminal content-free run. A step that fails, the events' delivery included, leaves the run `purging`, and a later tick runs the steps again; an event already stored is delivered again, not stored twice. A purge of an already completed run keeps its terminal state; a rejected cleanup step on that path must be retried by the caller, and its `bot:purged` goes out before the row is rewritten, so the retry sends one that failed.

`CONTENT_EVENT_TYPES` includes chat, transcript, participant-joined, participant-left and stop-command payloads. Their event metadata remains. A content event that reaches the event store behind a fence that went up while it was on its way is stored without its payload, and its delivery and its handlers receive it without one too. Outbox content is scrubbed even from delivered rows: its payload becomes empty and its type becomes `bot:purged`. Content-free deliveries keep their type and payload. The host's sender must honor the current purge state, including before replay; a previously fetched delivery is a copy and cannot be recalled by the store. The host implements deletion of listener history, output queues, kept summaries and client copies through its purge path and hooks.

`contentFreeRun` clears the meeting URL, bot name, notice text and stop phrase. It retains ids and settings (owner, provider, the provider's connection reference, platform, state, Keep, limits, idempotency and reservation ids), lifecycle times, reason, billed seconds, notice version and consent record id. Terminal cleanup also clears dispatch and timer fields. Ordinary completion with `keep: 'account'` retains the bot name, notice and stored content; `keep: 'none'` clears stored content.

## Helpers for a provider's own lifecycle

A provider that holds a media stream outside the manager (a worker that connects, publishes, suspends and leaves on the manager's commands) can use three helpers. None is required.

`LifecycleSerial` orders that work and fences a start in flight. `run(work)` queues `work` behind every operation queued before it, whether those resolved or rejected. A start takes `stamp()` before its first await and publishes only while `allows(stamp)` holds; a suspension or an end calls `invalidate()` before it queues its own work, so a start still in flight never publishes after it. `invalidate(true)` ends the lifecycle for good: `ended` is true and no stamp is allowed again.

`writeDurableJson(path, value)` replaces a private state file atomically: it writes a new file with mode `0600`, syncs it, renames it over the old one and syncs the directory. When the write or the rename fails, it removes the new file and throws the error, so no copy of the state is left beside the file. `removeDurableJson(path)` deletes the file and syncs the directory; a file already missing counts as removed.

`IDurableInbox` keeps the deliveries a receiver accepted until it acknowledges them, so work a restart interrupted is found again. `accept(entry)` answers false for an id it has accepted before; `pending()` lists the unacknowledged entries, oldest first; `acknowledge(id)` drops the payload and keeps the id, so a replay is still refused. `MemoryDurableInbox` serves tests and a single process. `SqlDurableInbox(db, prefix, box)` seals each payload with `box` (a `SecretBox`, for example) in the Postgres table `durableInboxDdl(prefix)` creates, `<prefix>_inbox`; apply that DDL in the host's migration.

## Verifying an outbound envelope

The host signs and sends outbox deliveries with `signEnvelope` or `envelopeHeaders`. This envelope is not Standard Webhooks: it uses the secret's UTF-8 bytes without removing a `whsec_` prefix or base64 decoding, timestamps in milliseconds, one `v1,` signature rather than a space-separated signature list, and `x-webhook-*` headers by default.

`DEFAULT_ENVELOPE_HEADERS` names `x-webhook-id`, `x-webhook-timestamp` and `x-webhook-signature`. A host may supply `EnvelopeHeaderNames` to both `envelopeHeaders` and `verifyEnvelope` (the latter through `options.names`). The verifier reads the given name or its lower-case form, taking the first value of a header array. All three values must be nonempty. The timestamp header must consist entirely of ASCII digits and convert to a finite number. Its numeric value is milliseconds since the epoch. `ENVELOPE_WINDOW_MS` accepts an absolute difference from the receiver's clock of at most `300000` milliseconds, inclusive in either direction. A NaN clock or window is refused. `options.windowMs` overrides the window.

The signature must equal the literal `v1,` followed by the padded base64 HMAC-SHA256 of the UTF-8 text `<id>.<timestamp-header>.<raw-payload>`. The key is the nonempty secret's UTF-8 bytes. Use the timestamp header's literal digits, including any leading zeros, in the MAC; number conversion is only for the window comparison. Use the body exactly as received, before parsing or reserialising JSON. Unknown version prefixes, extra signatures and any other signature text are refused. The verifier checks equal byte lengths and compares in constant time. Signing with an empty secret throws; verification with one returns `valid: false`.

This receiver verifies before parsing. Its final call is the fixed test vector; an HTTP handler passes its own secret, incoming headers and raw UTF-8 body. Pass the receiver's current clock to `verifyEnvelope`; the wrapper below defaults it to `Date.now()`. The verifier checks authenticity and freshness, not whether an id has already been processed; the receiver handles delivery deduplication.

```ts
import { verifyEnvelope } from '@framers/agentos/io/channels/meetings';

/** Verifies an envelope's raw body before interpreting its JSON. */
export function verifiedMeetingDelivery(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  nowMs = Date.now()
): unknown {
  const result = verifyEnvelope(secret, headers, rawBody, nowMs);
  if (!result.valid) throw new Error(result.error ?? 'invalid envelope');
  return JSON.parse(rawBody) as unknown;
}

verifiedMeetingDelivery(
  'whsec_test',
  {
    'x-webhook-id': 'msg_test',
    'x-webhook-timestamp': '1700000000000',
    'x-webhook-signature': 'v1,9ZqX9AeXhOn09zJoK16s/EjlvxkvRUT9ukb9stxQ79w=',
  },
  '{}',
  1_700_000_000_000
);
```

## Worker tokens, sealed URLs and testing

`mintWorkerToken()` returns 32 random bytes encoded as base64url. `hashWorkerToken(token)` returns SHA-256 hex; `workerTokenMatches(token, hash)` checks exactly 64 hex digits and compares in constant time. A provider verifies a worker against that run's dispatch hash, independently of outbound envelopes.

`SecretBox(currentKey, { previousKeys })` copies each 32-byte key. `seal(text, context)` uses the current key with a fresh nonce; `open(sealed, context)` tries the current key, then previous keys. The form is `v1.box.<base64url(nonce | ciphertext | tag)>` using the library's AES-256-GCM sealing. Wrong keys, context or authentication fail. `SqlRunStore` uses the run id as context; ordinary updates reseal its URL under the current key. Retain previous keys until every retained row has been rewritten. `SecretBox` and `SqlRunStore` print redacted markers under `JSON.stringify` (`toJSON()`) and under `util.inspect`, which `console.log` and loggers built on it use; a logger that reads an object's fields some other way is not covered.

`MockMeetingBotProvider` records dispatches and commands without joining a meeting. Tests can set `alive`, `dispatchError` and `beforeDispatch`, inspect `dispatched`, `commands` and `deleted`, obtain `tokenOf(runId)`, and use its static `hash` helper. `mockEventContext` builds an authenticated report context. Mock report ids include a body digest, so retries share an id while distinct reports at the same time remain distinct. The mock's URL patterns accept Meet and Teams test links; they are not a production browser's network policy.
