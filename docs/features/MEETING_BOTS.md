# Meeting bots

The meeting-participant channel manages a bot that joins a meeting as a listener on a person's behalf, posts a notice, feeds audio into a LiveKit room for transcription, and leaves and purges captured content when a participant asks. The host supplies a provider, its room service, storage and policy.

## What the library owns

`MeetingManager` (`@framers/agentos/io/channels/meetings`) owns a run's life: the state machine (`requested`, `scheduled`, `dispatching`, `joining`, `waiting_room`, `in_call_notice_pending`, `in_call`, `leaving`, `left`, `purging`, `done`, `failed`), the capture interlock, the stop phrase, the purge sequence behind a fence, the limits, settlement and reconciliation. The host supplies `IRunStore`, `IJobStore`, `ITranscriptStore`, `IEventStore`, `IOutbox`, its billing through `IEntitlementHook`, an `IClock`, and `IMeetingRoomService` implemented on its LiveKit server SDK.

Providers implement `IMeetingBotProvider` and may ship as extension packs of kind `meeting-provider`. `EXTENSION_KIND_MEETING_PROVIDER` and `MeetingProviderDescriptor` are exported from `@framers/agentos` and `@framers/agentos/extensions`; the host registers the descriptor's payload with `manager.registerProvider()`. The library includes `MockMeetingBotProvider` for tests. A platform in `MeetingPlatform` is a type declaration, not a bundled production provider.

The host owns route authentication, authorization, notice wording, webhook destinations and their secrets, running the delivery pass that `OutboxDispatcher` provides, billing policy, and deletion of its own copies through purge hooks. A provider's `MeetingBotCapabilities` declares its audio and stop paths, chat support, whether it joins as a visible participant, and that it records no audio, transcribes nothing and keeps nothing. Construct the notice from those capabilities. The manager does not generate notice text or prove a participant's consent.

## Stores

`InMemoryRunStore`, `InMemoryJobStore`, `InMemoryTranscriptStore`, `InMemoryEventStore` and `InMemoryOutbox` support tests and a single process. `SystemClock.now()` uses the wall clock; `FakeClock(initialMs)` supports `set(ms)` and `advance(ms)`.

`InMemoryEntitlementHook(maxSeconds = 14400)` reserves up to the requested limit, capped per reservation, with no external billing policy or shared account allowance. Reservations are keyed by run. `revalidate` accepts an unsettled, unreleased reservation; `meter` keeps the largest running total; `settle` and `release` are idempotent. `get(reservationId)` returns a copy for inspection, and `forget(runId)` removes its reservations. A production host implements `IEntitlementHook` for its own allowance and payments.

The Postgres implementations are `SqlRunStore`, `SqlJobStore`, `SqlTranscriptStore`, `SqlEventStore` and `SqlOutbox`, over `@framers/sql-storage-adapter`. Pass the same `SqlStoreOptions` (`db`, optional `tablePrefix`) to all five stores; `SqlRunStoreOptions` also requires `box: SecretBox`. The adapter must identify as Postgres and support transactions, persistence and concurrent access. Constructors validate the adapter and prefix; they do not create tables.

Apply `meetingStoresDdl(prefix)` through the host's migration before constructing the stores. `DEFAULT_TABLE_PREFIX` is `agentos_meeting`; `MEETING_STORES_DDL` is the DDL with that prefix. `meetingStoreTables(prefix)` returns `MeetingStoreTables`: names for runs, jobs, turns, events, outbox and the run anchors. A prefix is a lower-case letter followed by at most 37 lower-case letters, digits or underscores. The DDL creates missing tables and indexes; it does not upgrade existing table definitions. The run schema includes the nullable millisecond timers `leave_commanded_at`, `capture_suspended_at` and `alone_since`, the nullable `provider_connection_ref`, the nullable millisecond `last_report_at` and `last_usage_source_at`, `creation_pending` (false by default), the sealed `creation_context` and, at the end of the table, the nullable funding columns `funding_json`, `funding_reservation_id`, `funding_settlement_json` and `funding_cleanup_json`, with a partial index on `run_id` over the runs whose funding cleanup is unfinished. The run-anchor table ends with the nullable millisecond `outbox_fenced_at`, where `SqlDeliveryFence` keeps a `FencedOutbox`'s fence.

Tables an earlier version made take `meetingStoresUpgradeDdl(prefix)`: one `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for each column of the runs and run-anchor tables they may lack, each made as the fresh schema makes it, then the funding scan's partial index. Applied twice, or to tables this version made, it changes nothing, and it refuses a prefix the stores refuse before it builds any SQL. The stores read and write every column, so the host runs it in its migration, in one transaction, before it constructs them. It includes the one column `meetingProvenanceDdl(prefix)` adds. This host upgrades its tables, then gives its one `FencedOutbox`, with the durable fence, to both the manager and the dispatcher:

```ts
import {
  FencedOutbox, MeetingManager, MeetingRoom, OutboxDispatcher, SecretBox, SqlDeliveryFence,
  SqlEventStore, SqlJobStore, SqlOutbox, SqlRunStore, SqlTranscriptStore, SystemClock, meetingStoresUpgradeDdl,
  type DeliveryDestination, type IEntitlementHook, type IMeetingRoomService,
} from '@framers/agentos/io/channels/meetings';
import type { StorageAdapter } from '@framers/sql-storage-adapter';

/** Upgrades the host's meeting tables, then builds its manager and its dispatcher over one fenced outbox. */
async function openMeetingChannel(
  db: StorageAdapter, prefix: string, key: Buffer, entitlement: IEntitlementHook, roomService: IMeetingRoomService,
  resolve: (destinationRef: string) => Promise<DeliveryDestination | undefined>,
) {
  await db.transaction((tx) => tx.exec(meetingStoresUpgradeDdl(prefix)));
  const options = { db, tablePrefix: prefix };
  const outbox = new FencedOutbox(new SqlOutbox(options), new SqlDeliveryFence(options));
  const manager = new MeetingManager({
    stores: {
      runs: new SqlRunStore({ ...options, box: new SecretBox(key) }), jobs: new SqlJobStore(options),
      transcript: new SqlTranscriptStore(options), events: new SqlEventStore(options),
      outbox, entitlement, clock: new SystemClock(),
    },
    room: new MeetingRoom(roomService),
    reportUrlFor: (runId, providerName) => `https://example.test/events/${providerName}/${runId}`,
  });
  return { manager, dispatcher: new OutboxDispatcher({ outbox, resolve }) };
}
```

A run's `providerConnectionRef` is the provider's opaque reference for the connection the run was sent through, such as a credential's generation; `contentFreeRun` keeps it. `connectionRuns(db, runs, prefix, ownerRef, provider, generation)` reads the ids of every run an owner sent through that connection from the runs table, whatever their state, and returns them through the run store, ordered by run id, so a host can purge what one connection gathered after the connection itself is gone. `meetingProvenanceDdl` and `connectionRuns` refuse a prefix the stores refuse, with the error `meetingStoreTables` throws, before they build any SQL.

A job lease uses one statement with `FOR UPDATE SKIP LOCKED`. Run updates re-read and check the expected state under the run anchor; entering `purging` sets the shared content fence in that transaction. `updateWith` decides its patch on the row it re-reads there. Transcript allocation, event numbering and content writes use that anchor too. `SqlRunStore` seals two columns and opens them on read: the meeting URL, with the run id as authenticated context, and the creation context, bound to the run and to its column, so neither sealed text opens in another row or in the other's place. It encrypts no other column.

The store contracts are:

| Surface | Contract |
| --- | --- |
| `IRunStore`, `RunFilter` | Insert, read, update with an optional expected state, replace, list and find by owner/idempotency key. The optional `updateWith` applies a patch decided on the row as the store holds it, in the same step as the read; both included stores implement it, and `usageSilenceMs` requires it. Lists default to 500, newest requested time first, then run id; `states: []` applies no state filter. Duplicate owner/key inserts throw `DuplicateIdempotencyKeyError`. The optional `listFundingPending` pages the runs whose funding cleanup is unfinished; both included stores implement it and refuse a write that changes a run's persisted funding (see [Persisted funding](#persisted-funding)). |
| `IJobStore`, `MeetingJob` | Schedule, lease, renew, record dispatch, release, cancel, read, list dispatched and remove. Rescheduling preserves lease and cancellation state. Dispatch recording and release require the holder. A cancel during dispatch becomes a leave. |
| `ITranscriptStore` | Append a numbered turn or atomically allocate one with `appendNext`; read after a sequence cursor, fence and purge. A repeated `(runId, seq)` keeps the first turn. A fenced append throws `FencedError`. Purging keeps the fence. `SqlTranscriptStore` keeps a turn's start and end in whole milliseconds, rounded. |
| `IEventStore`, `MeetingEvent` | Store stable event ids and per-run sequence numbers; read after a cursor. An id is unique across runs: an append of an id an event already holds answers that event's sequence, in `SqlEventStore` also when another run's append of it commits while this one waits. Fenced content events keep their metadata with no payload and `purged: true`. `purgePayloads` strips content payloads. |
| `IOutbox`, `OutboxDelivery` | Enqueue, read due deliveries, mark delivered/failed, replay, purge content and list by run. A repeated delivery id keeps its first copy. A failure recorded for a delivery that is no longer pending (delivered, or dead) changes nothing. Due deliveries default to 100, ordered by `nextAt` then id. The optional `sendClaimed` sends one delivery after re-reading it, with a signal that a purge of its run aborts; `InMemoryOutbox`, `SqlOutbox` and `FencedOutbox` implement it. |
| `IEntitlementHook`, `ReserveResult`, `DispatchAllowance` | Reserve, revalidate, meter a running total, settle or release; settlement and release must tolerate retries. The optional `recordSupplierUsage` records a supplier's stream and capture totals and keeps the largest of each. The optional `reserveOnce` reserves for a run written pending, idempotently by its run id; the optional `revalidateAllowance` answers a `DispatchAllowance` before a worker is sent (see [Recoverable creation](#recoverable-creation)). The optional `checkRun`, `recover` and `finalize` serve a hook that funds runs from their persisted snapshot (see [Persisted funding](#persisted-funding)). |
| `IClock` | Supply the manager's current time in milliseconds. |

`nextAttemptAt(attempts, now)` schedules retries after 5 seconds, then 10, 20 and so on, capped at one hour. `OUTBOX_GIVE_UP_MS` is 86400000: a failure at least a day after the first failure marks the delivery dead. Manual `replay` resets its attempts. `OutboxDispatcher` calls these methods, or the host's own delivery worker does; the manager does not send HTTP deliveries.

`OutboxDispatcher` sends the outbox's due deliveries: each signed with `envelopeHeaders` under the host's header names, posted over https to an address that resolves to public ranges alone, connected to the address it checked, with no redirect followed; a 2xx marks it delivered, anything else failed for the outbox's backoff. A delivery a purge emptied, or one a `FencedOutbox` stored empty behind its fence, sends only its event's id, `bot:purged` and the run's id; the manager's own `bot:purged` event, which a plain outbox keeps whole, also sends the time, the sequence and the reason it was stored with, as every other event's delivery does, and nothing else of its payload. The host passes the outbox and `resolve(destinationRef)`, which answers a destination's url and secret, or `undefined` for one it no longer holds (that delivery is marked failed, as is one whose `resolve` rejects, and the pass goes on), and optionally `names`, `clock`, `batch` (50), `timeoutMs` (10000) and a `logger` told only a failed delivery's id and error name. The host calls `deliverDue()` on its own schedule from one process per outbox, and gets back `{ delivered, failed }`. The default send, `httpsSend()`, posts through the checked egress module's hosted profile (`@framers/agentos/safety/egress`). It refuses with `DestinationRefusedError`, before a socket opens, a url that is not https on port 443, carries a user name or password, or names an address literal, and a host with any address `isPublicAddress` refuses: the egress module's rule, which refuses every block of IANA's IPv4 and IPv6 special-purpose registries, multicast, the IPv6 space outside 2000::/3, and every IPv4-mapped or translated IPv6 form (NAT64, 6to4, Teredo) whatever IPv4 address it carries. It also refuses an IPv6 address under the network's own NAT64 prefixes, read (RFC 7050) from the IPv6 addresses its lookup gives for `ipv4only.arpa`; a send whose prefixes cannot be read fails before it connects, and the delivery is retried. It posts on a connection of its own to the first checked address, with TLS validating the name, fails a send whose answer passes 1 MiB, and gives up after `timeoutMs`. When the outbox implements the optional `IOutbox.sendClaimed`, as `InMemoryOutbox` and `SqlOutbox` do, the dispatcher sends through it: the outbox re-reads the delivery, skips one that is gone or no longer pending, and passes a signal that a purge of the run aborts. A `SqlOutbox` aborts the sends of its own instance, so the manager that purges and the dispatcher take the same one; a purge another process commits reaches a send only through the re-read. `httpsSend` stops at that signal while it resolves, connects and reads the answer; a custom send must honor it before it writes the body.

`FencedOutbox` wraps an outbox so that a purge reaches the deliveries a dispatcher has under way, not only the stored rows. `new FencedOutbox(outbox, fence)` takes the outbox and a `DeliveryFence`, where the fence is kept: `isFenced(runId)`, `fence(runId)` and an optional `forget(runId)`. `MemoryDeliveryFence` keeps fences in the process, for tests and a single process. `SqlDeliveryFence(options)`, on the `SqlStoreOptions` the Postgres stores take, keeps each in the run-anchor row's `outbox_fenced_at`, across a restart and between processes; it is apart from the content fence a purge sets on the same row, and keeps its fences for good, so it has no `forget`. The wrapper's `purgeContent(runId)` aborts the run's sends under way before it writes the fence, waits for them to end and then scrubs the wrapped outbox, so when it resolves no send of the run's content is in progress in the process; a send must therefore never wait for a purge of its own run. Its `sendClaimed` scrubs a fenced run's content first and then re-reads the delivery, so a purge that lands while the dispatcher resolves the destination sends the content-free body in its place. Once a run is fenced, every delivery enqueued for it, `bot:done` included, is stored as `bot:purged` with an empty payload, where a plain outbox refuses a content delivery and keeps a content-free one as it is. A run's enqueues, claims and scrubs run one at a time, and a send goes out after its claim, outside that guard: an enqueue for a run, and with it the manager's handling of the run's events (a participant's stop among them), never waits for a destination, and a pass that takes a delivery another pass is still sending skips it. Make one `FencedOutbox` per outbox in the process that delivers and give it to both the manager and the dispatcher: a second wrapper of the same outbox does not see the first one's sends. Over an outbox that has `forget` the wrapper has `forget` too, which drops the run's fence with its deliveries, so the manager's eviction goes on.

Memory stores implement optional whole-run `forget` methods. The manager evicts eligible terminal runs after `forgetAfterMs` (two days by default, at least one day), only when no delivery is pending; it lists them when the first can go and at least once a minute, not on every tick. Unpurged kept runs remain. Durable stores omit eviction. Forgetting also removes fences, so producers must have stopped.

### Persisted funding

A run can carry its funding as an immutable snapshot, `funding` (`MeetingFundingSnapshot`), written with the run when the run is inserted. `MeetingFundingSnapshotSchema` is closed: a snapshot with any other field is refused, and every amount and count is a whole number. The snapshot names the account (`accountRef`, which is the run's owner), the policy or tariff version, the reservation reference `meeting-funding:<runId>`, the most seconds the run may use (enough for its `limits.totalMs`), an expiry later than its request, and its branch, `fundingMode`. A `bot_blocks` snapshot gives the block length in seconds and the most blocks the run may hold, enough for its seconds. A `developer_credit` snapshot gives the rate snapshot, whose version is the policy version, the component that prices media seconds, and the most the run may cost each side, which equals `quoteCompoundLiability` for its seconds with no model attempts.

Three fields record what follows the snapshot. `fundingReservationId` is the block reservation or credit hold, written once. `fundingSettlement` is the terminal billing decision, written once: `billedSeconds`, `unbilled` and, when the decision was taken from it, the measured `connectedMs`; an unbilled run bills zero seconds, and a billed one with a measured connection bills that connection rounded up to the second. `fundingCleanup` says whether the run ends unbilled and whether its cleanup is complete: once written it stays, its `unbilled` never changes and its `complete` never goes back to false.

Both included run stores apply `assertMeetingFundingChange(previous, next)` on every insert, update, `updateWith` and replace. A run with funding keeps its run id, its owner and its snapshot, compared by `meetingFundingIdentity` (the validated snapshot's canonical text), and its `reportedSeconds` never falls; a run without funding never gains a snapshot and takes neither a reservation id nor a settlement; no write-once field changes. A refused write throws and writes nothing. `SqlRunStore` checks the funding of every row it reads, so a corrupt row fails closed, and its `replace` re-reads the row under the run anchor first, so a stale content-free replacement is refused instead of overwriting a newer settlement. `contentFreeRun` keeps all four fields.

The optional `IRunStore.listFundingPending(limit, afterRunId?)` pages the runs whose funding cleanup is unfinished, in run id order: at most `limit` runs, from 1 to 64 (another limit is refused), after `afterRunId`. Both included stores implement it. `IEntitlementHook` declares three optional members for a hook that funds runs from their snapshot: `checkRun(runId, phase)` answers a `DispatchAllowance` from the run's original funding and the host's current authority at a `MeetingFundingPhase` (`reserve`, `revalidate`, `dispatch`, `heartbeat` or `recovery`) without choosing another source; `recover(runId)` resumes the run's durable settlement; and `finalize(reference, decision)` takes the host's final billing decision, `{ unbilled }`, for a reservation.

`CompositeMeetingEntitlement` (`@framers/agentos/io/channels/meetings`) is an `IEntitlementHook` that funds every run from its snapshot alone, at every point of its life: reservation, revalidation, dispatch, heartbeat, metering, settlement, release and recovery. A run never moves to the other branch: a block-funded run whose eligibility ends is refused, never paid from credit, and a cash-funded run whose account is frozen is refused, never paid from blocks. Its reservation id is the snapshot's `reservationRef`, and every method that takes a reference throws for one of another form, or one whose run's snapshot names another. Its options:

- `runs` and `credit`: the manager's run store, and the `ICompoundCreditStore` that holds a cash-funded run's hold.
- `now()` and `supplierDailyCapMicro()`: the time in milliseconds and the platform's daily supplier cap in micro-dollars. Each must answer a whole number, zero or more, or the call that asked throws.
- `blocks(snapshot)`: the host's block entitlement for the snapshot's own policy version, a `MeetingBlockEntitlement`: an `IEntitlementHook` whose `reserveOnce` returns the same allocation for a run id after a lost answer, with `findByRun(runId)`, a read that never allocates.
- `check(run, phase)`: the host's authority and capacity at a `MeetingFundingPhase` (the account still active, the caller permitted, the original tariff still eligible, the supplier able to serve it), answered as a `DispatchAllowance`. It and `close` are handed a copy of the run as the store holds it when they are asked, so an allocation link the entitlement has just recovered (see `reserveOnce` below) is on it.
- `close(run)`: stops every dispatch of the run, closes its media and inference, and answers the measured connected time and a `CallFence`, as `{ connectedMs, fence }`. It is asked again on every call until the run's funding cleanup is complete, and must be idempotent. While termination or the final usage is unknown it must answer false fence flags: a kill request, a terminal state, an elapsed lease or a missing worker is not evidence that the work stopped, and a run never dispatched still needs a positive fence, under the owner's lock, that no dispatch can follow.

`reserveOnce(input)`, and `reserve`, which calls it, takes a run already written with its snapshot; an owner or platform other than the run's, or more seconds than the snapshot's, throws. A run with a settlement intent, or in a state other than `requested` and `scheduled`, is refused. The run's allocation is looked up first: the block entitlement's `findByRun`, or the hold of the run's operation in the snapshot's account, whose kind must be `meeting_run` and whose request hash must be the SHA-256 of `meetingFundingIdentity`. A host `check` that refuses, a grant that is not a whole number above zero, or a snapshot whose expiry has come releases that allocation, when there is one, and refuses the run. A run without an allocation then reserves on its own branch, for the snapshot's seconds: the block entitlement's `reserveOnce`, or `reserveCompoundCredit` for the snapshot's account with the run id as its operation, the kind `meeting_run`, that request hash, the snapshot's rates, media component and expiry, no model attempts, and the current supplier cap. A block refusal is answered as the block entitlement gave it; a credit refusal, or a hold found no longer `held`, refuses the run. The allocation's id is written once as the run's `fundingReservationId`. Last, `checkRun(runId, 'reserve')` must admit the run, or the allocation is released and the run refused. The answer covers the least of the seconds asked, the snapshot's, the block allocation's, the host's grant and the check's. A call interrupted at any step is finished by the next: it finds the same allocation by the run, so a run holds one.

`checkRun(runId, phase)` refuses a run with a settlement intent, a snapshot whose expiry has come, or a state of `leaving`, `left`, `purging`, `done` or `failed`, then asks the host's `check`, and refuses a run without an allocation. A block-funded run is granted the least of the snapshot's seconds, the host's grant, its allocation's seconds and the block entitlement's `revalidateAllowance` answer; a block entitlement without `revalidateAllowance` must answer `revalidate` with true. A cash-funded run needs an account that is not frozen and its own hold, `held` and unexpired, and the supplier cost settled on the current UTC day plus every open supplier liability must be within the cap; it is granted the least of the snapshot's seconds and the host's grant. `revalidateAllowance(reference)` and `revalidate(reference)` answer `checkRun` at `revalidate`. `meter(reference, seconds)` takes a running total: a total above the snapshot's seconds or below the run's `reportedSeconds` throws, and so does a total for a run that `checkRun` refuses at `heartbeat`, except a run in `leaving`, `left` or `purging` whose cleanup is not complete, whose final usage is still taken. A block-funded run's total goes to its block entitlement's `meter`; a cash-funded run's hold is settled from the measured connection instead. The total is written as the run's `reportedSeconds`.

`finalize(reference, { unbilled })`, `settle(reference, billedSeconds)`, unbilled when `billedSeconds` is zero, and `release(reference)`, unbilled, end the run's funding. The first of them writes `fundingCleanup` with its billing decision, which later calls keep. Each call asks `close(run)`; an answer whose connected time or observation time is not a whole number, whose evidence is empty, or that was observed before the run's request or after now, throws. Without both fence flags the cleanup stays pending: a cash hold is deferred through `settleCompoundCredit` with the evidence, and the call throws. With them, the settlement intent is written once from the measured time: `connectedMs`, and `billedSeconds`, the connection rounded up to the second, or zero for an unbilled run. A measured time that rounds up to more than the snapshot's seconds throws, and so does a later close that measures another time. The allocation then settles once: a block allocation is settled for the intent's seconds, or released when unbilled, and a cash hold is settled by `settleCompoundCredit` from the connected time, with nothing charged to an unbilled run while its supplier cost still settles. `fundingCleanup.complete` is written last, and a call after it does nothing. A run that never held an allocation completes without a settlement once its fence is positive and it measured no connected time. `recover(runId)` resumes a run whose cleanup is written and not complete, under its recorded decision. Serialized, the entitlement is `[CompositeMeetingEntitlement]`, never its stores.

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

`SendBotRequest` supplies the owner, platform, meeting URL, name, Keep choice, notice and stop phrase. Optional fields select a provider, `joinAt`, limits, an idempotency key, transcriber and consent record id. `SendBotResult` returns the run and `repeated`, or a `SendBotRefusal` with a message. Repeating an owner's key returns its existing run even if the platform was paused meanwhile. Invalid nonfinite join times and negative or nonfinite limits throw before reserving. A reservation below ten minutes is refused by default; `minReservationSeconds` overrides that floor. Scheduled reservations are revalidated at dispatch; with the hook's `revalidateAllowance`, every dispatch is (see [Recoverable creation](#recoverable-creation)). `NoCapacityError` from provider dispatch ends the run as `no_capacity`. A manager whose `creation` selects funding refuses `sendBot` (see [Funded runs](#funded-runs)).

`start(intervalMs = 1000)` schedules ticks, one at a time: a pass still running when the next is due is not joined by it. `stop()` stops that timer without stopping bots. Hosts may drive `tick()` themselves. Each tick finishes the creations an interruption left pending (with `creation` set), dispatches due jobs, ends the runs gone silent when `usageSilenceMs` is set, checks the funded runs against their funding, enforces limits, resumes cleanup, starts the resumption of pending funding cleanups in the background and periodically reconciles. `reconcile()` queries provider usage for dispatched runs, ends workers reported gone, resumes purges and restores missing jobs for waiting runs. It ignores, and logs, a provider's answer about a run it did not ask that provider about. A job whose dispatcher lost its lease after the bot had reported is recorded as dispatched when the next dispatcher leases it, so reconcile watches that run too. The manager stores leave, suspension and alone timers on `MeetingRunRecord`, so a replacement manager can continue them.

`start()` runs a tick's two passes apart from each other, the dispatches (with the pending creations before them) and the upkeep (the usage silence, the funded runs' checks, the limits, kills, purges, the funding cleanups' resumption, eviction and the reconcile), so a dispatch a provider is slow to answer holds back no limit. A pass of either kind still running five intervals after it began is no longer waited for and the next one starts beside it, so a call that never answers, such as a command to a worker that froze, stops no later pass. `tick()` runs the two in turn.

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
| `transcriptSink`, `recordTranscript`, `takesTurns` | Obtain the allocating sink, emit an event for a turn already persisted by a caller, or ask whether a run takes turns now. |

`MeetingManagerConfig` and `MeetingManagerStores` type the setup; `MeetingManagerEventHandler` types subscriptions. The host's report route passes `ProviderEventContext` to `processProviderEvent(providerName, ctx)`. The provider's `verifyEvent(ctx, run)` returns `ProviderVerificationResult`; its `parseEvent` returns `ProviderParseResult` with `NormalizedMeetingEvent` entries and stable ids. Events verified against a run are applied only to that run. `ProviderEventType` describes incoming reports; `MeetingEventType` describes outgoing `bot:*` events. State reports emit their transitions, and heartbeats add no event rows. A report is applied once. One the worker sends again changes nothing, with two exceptions: its event's deliveries are enqueued again, which the outbox keeps once each, so a delivery the first attempt never enqueued goes out; and a stop the first attempt did not carry out is carried out. Deduplication is not an atomic transaction spanning event storage and every side effect: the rest of a report whose application failed after its event was stored is not applied again. A stored event reaches the handlers before its destinations are enqueued, so a destination lookup or an enqueue that fails keeps it from no handler; a step of the report's application that fails between storing the event and handing it on (a run store write), or a process that stops there, leaves a handler without it.

`DispatchInput` carries the run, publish token, per-run worker token and report URL; `DispatchResult` supplies worker references. `ProviderCommand` covers `startCapture`, `suspendCapture`, `postChat`, `leave` and `kill`. `ProviderUsage` reports whether a worker holds a run and its elapsed seconds, and, for a provider that measures it, its `supplierUsage`. These operations belong to the provider, not the outbound webhook envelope.

### A dispatch the provider refuses

A provider's `dispatch` throws `DispatchRefusedError(reason, message)` when the run will never start: `permission_denied` when the platform refused it for good, `no_capacity` when no worker has a slot (`NoCapacityError`). The manager ends the run at once with that reason: the job is removed, the room deleted, the reservation released, nothing billed, and `bot:left` carries the message for the host to read. Any other error is retried every `dispatchRetryDelayMs` until `dispatchRetryMs` has passed.

A worker's report may arrive before the provider's `dispatch` returns. The manager writes the worker's id to the run in whatever active state the report left it, and a cancel that arrived in the same window still becomes a leave.

A `left` report may carry a `message`: a provider's code word for why the run ended. `bot:left` carries it beside the reason, as it carries the message of a refused dispatch; a provider keeps it to a fixed list of words and never puts a word of the meeting there.

### Recoverable creation

A host that must commit its own record of a send (a consent record, a notice token) before any worker is sent for the run sends with `sendBotPrepared` and supplies `creation`, its entitlement hook's `reserveOnce`, and an idempotency key on every request. The example below locks per owner within one process; a host with several processes takes a database lock in `withOwnerLock` instead.

```ts
import {
  MeetingManager, type MeetingManagerConfig, type SendBotRequest, type SendBotResult,
} from '@framers/agentos/io/channels/meetings';

/** Runs each owner's work one at a time, in this process. */
const turns = new Map<string, Promise<unknown>>();
function withOwnerLock<T>(ownerRef: string, work: () => Promise<T>): Promise<T> {
  const turn = (turns.get(ownerRef) ?? Promise.resolve()).then(work, work);
  turns.set(ownerRef, turn.catch(() => undefined));
  return turn;
}

/** The host's own records of each send, written before the run's job exists. */
const sendRecords = new Map<string, string>();

/** The host's part in recoverable creation, and the guard that admits each dispatch under the same lock. */
const hostCreation: Pick<MeetingManagerConfig, 'creation' | 'dispatchGuard'> = {
  creation: {
    withOwnerLock,
    prepare: async (run, context) => {
      sendRecords.set(run.runId, context); // idempotent: a recovery calls it again with the same run and context
    },
  },
  dispatchGuard: (run, work) => withOwnerLock(run.ownerRef, work),
};

/** Sends through a manager built with `...hostCreation` in its config and a hook that has `reserveOnce`. */
function sendRecorded(manager: MeetingManager, request: SendBotRequest & { idempotencyKey: string }): Promise<SendBotResult> {
  return manager.sendBotPrepared(request, JSON.stringify({ accountId: request.ownerRef }));
}
```

Under the host's lock for the owner, `sendBotPrepared(request, context)` answers the run an earlier send with the same key made, as `sendBot` does. A new send is checked as `sendBot` checks one, and `creation.admit`, when given, may refuse it by throwing before anything is written. The manager then writes the run with `creationPending: true` and the host's opaque `context` as `creationContext`, reserves through `reserveOnce` by the run's id, writes the reservation and cuts the run's limit to it, calls `creation.prepare(run, context)`, schedules the run's job, clears both fields and emits `bot:requested`. An interruption at any step leaves the run pending. A send repeated with the same key, or the next pass of the loop, finishes that same run from where it stopped, with the context first given and one reservation: `reserveOnce` must return the same committed reservation for a run id even after the caller lost its answer, and `prepare` must be idempotent. No job of a pending run is dispatched, and reconcile gives a pending run no job.

A reservation `reserveOnce` refuses, or one under `minReservationSeconds`, is released, and the run is answered `{ ok: true }` in the state `failed`, with the refusal's reason (`allowance` for a short reservation). A creation still unfinished `dispatchRetryMs` after the run's join time, or after its request when that is later, ends the run `crashed`, unbilled, with its hold released; until then each pass tries again. The run store must keep both fields; `sendBotPrepared` re-reads the run it wrote, and when the store dropped them it ends the run `crashed` and throws. `InMemoryRunStore` keeps both, and `SqlRunStore` keeps both in `creation_pending` and `creation_context`, the context sealed (tables an earlier version made take `meetingStoresUpgradeDdl` first). The run's terminal write clears both, whatever ends it.

`dispatchGuard(run, work)` admits each dispatch of a leased job, a first one and a recovered one, under the host's own serialization: it calls `work` only when it admits the dispatch, and `work` reads the run again before it acts. A dispatch the guard does not admit keeps its lease and is offered again once the lease runs out (`leaseTtlMs`), or sooner when the host releases the job with `IJobStore.release` under the manager's `managerId`.

With the hook's `revalidateAllowance`, the manager asks for the run's grant before every worker it sends: a run sent now, a scheduled run, and a run whose dispatch is tried again after its bot was found not running. A bot found running is not asked about. The answer, a `DispatchAllowance`, cuts the run's `limits.totalMs` to its `maxSeconds`, and the manager writes the cut limit on the run before the provider receives the run. `{ ok: false }`, or a grant that is not finite or is under `minReservationSeconds`, ends the run `allowance` before any dispatch. Without `revalidateAllowance`, a scheduled run is revalidated with the boolean `revalidate`, and a run sent now is not asked again. `sendBot`, `reserve` and `revalidate` keep their signatures.

### Funded runs

A host that funds each run from a snapshot of its own choosing (see [Persisted funding](#persisted-funding)) adds `creation.funding(request, context, runId)` to recoverable creation. It also gives the manager a `dispatchGuard`, an entitlement hook with `reserveOnce`, `checkRun`, `recover` and `finalize` (`CompositeMeetingEntitlement` has all four), and a run store with `listFundingPending`; `sendBotPrepared` throws without them, and a manager with the selector refuses `sendBot`. For a new send the manager calls the selector once, under the owner's lock, after `admit` and before anything is written, with the id the run is written under, and writes the snapshot with the pending run. A snapshot that does not fit the run (`assertMeetingFundingChange`), or one that expires no later than the run's join time plus its total limit, throws before the run is written. A send its idempotency key repeats answers the stored run and calls no selector, so a recovered creation keeps its first funding.

From then on the run's own funding decides each step, through the hook's `checkRun`:

- Dispatch: a leased job of a waiting funded run is checked at `dispatch`, and a dispatch being recovered at `recovery`, before any worker is sent; the hook's `revalidateAllowance` is not asked for it. Dispatching a funded run on a manager without a `dispatchGuard`, after a restart too, throws.
- While it runs: a `usage`, `monitor_heartbeat` or `capture_started` report is checked at `heartbeat` before it is applied, and so is each start of capture; every upkeep pass checks each dispatched funded run at `heartbeat`, and every reconcile at `recovery`. A run on its way out (`leaving`, `left` or `purging`) still reports its last usage unchecked.
- A refusal, a check that throws, or a grant that is not a whole number of seconds above zero (or is under `minReservationSeconds` at `dispatch` or `recovery`) stops the run: its capture is suspended, then a run not yet out ends `allowance` with its job cancelled, and a run that is out is told to leave with `allowance`. A grant shorter than the run's limit cuts `limits.totalMs` to it on the run.

A funded run's end finalizes its funding through the hook's `finalize(reservationRef, { unbilled })`: unbilled when the end is not billed (`isBilledEnd`), and always for a run that ends before it joined. The billed seconds come from the hook's settlement, taken from the measured close, never from the worker's count: the run's `billedSeconds` and its `bot:done` carry the settlement's `billedSeconds`, so a run measured at 31,000 connected milliseconds bills 31 seconds whatever its usage reports said. While the hook's close or settlement is pending, `finalize` throws and the run's end stays where it was (`left`, `purging`, or `cleanupPending` on a run that ends before it joined), to be tried again on the next pass. The run's last write reads the run again first, so it keeps the funding link and the settlement the hook wrote meanwhile. A creation that finds the run's settlement written (its hook released the allocation it refused) ends the run, and reconcile gives such a waiting run no job.

Each upkeep pass also starts, unless the last one is still running, the resumption of the funding cleanups a close left pending: a page of at most 64 runs from `listFundingPending`, each handed to the hook's `recover`, the next pass continuing after a full page. No pass waits for it, so a close that does not answer holds back no dispatch and no limit; a resumption that fails is logged as `funding recovery pending` and tried again. A manager whose `creation` has no selector, and whose hook has no `checkRun`, lists nothing for the funded runs' checks. The hook's close can be asked from inside the host's own `withOwnerLock` or `dispatchGuard` work (a creation or a dispatch that ends its run), so a lock it takes there must allow that without taking a non-reentrant lock a second time.

## Capture, limits and billing

Capture opens only in `in_call`, after the provider confirms the notice and a monitor heartbeat the worker made at or after that confirmation, by the worker's own clock, is still fresh. Providers must forward no audio before `startCapture`, or after `suspendCapture` until another start. The notice alone never opens capture. The host must connect its listener only to that controlled audio path. The transcript sink and `recordTranscript` take a turn only for a run whose capture has started or whose interlock holds (`takesTurns`: the start can be on its way to the bot, which may send its first audio before the start is written on the run), and drop turns behind the fence; that is not proof that audio was captured with permission.

With default manager options, an unconfirmed notice times out after 30 seconds. A monitor with an observed heartbeat becomes stale at 30 seconds, triggering suspension; another 30 seconds without recovery causes a leave. A report's time counts as at most one heartbeat interval past the manager's clock (10 seconds with the defaults), so a worker whose clock runs ahead keeps a quiet monitor counted healthy, or the waiting-room, notice and alone limits open, for no more than that. The heartbeats are ordered against the notice on the worker's own clock, never on those bounded times: a heartbeat the worker made before the notice, or one applied before the notice was confirmed, is not counted. A notice followed by no heartbeat keeps capture closed, and the run leaves with `stop_monitor_failed` once the window and the recovery wait have passed without one (60 seconds after the notice with the defaults; with a worker clock that runs ahead, counted from no later than 30 seconds after the bot entered the call). A participant who joins after the notice gets `MeetingNotice.lateArrivalText` when the provider supports chat, posted before the count is written and the event delivered, so a write or a delivery that fails does not keep it back; the worker's retry of that report posts nothing again. Any chat message containing the stop phrase, case-insensitively, or a `stop_command` report starts a participant purge. The purge goes ahead even when the message's delivery fails, whose error is raised after it.

`DEFAULT_RUN_LIMITS` gives ten minutes in the waiting room, five minutes alone and four hours total. Total time starts at dispatch; the waiting-room limit counts from the bot's arrival in the waiting room (`joinedAt`, which admission then moves to the time the bot entered the call), or from dispatch when no waiting room was reported. The alone timer follows reports of zero participants besides the bot. There is no default page-away limit: a page host can pass `limits: { pageAwayMs: 120000 }` and call `pageSeen`. API clients can omit it.

`MeetingRunState`, `RUN_TRANSITIONS`, `TERMINAL_RUN_STATES` and `canTransition` expose the state graph. `MeetingRunLimits`, `MeetingLeaveReason`, `MeetingNotice` and `MeetingDispatchRecord` type run policy and metadata. `isBilledEnd` requires capture and excludes every `UNBILLED_REASONS` entry: `not_admitted`, `notice_failed`, `stop_monitor_failed`, `permission_denied` and `no_capacity`, even after capture. Otherwise settlement uses the largest total the worker reported (a report sent again, or one that arrives late, never lowers it), or elapsed seconds from dispatch when no total was reported; a funded run bills the seconds its funding settlement records instead (see [Funded runs](#funded-runs)). A crash reported after the bot left changes neither its leaving time nor that total. Each usage report emits `bot:usage`, and it is metered through `entitlement.meter` when the run holds a reservation and its capture has started: a usage report before capture emits `bot:usage` alone. The provider's reports set the cadence; the manager emits no `bot:usage` of its own between them.

A provider whose supplier bills for the media it carries may report `supplierUsage` (`SupplierUsage`: the seconds the supplier's stream was open and the seconds of it during which capture was open, both running totals, with `final` on the last) on any report, and in `ProviderUsage` for reconciliation. The manager hands a report's totals to `entitlement.recordSupplierUsage` when the hook has that method, before its terminal and fence checks, so a run that ends unbilled, or has already ended, still records what it cost; reconciliation hands over the totals the provider's usage answers for each run it polls. The hook may receive the same totals again and keeps the largest of each. Without the method nothing is recorded, and metering, settlement and release are unchanged.

A report's totals the hook refuses never stop the report: a `left` or `crashed` report still ends the run, settles or releases its reservation and cleans up. With `supplierUsageInbox` in the manager's stores (an `IDurableInbox<PendingSupplierUsage>`, such as a `SqlDurableInbox`), the refused totals wait there, and the next `reconcile()` hands them to the hook again and acknowledges each one it records. A total recorded but not acknowledged is handed over again at the next pass (the hook keeps the largest of each), and the first such failure is the error that `reconcile()` throws once its work is done. Reconciliation treats the totals a provider's usage answers the same way: a run whose worker is gone still ends as crashed, its job removed with the cleanup, and its refused final totals wait in the inbox. Without an inbox, `processProviderEvent` throws the hook's error once the report is applied, and `reconcile()` throws it at the end of the pass.

## Rooms and listening

`MeetingRoom.create(runId)` creates `bot-<runId>` at dispatch, with at most two participants, a 60-second empty timeout, a 45-second departure timeout and 600-second tokens. `MeetingRoomOptions` overrides the prefix, timeouts, token lifetime and identities (`bot` and `agent`). `MeetingRoomHandle` holds the room name, service URL, identities and both tokens. The host's `IMeetingRoomService` must create existing rooms idempotently, mint the requested publish/subscribe rights with no data-publishing grant, and report an absent room on delete with `status: 404`. `MeetingRoom.delete` ignores that status and passes on any other rejection as it is, for retry. A room whose token cannot be minted is deleted again and the mint's failure passed on.

The manager passes the publish-only token to the provider and retains only room metadata and the worker token's hash. It does not expose or retain the subscribe token the helper minted. When the listener connects, the host takes a fresh subscribe-only token for the run's room from `MeetingRoom.agentToken(run.dispatch.roomName)`, minted for the agent's identity with the helper's token lifetime: one minted at dispatch may have expired by then, since a run can wait in the waiting room longer than a token lives. Tokens must not go into events or the outbox.

`startListenSession(transport, manager.transcriptSink(runId), { streamingSTT, runId })` comes from `@framers/agentos/io/voice-pipeline`. It needs no synthesis, barge-in handler or agent turn. `LiveKitStreamTransport`, from `@framers/agentos/io/hearing/livekit`, subscribes to the bot's audio at the transcriber's rate; see [LiveKit Rooms](VOICE_PIPELINE.md#livekit-rooms).

`MeetingTranscriptSink` implements `ITranscriptInputSink`: each `TranscriptInput` becomes a `TranscriptTurn` with `<runId>:<n>` assigned atomically across sink instances, followed by `bot:transcript`. It requires a store implementing `appendNext`. The older `ITranscriptSink.append` takes an already numbered turn. Turns for a missing, terminal or purging run, or for a run whose capture has neither started nor can start, and fenced writes are dropped. Read turns and events using their separate sequence cursors.

The listen session wraps one provider in `ReconnectingSTT` by default, with up to three reconnect attempts per minute and buffered replay before queued live audio. Pass `reconnect: false` for a multi-provider failover chain. An optional endpoint detector groups finals into turns; otherwise each final is a turn. A slow sink asks the transport to pause. The LiveKit transport holds two seconds by default and reports overflow with a `gap` event. `close('stopped')` hands the transcriber the audio the transport held before it flushes; audio dropped beyond the buffer is lost, as the `gap` reports, and a purge, or a transport that closes, drops what is held.

End reasons are `stopped`, `purged`, `stt_failed`, `transport_closed`, `transport_failed` and `sink_failed`. `close('stopped')` flushes the transcriber and waits for pending detector output; `close('purged')` drops queued turns without flushing. Every end releases a pause and removes the session's transport listeners, but leaves the transport open. The host closes it and maps session failures to its run policy; the session does not call `leaveBot` itself. Fence the run before closing for purge so an in-flight write is refused too.

## The purge

Use `purgeRun` for an owner's deletion or a decline. `leaveBot` alone preserves the Keep choice. A run that ends with `permission_denied` (a provider's `left` report with that reason) runs the purge sequence whatever its Keep, and participant stop messages invoke it through the manager's lifecycle.

An active purge changes the run to `purging`, fences transcripts and event payloads, and fences and scrubs the outbox. The bot is told to suspend capture and leave; a bot not reported gone after the configured leave deadline gets a kill command. Store content is removed immediately, without waiting for that exit. Once the bot has left or the kill path records its end, the manager runs host purge hooks, provider deletion, room deletion, settlement and job removal, emits `bot:purged` and `bot:done`, and then atomically writes the terminal content-free run. A step that fails, the events' delivery included, leaves the run `purging`, and a later tick runs the steps again; an event already stored is delivered again, not stored twice. A purge of an already completed run keeps its terminal state; a rejected cleanup step on that path must be retried by the caller, and its `bot:purged` goes out before the row is rewritten, so the retry sends one that failed.

`CONTENT_EVENT_TYPES` includes chat, transcript, participant-joined, participant-left and stop-command payloads. Their event metadata remains. A content event that reaches the event store behind a fence that went up while it was on its way is stored without its payload, and its delivery and its handlers receive it without one too. Outbox content is scrubbed even from delivered rows: its payload becomes empty and its type becomes `bot:purged`. Content-free deliveries keep their type and payload, except in a `FencedOutbox`, which stores every delivery enqueued after the fence as `bot:purged` with an empty payload. A delivery a sender fetched earlier is a copy the store cannot recall: the dispatcher sends through `sendClaimed`, which re-reads it and which a purge of its run cancels, and a host's own sender must honor the current purge state the same way, including before replay. The host implements deletion of listener history, output queues, kept summaries and client copies through its purge path and hooks.

`contentFreeRun` clears the meeting URL, bot name, notice text and stop phrase. It retains ids and settings (owner, provider, the provider's connection reference, platform, state, Keep, limits, idempotency and reservation ids), lifecycle times, reason, billed seconds, notice version and consent record id, the funding fields (`funding`, `fundingReservationId`, `fundingSettlement` and `fundingCleanup`), and the usage evidence: `lastUsageAt`, `lastUsageSourceAt`, `reportedSeconds` and `lastReportAt`. Terminal cleanup also clears dispatch and timer fields and the creation fields (`creationPending`, `creationContext`); it keeps the usage evidence, and a completed run's `reportedSeconds` is the total it was settled from, a `done` report's included, whenever a report gave one. Ordinary completion with `keep: 'account'` retains the bot name, notice and stored content; `keep: 'none'` clears stored content and, unless the manager's `scrubUnkeptOutbox` is false, empties the run's content deliveries in the outbox, pending and delivered, before `done`, as a purge does. With `scrubUnkeptOutbox: false` the deliveries pending at completion keep their bodies for their retries.

## A worker that cannot be reached

The manager arms a run's kill before sending leave and re-arms unfinished leaves after restart. Hosts may opt into `usageSilenceMs`; omitted leaves the prior reconciliation policy unchanged. With 120000, a dispatched or dispatching run without fresh usage for two minutes ends crashed at its durable last usage receipt and reported total, irrespective of heartbeats or provider liveness.

The deadline is on the run (`leaveCommandedAt`), so whichever manager runs the limits, one that restarted included, sends the kill thirty seconds after the leave, by default, and records the end whether or not the worker answers. The kill is not waited for, so one the provider never answers holds back neither that run's end nor any other run in the pass. A run in `leaving`, or in `purging` with a dispatched bot that has not left, that holds no deadline gets one on the next pass, counted from then. A purge writes its fence without the deadline when a dispatcher takes the run between the purge's read and its fence, and writes the deadline after it, in a write of its own, so a process that stops between the two leaves the run `purging` with none. A leave writes its state and its deadline in one write, so a run in `leaving` without one is a row the manager did not write, such as one a host's own migration made without the field. A command on the way out (a purge's suspend, a leave or a kill) that fails is logged and not thrown.

With `usageSilenceMs` set:

- Each usage report the manager takes writes `lastUsageAt` on the manager's own clock, `lastUsageSourceAt` (the worker's time on the report) and `reportedSeconds`, the largest running total, before the total is metered. A report the worker made no later than `lastUsageSourceAt`, one sent again or one that arrives late, is delivered as its `bot:usage` event, is not metered, and moves neither the clock nor the total. Both are decided on the run's row in the write, through the run store's `updateWith`, so of two reports applied at once the older never writes its time, or a smaller total, over the newer one's. A stop-monitor heartbeat or any other report never moves them; `lastReportAt` records when the manager last took a report of any kind, a late usage report it stored and delivered without metering included.
- Every pass of the upkeep, and every `reconcile()`, ends each run in `dispatching`, `joining`, `waiting_room`, `in_call_notice_pending`, `in_call` or `leaving` whose silence has reached the threshold, counted from `lastUsageAt`, or from the dispatch when no usage came: the run ends `crashed` (a run told to leave keeps its reason), with `leftAt` at that last receipt and the total its usage reports gave, nothing when none did, and then the bot is sent a kill, not waited for. The silence is decided again on the run's row in the write that ends it, through the run store's `updateWith`, so a usage report taken after the pass read the runs keeps its run, and its worker gets no kill. A dispatching run is among them whatever its job's state: one whose dispatcher stopped before recording the dispatch, one whose dispatch is being retried, and one whose provider has not answered yet, so a threshold shorter than `dispatchRetryMs`, or than a provider's slowest dispatch, ends such a dispatch first; when the provider answers after the run ended, the dispatcher kills the worker it started. The run is billed as any crash is: only when its capture had started.
- A run whose container a provider's usage reports gone ends at the total its usage reports gave, never at the provider's own count.
- A value that is not a finite number of milliseconds above zero is refused with a `RangeError` when the manager is built, and a run store without `updateWith` with a `TypeError`.

## Helpers for a provider's own lifecycle

A provider that holds a media stream outside the manager (a worker that connects, publishes, suspends and leaves on the manager's commands) can use three helpers. None is required.

`LifecycleSerial` orders that work and fences a start in flight. `run(work)` queues `work` behind every operation queued before it, whether those resolved or rejected. A start takes `stamp()` before its first await and publishes only while `allows(stamp)` holds; a suspension or an end calls `invalidate()` before it queues its own work, so a start still in flight never publishes after it. `invalidate(true)` ends the lifecycle for good: `ended` is true and no stamp is allowed again.

`writeDurableJson(path, value)` replaces a private state file atomically: it writes a new file with mode `0600`, syncs it, renames it over the old one and syncs the directory. When the write or the rename fails, it removes the new file and throws the error, so no copy of the state is left beside the file. `removeDurableJson(path)` deletes the file and syncs the directory; a file already missing counts as removed.

`IDurableInbox` keeps the deliveries a receiver accepted until it acknowledges them, so work a restart interrupted is found again. `accept(entry)` answers false for an id it has accepted before; `pending()` lists the unacknowledged entries, oldest first; `acknowledge(id)` drops the payload and keeps the id, so a replay is still refused. `MemoryDurableInbox` serves tests and a single process. `SqlDurableInbox(db, prefix, box)` seals each payload with `box` (a `SecretBox`, for example) in the Postgres table `durableInboxDdl(prefix)` creates, `<prefix>_inbox`; apply that DDL in the host's migration.

## Verifying an outbound envelope

`OutboxDispatcher` signs each delivery with `envelopeHeaders`; a host that sends deliveries itself signs them with `signEnvelope` or `envelopeHeaders`. This envelope is not Standard Webhooks: it uses the secret's UTF-8 bytes without removing a `whsec_` prefix or base64 decoding, timestamps in milliseconds, one `v1,` signature rather than a space-separated signature list, and `x-webhook-*` headers by default.

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

`SecretBox(currentKey, { previousKeys })` copies each 32-byte key. `seal(text, context)` uses the current key with a fresh nonce; `open(sealed, context)` tries the current key, then previous keys. The form is `v1.box.<base64url(nonce | ciphertext | tag)>` using the library's AES-256-GCM sealing. Wrong keys, context or authentication fail. `SqlRunStore` uses the run id as the URL's context, and the run and the column as the creation context's; ordinary updates reseal both under the current key. Retain previous keys until every retained row has been rewritten. `SecretBox` and `SqlRunStore` print redacted markers under `JSON.stringify` (`toJSON()`) and under `util.inspect`, which `console.log` and loggers built on it use; a logger that reads an object's fields some other way is not covered.

`MockMeetingBotProvider` records dispatches and commands without joining a meeting. Tests can set `alive`, `dispatchError` and `beforeDispatch`, inspect `dispatched`, `commands` and `deleted`, obtain `tokenOf(runId)`, and use its static `hash` helper. `mockEventContext` builds an authenticated report context. Mock report ids include a body digest, so retries share an id while distinct reports at the same time remain distinct. The mock's URL patterns accept Meet and Teams test links; they are not a production browser's network policy.
