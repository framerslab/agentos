/**
 * The manager's test harness, shared by its test files: in-memory stores, a fake room service and a fake entitlement
 * hook, the mock provider, and a manager on them that collects every event it emits. A test file imports it from here,
 * never from another test file, which would register that file's tests a second time.
 */
import { MeetingManager, type MeetingManagerConfig, type MeetingManagerEvent } from '../MeetingManager.js';
import { FakeClock, InMemoryEventStore, InMemoryJobStore, InMemoryOutbox, InMemoryRunStore, InMemoryTranscriptStore } from '../stores/memory.js';
import { MockMeetingBotProvider, mockEventContext } from '../providers/mock.js';
import type { IEntitlementHook, ReserveResult } from '../stores/types.js';
import { MeetingRoom, type IMeetingRoomService } from '../MeetingRoom.js';

/** A room service that records the rooms it makes and deletes. */
export class FakeRooms implements IMeetingRoomService {
  readonly url = 'wss://lk.test';
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  /** When set, createRoom rejects with it (a room service that is down). */
  createError: Error | undefined;
  async createRoom(input: { name: string }): Promise<void> {
    if (this.createError) throw this.createError;
    this.created.push(input.name);
  }
  async deleteRoom(name: string): Promise<void> {
    this.deleted.push(name);
  }
  async mintToken(input: { room: string; identity: string; canPublish: boolean }): Promise<string> {
    return `jwt:${input.room}:${input.identity}:${input.canPublish ? 'pub' : 'sub'}`;
  }
}

/** An entitlement hook that answers what a test sets and records what the manager asked of it. */
export class FakeEntitlement implements IEntitlementHook {
  reserveAnswer: ReserveResult = { ok: true, reservationId: 'res-1', maxSeconds: 14_400 };
  revalidateAnswer = true;
  /** When it answers true, the next settle throws (a billing store that is down for a moment). */
  settleThrows: (() => boolean) | undefined;
  readonly metered: Array<[string, number]> = [];
  readonly settled: Array<[string, number]> = [];
  readonly released: string[] = [];
  async reserve(): Promise<ReserveResult> {
    return this.reserveAnswer;
  }
  async revalidate(): Promise<boolean> {
    return this.revalidateAnswer;
  }
  async meter(id: string, s: number): Promise<void> {
    this.metered.push([id, s]);
  }
  async settle(id: string, s: number): Promise<void> {
    if (this.settleThrows?.()) throw new Error('billing is down');
    if (!this.settled.some(([i]) => i === id)) this.settled.push([id, s]); // idempotent, as the interface asks
  }
  async release(id: string): Promise<void> {
    this.released.push(id);
  }
}

/** What a test may give the harness's manager besides its stores. */
export interface HarnessOptions {
  /** The owner's destinations; without it, nothing is enqueued in the outbox. */
  destinationsFor?: MeetingManagerConfig['destinationsFor'];
}

/** A manager on fresh in-memory stores with the mock provider registered, a clock at 1000000 and its events collected. */
export function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock(1_000_000);
  const provider = new MockMeetingBotProvider();
  const entitlement = new FakeEntitlement();
  const rooms = new FakeRooms();
  const stores = { runs: new InMemoryRunStore(), jobs: new InMemoryJobStore(), transcript: new InMemoryTranscriptStore(), events: new InMemoryEventStore(), outbox: new InMemoryOutbox(), entitlement, clock };
  const manager = new MeetingManager({ managerId: 'm1', stores, room: new MeetingRoom(rooms), reportUrlFor: (runId, p) => `https://product.test/events/${p}/${runId}`, destinationsFor: options.destinationsFor });
  manager.registerProvider(provider);
  const seen: MeetingManagerEvent[] = [];
  manager.on((e) => {
    seen.push(e);
  });
  const request = { ownerRef: 'acct_1', platform: 'google_meet' as const, meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: "Dana's notes", keep: 'none' as const, notice: { text: 'the notice', version: '1', lateArrivalText: 'the short notice' }, stopPhrase: 'stop taking notes', idempotencyKey: 'k1' };
  const report = (runId: string, type: Parameters<typeof mockEventContext>[1], data: Parameters<typeof mockEventContext>[2] = {}, at = clock.now()) =>
    manager.processProviderEvent('mock', mockEventContext(runId, type, data, at, provider.tokenOf(runId)));
  /** Another manager on the same stores and provider: a second process, or the first one after a restart, with nothing of its memory. */
  const peer = (managerId: string) => {
    const other = new MeetingManager({ managerId, stores, room: new MeetingRoom(rooms), reportUrlFor: (runId, p) => `https://product.test/events/${p}/${runId}`, destinationsFor: options.destinationsFor });
    other.registerProvider(provider);
    return other;
  };
  return { clock, provider, entitlement, rooms, stores, manager, seen, request, report, peer };
}
