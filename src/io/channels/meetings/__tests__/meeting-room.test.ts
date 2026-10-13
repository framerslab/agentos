import { describe, it, expect } from 'vitest';
import { MeetingRoom, type IMeetingRoomService } from '../MeetingRoom.js';

describe('MeetingRoom', () => {
  it('makes bot-<runId> with the bot and agent identities, a publish-only and a subscribe-only token, and deletes it', async () => {
    const calls: unknown[] = [];
    const service: IMeetingRoomService = {
      url: 'wss://lk.test',
      async createRoom(input) { calls.push(['create', input]); },
      async deleteRoom(name) { calls.push(['delete', name]); },
      async mintToken(input) { calls.push(['token', input]); return `jwt:${input.identity}`; },
    };
    const rooms = new MeetingRoom(service, { tokenTtlSeconds: 900 });
    const room = await rooms.create('r1');
    expect(room).toEqual({ url: 'wss://lk.test', name: 'bot-r1', botIdentity: 'bot', agentIdentity: 'agent', publishToken: 'jwt:bot', subscribeToken: 'jwt:agent' });
    expect(calls[0]).toEqual(['create', { name: 'bot-r1', emptyTimeoutSeconds: 60, departureTimeoutSeconds: 45, maxParticipants: 2 }]);
    expect(calls[1]).toEqual(['token', { room: 'bot-r1', identity: 'bot', canPublish: true, canSubscribe: false, ttlSeconds: 900 }]);
    expect(calls[2]).toEqual(['token', { room: 'bot-r1', identity: 'agent', canPublish: false, canSubscribe: true, ttlSeconds: 900 }]);
    await rooms.delete('bot-r1');
    expect(calls[3]).toEqual(['delete', 'bot-r1']);
  });
  it('ignores a delete of a room that is already gone', async () => {
    const service: IMeetingRoomService = {
      url: 'wss://lk.test',
      async createRoom() {},
      async deleteRoom() { throw Object.assign(new Error('not found'), { status: 404 }); },
      async mintToken() { return 'jwt'; },
    };
    await expect(new MeetingRoom(service).delete('bot-x')).resolves.toBeUndefined();
  });
  it('passes on any other failure of a delete, so the caller tries it again', async () => {
    // a server that answers with another status, and one that cannot be reached (no status at all)
    for (const failure of [Object.assign(new Error('unavailable'), { status: 503 }), new TypeError('fetch failed')]) {
      const service: IMeetingRoomService = {
        url: 'wss://lk.test',
        async createRoom() {},
        async deleteRoom() { throw failure; },
        async mintToken() { return 'jwt'; },
      };
      await expect(new MeetingRoom(service).delete('bot-x')).rejects.toBe(failure);
    }
  });
  it('passes on a rejection of a delete that is not an object as it is', async () => {
    for (const failure of [undefined, null, 'unavailable']) {
      const service: IMeetingRoomService = {
        url: 'wss://lk.test',
        async createRoom() {},
        async deleteRoom() { throw failure; },
        async mintToken() { return 'jwt'; },
      };
      await expect(new MeetingRoom(service).delete('bot-x')).rejects.toBe(failure);
    }
  });
  it('deletes the room again when a token for it cannot be minted, and passes the failure on', async () => {
    const calls: unknown[] = [];
    const failure = new Error('token service unavailable');
    const service: IMeetingRoomService = {
      url: 'wss://lk.test',
      async createRoom(input) { calls.push(['create', input.name]); },
      async deleteRoom(name) { calls.push(['delete', name]); },
      async mintToken(input) {
        if (input.identity === 'agent') throw failure;
        return `jwt:${input.identity}`;
      },
    };
    await expect(new MeetingRoom(service).create('r1')).rejects.toBe(failure);
    expect(calls).toEqual([['create', 'bot-r1'], ['delete', 'bot-r1']]);
  });
  it('mints the listening agent a subscribe-only token for a run\'s room when it connects', async () => {
    const minted: unknown[] = [];
    const service: IMeetingRoomService = {
      url: 'wss://lk.test',
      async createRoom() {},
      async deleteRoom() {},
      async mintToken(input) { minted.push(input); return `jwt:${input.room}:${input.identity}`; },
    };
    const rooms = new MeetingRoom(service, { tokenTtlSeconds: 300, agentIdentity: 'listener' });
    expect(await rooms.agentToken('bot-r1')).toBe('jwt:bot-r1:listener');
    expect(minted).toEqual([{ room: 'bot-r1', identity: 'listener', canPublish: false, canSubscribe: true, ttlSeconds: 300 }]);
  });
});
