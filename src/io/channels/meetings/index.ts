/**
 * Barrel exports for the meeting-participant channel: the manager, the provider interface, the room helper, the stores,
 * the signing and the mock provider.
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
export { MeetingManager, NoCapacityError } from './MeetingManager.js';
export type { MeetingManagerConfig, MeetingManagerStores, MeetingManagerEvent, MeetingManagerEventHandler } from './MeetingManager.js';
export { MeetingTranscriptSink } from './MeetingTranscriptSink.js';
export { MeetingRoom } from './MeetingRoom.js';
export type { IMeetingRoomService, MeetingRoomOptions, MeetingRoomHandle } from './MeetingRoom.js';
export * from './stores/types.js';
export { InMemoryRunStore, InMemoryJobStore, InMemoryTranscriptStore, InMemoryEventStore, InMemoryOutbox, InMemoryEntitlementHook, SystemClock, FakeClock } from './stores/memory.js';
export { SqlRunStore, SqlJobStore, SqlTranscriptStore, SqlEventStore, SqlOutbox, meetingStoresDdl, meetingStoreTables, MEETING_STORES_DDL, DEFAULT_TABLE_PREFIX } from './stores/sql.js';
export type { SqlStoreOptions, SqlRunStoreOptions, MeetingStoreTables } from './stores/sql.js';
export { signEnvelope, envelopeHeaders, verifyEnvelope, mintWorkerToken, hashWorkerToken, workerTokenMatches, SecretBox, DEFAULT_ENVELOPE_HEADERS, ENVELOPE_WINDOW_MS } from './signing.js';
export type { EnvelopeHeaderNames } from './signing.js';
export { MockMeetingBotProvider, mockEventContext } from './providers/mock.js';
