/**
 * Barrel exports for the meeting-participant channel: the manager, the provider interface, the room helper, the stores,
 * the fenced outbox, the signing, the outbox's delivery, the mock provider, the visitor-bound demonstration capability
 * and the composite funding entitlement.
 *
 * @module @framers/agentos/io/channels/meetings
 */

export * from './types.js';
export type { ITranscriptInputSink, TranscriptInput } from '../../voice-pipeline/types.js';
export type {
  IMeetingBotProvider,
  ProviderEventContext,
  ProviderVerificationResult,
  ProviderParseResult,
  DispatchInput,
  DispatchResult,
  ProviderCommand,
  ProviderUsage,
} from './IMeetingBotProvider.js';
export { MeetingManager, NoCapacityError, DispatchRefusedError } from './MeetingManager.js';
export type { MeetingManagerConfig, MeetingManagerStores, MeetingManagerEvent, MeetingManagerEventHandler } from './MeetingManager.js';
export { MeetingTranscriptSink } from './MeetingTranscriptSink.js';
export { MeetingRoom } from './MeetingRoom.js';
export type { IMeetingRoomService, MeetingRoomOptions, MeetingRoomHandle } from './MeetingRoom.js';
export * from './stores/types.js';
export { InMemoryRunStore, InMemoryJobStore, InMemoryTranscriptStore, InMemoryEventStore, InMemoryOutbox, InMemoryEntitlementHook, SystemClock, FakeClock } from './stores/memory.js';
export { FencedOutbox, MemoryDeliveryFence } from './stores/fenced-outbox.js';
export type { DeliveryFence } from './stores/fenced-outbox.js';
export { SqlRunStore, SqlJobStore, SqlTranscriptStore, SqlEventStore, SqlOutbox, SqlDeliveryFence, meetingStoresDdl, meetingStoresUpgradeDdl, meetingStoreTables, MEETING_STORES_DDL, DEFAULT_TABLE_PREFIX } from './stores/sql.js';
export type { SqlStoreOptions, SqlRunStoreOptions, MeetingStoreTables } from './stores/sql.js';
export { connectionRuns, meetingProvenanceDdl } from './stores/provenance.js';
export { LifecycleSerial } from './LifecycleSerial.js';
export { MemoryDurableInbox, SqlDurableInbox, durableInboxDdl, type IDurableInbox, type InboxEntry } from './DurableInbox.js';
export { writeDurableJson, removeDurableJson } from './durableJson.js';
export { signEnvelope, envelopeHeaders, verifyEnvelope, mintWorkerToken, hashWorkerToken, workerTokenMatches, SecretBox, DEFAULT_ENVELOPE_HEADERS, ENVELOPE_WINDOW_MS } from './signing.js';
export type { EnvelopeHeaderNames } from './signing.js';
export { OutboxDispatcher, httpsSend, isPublicAddress, DestinationRefusedError } from './delivery.js';
export type { OutboxDispatcherOptions, DeliveryRequest, DeliverySend, DeliveryDestination, AddressLookup, MailOutcome, MailSend } from './delivery.js';
export { MockMeetingBotProvider, mockEventContext } from './providers/mock.js';
/** Visitor-bound authority with a host-owned transactional store. */
export * from './DemoRunCapability.js';
export * from './stores/demo.js';
/** Immutable funding choice and quantity settlement. */
export * from './CompositeMeetingEntitlement.js';
export { meetingFundingUpgradeDdl } from './stores/sql.js';
