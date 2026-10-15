import { describe, it, expect } from 'vitest';
import * as meetings from '../index.js';

describe('the meetings barrel', () => {
  it("exports the manager, the room helper, the stores, the fenced outbox, the signing, the outbox's delivery and the mock provider", () => {
    for (const name of ['MeetingManager', 'NoCapacityError', 'MeetingTranscriptSink', 'MeetingRoom', 'InMemoryRunStore', 'InMemoryJobStore', 'InMemoryTranscriptStore', 'InMemoryEventStore', 'InMemoryOutbox', 'InMemoryEntitlementHook', 'SystemClock', 'FakeClock', 'FencedOutbox', 'MemoryDeliveryFence', 'SqlRunStore', 'SqlJobStore', 'SqlTranscriptStore', 'SqlEventStore', 'SqlOutbox', 'SqlDeliveryFence', 'meetingStoresDdl', 'meetingStoresUpgradeDdl', 'signEnvelope', 'verifyEnvelope', 'mintWorkerToken', 'SecretBox', 'OutboxDispatcher', 'httpsSend', 'isPublicAddress', 'DestinationRefusedError', 'MockMeetingBotProvider', 'canTransition', 'contentFreeRun', 'FencedError'] as const) {
      expect(typeof (meetings as Record<string, unknown>)[name], name).toMatch(/function|object/);
    }
  });
});
