/**
 * @fileoverview Unit tests for {@link PlivoSmsChannelAdapter}.
 *
 * Covers:
 * - X-Plivo-Signature-V3 computation against the Plivo SDK golden fixture.
 * - Outbound SMS send (request shape + returned message id).
 * - Inbound webhook: valid signature emits a message; invalid/missing drops it.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  PlivoSmsChannelAdapter,
  computePlivoV3Signature,
} from '../PlivoSmsChannelAdapter.js';
import type { ChannelEvent } from '../../types.js';

// ---------------------------------------------------------------------------
// Golden fixture — from plivo-python@989c589 signature_v3.py. A correct
// validator MUST reproduce SIG_EXPECTED for these inputs.
// ---------------------------------------------------------------------------

const FIXTURE = {
  method: 'POST',
  url: 'https://example.com/plivo/inbound',
  nonce: 'f4b1c2d3e5',
  authToken: 'FAKE_AUTH_TOKEN_1234567890',
  params: {
    From: '+14150000001',
    To: '+14150000002',
    Text: 'test',
    Type: 'sms',
    MessageUUID: '11111111-2222-3333-4444-555555555555',
  },
} as const;
const SIG_EXPECTED = 'BsYEsmZvb8pj7+RQtDfliZnZKIBlAmvq4t8a3d6MkXU=';

describe('computePlivoV3Signature', () => {
  it('reproduces the Plivo SDK golden fixture', () => {
    expect(computePlivoV3Signature({ ...FIXTURE, params: { ...FIXTURE.params } })).toBe(
      SIG_EXPECTED,
    );
  });

  it('is order-independent on params (keys are sorted before signing)', () => {
    const shuffled = {
      Type: 'sms',
      MessageUUID: '11111111-2222-3333-4444-555555555555',
      From: '+14150000001',
      Text: 'test',
      To: '+14150000002',
    };
    expect(computePlivoV3Signature({ ...FIXTURE, params: shuffled })).toBe(SIG_EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connect(
  adapter: PlivoSmsChannelAdapter,
  overrides: Record<string, string> = {},
): Promise<void> {
  await adapter.initialize({
    platform: 'sms',
    credential: FIXTURE.authToken,
    params: {
      authId: 'test-auth-id',
      phoneNumber: '+14150000002',
      webhookUrl: FIXTURE.url,
      ...overrides,
    },
  });
}

/** A fetch stub that returns the account GET, then the send response. */
function makeFetch(sendResponse: unknown, sendOk = true): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const isSend = init?.method === 'POST';
    const bodyObj = isSend ? sendResponse : { name: 'Test Account' };
    return {
      ok: isSend ? sendOk : true,
      status: isSend && !sendOk ? 400 : 200,
      json: async () => bodyObj,
      text: async () => JSON.stringify(bodyObj),
    } as Response;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('PlivoSmsChannelAdapter — outbound', () => {
  it('POSTs to the Message endpoint with {src,dst,text,type} and returns the message uuid', async () => {
    const fetchImpl = makeFetch({ message: 'message(s) queued', message_uuid: ['uuid-123'], api_id: 'api-1' });
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl });
    await connect(adapter);

    const result = await adapter.sendMessage('+14150000001', {
      blocks: [{ type: 'text', text: 'hello' }],
    });

    expect(result.messageId).toBe('uuid-123');

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(sendCall?.[0]).toBe('https://api.plivo.com/v1/Account/test-auth-id/Message/');
    expect(JSON.parse((sendCall?.[1] as RequestInit).body as string)).toEqual({
      src: '+14150000002',
      dst: '+14150000001',
      text: 'hello',
      type: 'sms',
    });
  });

  it('throws when no text content is provided', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter);
    await expect(
      adapter.sendMessage('+14150000001', { blocks: [{ type: 'image', url: 'x' }] }),
    ).rejects.toThrow(/text/i);
  });
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('PlivoSmsChannelAdapter — inbound', () => {
  const inboundBody = { ...FIXTURE.params };
  const validHeaders = {
    'x-plivo-signature-v3': SIG_EXPECTED,
    'x-plivo-signature-v3-nonce': FIXTURE.nonce,
  };

  it('emits a message event when the signature is valid', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter);

    const events: ChannelEvent[] = [];
    adapter.on((e) => void events.push(e), ['message']);

    adapter.handleIncomingWebhook(inboundBody, {
      method: 'POST',
      url: FIXTURE.url,
      headers: validHeaders,
    });

    expect(events).toHaveLength(1);
    expect(events[0].platform).toBe('sms');
    const msg = events[0].data as { conversationId: string; text: string };
    expect(msg.conversationId).toBe('+14150000001');
    expect(msg.text).toBe('test');
  });

  it('accepts array-valued signature headers (Node/Express duplicate-header shape)', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter);

    const events: ChannelEvent[] = [];
    adapter.on((e) => void events.push(e), ['message']);

    adapter.handleIncomingWebhook(inboundBody, {
      method: 'POST',
      url: FIXTURE.url,
      headers: {
        'x-plivo-signature-v3': [SIG_EXPECTED],
        'x-plivo-signature-v3-nonce': [FIXTURE.nonce],
      },
    });

    expect(events).toHaveLength(1);
  });

  it('drops the message when the signature is invalid', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter);

    const events: ChannelEvent[] = [];
    adapter.on((e) => void events.push(e), ['message']);

    adapter.handleIncomingWebhook(inboundBody, {
      method: 'POST',
      url: FIXTURE.url,
      headers: { ...validHeaders, 'x-plivo-signature-v3': 'WRONGSIGNATURE=' },
    });

    expect(events).toHaveLength(0);
  });

  it('drops the message when signature headers are absent (fail closed)', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter);

    const events: ChannelEvent[] = [];
    adapter.on((e) => void events.push(e), ['message']);

    adapter.handleIncomingWebhook(inboundBody, { method: 'POST', url: FIXTURE.url, headers: {} });

    expect(events).toHaveLength(0);
  });

  it('emits without verification when verifySignature is disabled', async () => {
    const adapter = new PlivoSmsChannelAdapter({ fetchImpl: makeFetch({}) });
    await connect(adapter, { verifySignature: 'false' });

    const events: ChannelEvent[] = [];
    adapter.on((e) => void events.push(e), ['message']);

    adapter.handleIncomingWebhook(inboundBody);

    expect(events).toHaveLength(1);
  });
});
