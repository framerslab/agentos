import { describe, it, expect, vi } from 'vitest';
import { ChannelRouter } from '../ChannelRouter.js';
import type { ChannelMessage, ChannelPlatform } from '../types.js';

const PLATFORM = 'telegram' as ChannelPlatform;

function groupMessage(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    messageId: 'm1',
    platform: PLATFORM,
    conversationId: 'g-100',
    conversationType: 'group',
    sender: { id: 'u1' },
    content: [{ type: 'text', text: 'hello' }],
    text: 'hello',
    timestamp: new Date().toISOString(),
    supportsMentions: true,
    mentions: [],
    ...over,
  };
}

type Routable = { routeInboundMessage(message: ChannelMessage): Promise<void> };

function makeRouter() {
  const router = new ChannelRouter();
  router.addBinding({
    bindingId: 'b1',
    seedId: 'seed-1',
    ownerUserId: 'owner-1',
    platform: PLATFORM,
    channelId: 'g-100',
    conversationType: 'group',
    isActive: true,
    autoBroadcast: false,
    platformConfig: { botUserId: 'agent-bot' },
    groupPolicy: { activation: 'mention' },
  });
  const seen = vi.fn();
  router.onMessage(async (message) => {
    seen(message.messageId);
  });
  return { router: router as ChannelRouter & Routable, seen };
}

describe('ChannelRouter group policy enforcement', () => {
  it('drops unmentioned group messages under mention activation', async () => {
    const { router, seen } = makeRouter();
    await router.routeInboundMessage(groupMessage());
    expect(seen).not.toHaveBeenCalled();
  });

  it('delivers group messages that mention the bot user id', async () => {
    const { router, seen } = makeRouter();
    await router.routeInboundMessage(groupMessage({ mentions: ['agent-bot'] }));
    expect(seen).toHaveBeenCalledWith('m1');
  });

  it('delivers DMs regardless of policy', async () => {
    const { router, seen } = makeRouter();
    await router.routeInboundMessage(
      groupMessage({ conversationType: 'direct', mentions: undefined, supportsMentions: false })
    );
    expect(seen).toHaveBeenCalledWith('m1');
  });

  it('drops bot senders in groups even with no policy configured on the binding', async () => {
    const { router, seen } = makeRouter();
    router.addBinding({
      bindingId: 'b2',
      seedId: 'seed-1',
      ownerUserId: 'owner-1',
      platform: PLATFORM,
      channelId: 'g-200',
      conversationType: 'group',
      isActive: true,
      autoBroadcast: false,
    });
    await router.routeInboundMessage(
      groupMessage({ conversationId: 'g-200', sender: { id: 'u2', isBot: true } })
    );
    expect(seen).not.toHaveBeenCalled();
  });

  it('policy drop on one binding does not create or touch its session', async () => {
    const { router } = makeRouter();
    await router.routeInboundMessage(groupMessage());
    expect(router.getSessionsForSeed('seed-1')).toHaveLength(0);
  });
});
