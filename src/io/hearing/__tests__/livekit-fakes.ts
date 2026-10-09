/**
 * Fakes of the @livekit/rtc-node surface that the LiveKit modules of the
 * hearing layer use: a room whose local participant records the text streams
 * it sends. No LiveKit server is involved.
 */

import { vi } from 'vitest';

/** An rtc-node room as a writer of text streams sees it: its local participant, whose `sendText` is a mock. */
export class FakeRoom {
  readonly localParticipant = {
    identity: 'agent',
    sendText: vi.fn(async (_text: string, _options?: unknown) => ({})),
  };
}
