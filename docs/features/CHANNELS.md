# Channels — multi-platform deployment guide

The agents people actually use don't live in one window. A useful research assistant gets pinged on Slack during the workday, on Telegram on the weekend, and over email when someone forwards a thread for it to summarise. Each platform has its own ergonomics, its own rate limits, its own message-shape quirks, its own auth model, and writing that integration once per agent is the thing that stops most projects at "demo on Discord."

The channel layer puts every external platform behind one [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) interface: your agent code receives and sends [`ChannelMessage`](https://github.com/framerslab/agentos/blob/master/src/io/channels/types.ts) objects and `MessageContent` blocks, and the adapter handles the platform's SDK, auth and message shapes. Twelve adapters ship in-tree (`src/io/channels/adapters/`, exported from `@framers/agentos/channels`), and 37 curated channel packs (`@framers/agentos-ext-channel-*`) cover the messaging, social and publishing platforms.

```
User (Discord / Telegram / etc.)
  ↕  platform SDK
IChannelAdapter
  ↕  ChannelRouter
Your Agent (AgentOS)
```

A pack registers its adapter as a `messaging-channel` extension. The [`ChannelRouter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/ChannelRouter.ts) holds the adapters, matches each inbound message to the bindings for its conversation, applies a binding's group policy, keeps a session per conversation, and hands the message to your `onMessage` handlers; it also sends through an adapter and broadcasts to a seed's auto-broadcast bindings. It does no load balancing, health checking or fallback between adapters.

---

## The 37 Channel Packs

The registry's channel catalog lists the secret ids each pack requires; the third column gives the environment variable AgentOS's secret catalog maps each id to. A pack reads its credentials from its own options, from the `secrets` map that `createCuratedManifest({ secrets })` passes it, or from the environment; its README names the variables it reads, and some accept more than one (the Discord pack also reads `DISCORD_TOKEN`).

### Messaging & Chat

| Platform id | Package | Env vars for its declared secrets |
|-------------|---------|-----------------------------------|
| `telegram` | `@framers/agentos-ext-channel-telegram` | `TELEGRAM_BOT_TOKEN` |
| `whatsapp` | `@framers/agentos-ext-channel-whatsapp` | none declared (WhatsApp Web through Baileys: `WHATSAPP_SESSION_DATA`, or a linked-device folder) |
| `discord` | `@framers/agentos-ext-channel-discord` | `DISCORD_BOT_TOKEN` |
| `slack` | `@framers/agentos-ext-channel-slack` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` |
| `webchat` | `@framers/agentos-ext-channel-webchat` | none declared |
| `signal` | `@framers/agentos-ext-channel-signal` | `SIGNAL_PHONE_NUMBER` |
| `imessage` | `@framers/agentos-ext-channel-imessage` | `BLUEBUBBLES_SERVER_URL`, `BLUEBUBBLES_PASSWORD` |
| `google-chat` | `@framers/agentos-ext-channel-google-chat` | `GOOGLE_CHAT_SERVICE_ACCOUNT` |
| `teams` | `@framers/agentos-ext-channel-teams` | `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` |
| `matrix` | `@framers/agentos-ext-channel-matrix` | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN` |
| `zalo` | `@framers/agentos-ext-channel-zalo` | `ZALO_BOT_TOKEN` |
| `zalouser` | `@framers/agentos-ext-channel-zalouser` | none declared |
| `email` | `@framers/agentos-ext-channel-email` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` |
| `sms` | `@framers/agentos-ext-channel-sms` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| `line` | `@framers/agentos-ext-channel-line` | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` |
| `feishu` | `@framers/agentos-ext-channel-feishu` | `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY` |
| `mattermost` | `@framers/agentos-ext-channel-mattermost` | `MATTERMOST_URL`, `MATTERMOST_TOKEN` |
| `nextcloud-talk` | `@framers/agentos-ext-channel-nextcloud` | `NEXTCLOUD_URL`, `NEXTCLOUD_TOKEN` |
| `irc` | `@framers/agentos-ext-channel-irc` | `IRC_HOST`, `IRC_PORT`, `IRC_NICK`, `IRC_CHANNELS` |
| `nostr` | `@framers/agentos-ext-channel-nostr` | `NOSTR_PRIVATE_KEY`, `NOSTR_RELAY_URLS` |
| `tlon` | `@framers/agentos-ext-channel-tlon` | `TLON_SHIP_URL`, `TLON_CODE` |
| `twitch` | `@framers/agentos-ext-channel-twitch` | `TWITCH_OAUTH_TOKEN`, `TWITCH_USERNAME`, `TWITCH_CHANNEL` |

### Social Media

| Platform id | Package | Env vars for its declared secrets |
|-------------|---------|-----------------------------------|
| `twitter` | `@framers/agentos-ext-channel-twitter` | `TWITTER_BEARER_TOKEN` |
| `instagram` | `@framers/agentos-ext-channel-instagram` | `INSTAGRAM_ACCESS_TOKEN` |
| `reddit` | `@framers/agentos-ext-channel-reddit` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` |
| `youtube` | `@framers/agentos-ext-channel-youtube` | `YOUTUBE_API_KEY` |
| `linkedin` | `@framers/agentos-ext-channel-linkedin` | `LINKEDIN_ACCESS_TOKEN` |
| `facebook` | `@framers/agentos-ext-channel-facebook` | `FACEBOOK_ACCESS_TOKEN` |
| `threads` | `@framers/agentos-ext-channel-threads` | `THREADS_ACCESS_TOKEN` |
| `bluesky` | `@framers/agentos-ext-channel-bluesky` | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` |
| `mastodon` | `@framers/agentos-ext-channel-mastodon` | `MASTODON_ACCESS_TOKEN` |
| `pinterest` | `@framers/agentos-ext-channel-pinterest` | `PINTEREST_ACCESS_TOKEN` |
| `tiktok` | `@framers/agentos-ext-channel-tiktok` | `TIKTOK_ACCESS_TOKEN` |
| `farcaster` | `@framers/agentos-ext-channel-farcaster` | `FARCASTER_SIGNER_UUID`, `FARCASTER_NEYNAR_API_KEY` |
| `lemmy` | `@framers/agentos-ext-channel-lemmy` | `LEMMY_INSTANCE_URL`, `LEMMY_USERNAME`, `LEMMY_PASSWORD` |

### Publishing

| Platform id | Package | Env vars for its declared secrets |
|-------------|---------|-----------------------------------|
| `devto` | `@framers/agentos-ext-channel-blog-publisher` (Dev.to, Hashnode, Medium, WordPress) | none declared |
| `google-business` | `@framers/agentos-ext-channel-google-business` | `GOOGLE_ACCESS_TOKEN` |

`createCuratedManifest()` from `@framers/agentos-extensions-registry` builds an `extensionManifest` entry for each installed pack, so a host that installs the packs and sets the variables loads them through `AgentOS.create({ extensionManifest })`.

---

## Setup Guides

A message reaches your `onMessage` handlers only when a binding names its conversation: `router.addBinding({ platform, channelId, ... })` with the conversation's id as `channelId`. A message from a conversation with no binding is dropped.

### Discord

**1. Create a Discord Application**

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Create a new application
3. Under "Bot", create a bot and copy the token
4. Under "OAuth2 → URL Generator", select scopes: `bot`, `applications.commands`
5. Select permissions: `Send Messages`, `Read Message History`, `Use Slash Commands`
6. Invite the bot to your server using the generated URL

**2. Set environment variables**

```bash
export DISCORD_BOT_TOKEN=your-bot-token
export DISCORD_APPLICATION_ID=your-application-id   # optional
```

**3. Register the adapter**

Each channel pack ships its own `<Channel>Service` (transport client) and
`<Channel>ChannelAdapter` (the [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) implementation). The
adapter takes the service in its constructor:

```typescript
import { agent } from '@framers/agentos';
import { ChannelRouter } from '@framers/agentos/channels';
import { DiscordService, DiscordChannelAdapter } from '@framers/agentos-ext-channel-discord';

const assistant = agent({ provider: 'openai', instructions: 'You are a helpful assistant.' });
const router = new ChannelRouter();

const service = new DiscordService({
  botToken: process.env.DISCORD_BOT_TOKEN!,
  applicationId: process.env.DISCORD_APPLICATION_ID,
});
await service.initialize();

const discord = new DiscordChannelAdapter(service);
await discord.initialize({ platform: 'discord', credential: process.env.DISCORD_BOT_TOKEN! });

router.registerAdapter(discord);

// Bind the Discord channel the agent answers in.
router.addBinding({
  bindingId: 'support-discord',
  seedId: 'support-agent',
  ownerUserId: 'owner-1',
  platform: 'discord',
  channelId: '123456789012345678',
  conversationType: 'channel',
  isActive: true,
  autoBroadcast: false,
});

// The handler receives the message, the binding it matched and the session.
router.onMessage(async (message, binding, session) => {
  const reply = await assistant.generate(message.text);
  await router.sendMessage(binding.seedId, message.platform, message.conversationId, {
    blocks: [{ type: 'text', text: reply.text }],
  });
});
```

> **Registry pattern.** For multi-channel apps,
> [`createCuratedManifest`](https://github.com/framerslab/agentos-extensions-registry)
> from `@framers/agentos-extensions-registry` builds the manifest entries for the
> installed channel packs; each pack's factory builds its `Service` and
> `ChannelAdapter` from its options and secrets and starts them when the pack activates.

---

### Slack

**1. Create a Slack App**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From Scratch
2. Enable "Event Subscriptions" with Request URL pointing to your webhook endpoint
3. Subscribe to `message.channels`, `message.im`, `app_mention` events
4. Under "OAuth & Permissions", add scopes: `chat:write`, `channels:history`, `im:history`
5. Install the app to your workspace, copy the Bot User OAuth Token

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=your-signing-secret
export SLACK_APP_TOKEN=xapp-...   # optional: Socket Mode
```

**2. Register the adapter**

```typescript
import { SlackService, SlackChannelAdapter } from '@framers/agentos-ext-channel-slack';

const service = new SlackService({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appToken: process.env.SLACK_APP_TOKEN,
});
await service.initialize();

const slack = new SlackChannelAdapter(service);
await slack.initialize({ platform: 'slack', credential: process.env.SLACK_BOT_TOKEN! });

router.registerAdapter(slack);
```

---

### Telegram

**1. Create a bot**

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABC-...
```

**2. Register the adapter**

```typescript
import { TelegramService, TelegramChannelAdapter } from '@framers/agentos-ext-channel-telegram';

const service = new TelegramService({ botToken: process.env.TELEGRAM_BOT_TOKEN! });
await service.initialize();

const telegram = new TelegramChannelAdapter(service);
await telegram.initialize({ platform: 'telegram', credential: process.env.TELEGRAM_BOT_TOKEN! });

router.registerAdapter(telegram);
```

---

### Twitter / X

**1. Create a Twitter Developer Project**

1. Go to [developer.twitter.com](https://developer.twitter.com) → Create Project → Create App
2. In the App settings, enable "Read and Write" permissions
3. Generate Access Token and Secret under "Keys and Tokens"

```bash
export TWITTER_BEARER_TOKEN=your-bearer-token
# To post as a user, the OAuth 1.0a keys as well:
export TWITTER_API_KEY=your-api-key
export TWITTER_API_SECRET=your-api-secret
export TWITTER_ACCESS_TOKEN=your-access-token
export TWITTER_ACCESS_SECRET=your-access-secret
```

**2. Register the adapter**

```typescript
import { TwitterService, TwitterChannelAdapter } from '@framers/agentos-ext-channel-twitter';

const service = new TwitterService({
  bearerToken:  process.env.TWITTER_BEARER_TOKEN,
  apiKey:       process.env.TWITTER_API_KEY,
  apiSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});
await service.initialize();

const twitter = new TwitterChannelAdapter(service);
await twitter.initialize({
  platform: 'twitter',
  credential: process.env.TWITTER_BEARER_TOKEN ?? process.env.TWITTER_API_KEY ?? '',
});

router.registerAdapter(twitter);
```

---

### WhatsApp

Two adapters serve WhatsApp:

- The **in-tree** `WhatsAppChannelAdapter` from `@framers/agentos/channels` talks to the WhatsApp Business Cloud API (or Twilio's WhatsApp API with `provider: 'twilio'`, its default).
- The **pack** `@framers/agentos-ext-channel-whatsapp` links to a phone as a WhatsApp Web device through Baileys (`@whiskeysockets/baileys`, a peer dependency); its session comes from `WHATSAPP_SESSION_DATA` or a linked-device folder (default `~/.wunderland/whatsapp-auth`).

**Cloud API with the in-tree adapter**

1. Create a Meta Business account at [business.facebook.com](https://business.facebook.com)
2. Add a WhatsApp Business App in Meta for Developers
3. Configure a phone number and copy the Access Token and Phone Number ID

```bash
export WHATSAPP_ACCESS_TOKEN=your-access-token
export WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
```

```typescript
import { WhatsAppChannelAdapter } from '@framers/agentos/channels';

const whatsapp = new WhatsAppChannelAdapter();
await whatsapp.initialize({
  platform: 'whatsapp',
  credential: process.env.WHATSAPP_ACCESS_TOKEN!,
  params: {
    provider: 'cloud-api',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  },
});

router.registerAdapter(whatsapp);
```

Inbound messages arrive at your webhook route; pass each request body to `whatsapp.handleIncomingWebhook()`.

---

### Plivo (SMS)

Plivo is available as its own messaging channel for SMS. Get your Auth ID and Auth Token from the Plivo console at [cx.plivo.com](https://cx.plivo.com/?utm_source=github&utm_medium=oss&utm_campaign=agentos), and use one of your Plivo numbers as the sender.

```bash
export PLIVO_AUTH_ID=your-auth-id
export PLIVO_AUTH_TOKEN=your-auth-token
export PLIVO_PHONE_NUMBER=+14150000000   # your Plivo sender number, E.164 format
```

```typescript
import { PlivoSmsChannelAdapter } from '@framers/agentos'; // src/io/channels/adapters

const sms = new PlivoSmsChannelAdapter();
await sms.initialize({
  platform: 'plivo',
  credential: process.env.PLIVO_AUTH_TOKEN!, // Auth Token
  params: {
    authId: process.env.PLIVO_AUTH_ID!,
    phoneNumber: process.env.PLIVO_PHONE_NUMBER!,
    // The externally-visible URL you set as the number's Message URL in Plivo.
    webhookUrl: 'https://your-host.example/plivo/inbound',
  },
});

router.registerAdapter(sms);
```

**Inbound messages.** Point your Plivo number's Message URL at a route on your host and forward the request to the adapter. Plivo signs its callbacks, so pass the method, the exact URL Plivo requested, and the headers. The adapter drops a request with no valid signature and accepts each callback once:

```typescript
app.post('/plivo/inbound', (req, res) => {
  sms.handleIncomingWebhook(req.body, {
    method: 'POST',
    url: 'https://your-host.example/plivo/inbound',
    headers: req.headers,
  });
  res.sendStatus(200);
});
```

**What the signature proves.** Plivo has two signature families, and the adapter accepts both:

- **V3** (`X-Plivo-Signature-V3`, `X-Plivo-Signature-Ma-V3`) signs the URL, its query, the params and a nonce. `From`, `Text` and `MessageUUID` of a V3-verified message are the ones Plivo sent. When a request carries a V3 header, V3 alone decides.
- **V2** (`X-Plivo-Signature-V2`, `X-Plivo-Signature-Ma-V2`) signs the URL and a nonce, not the body. It does **not** authenticate `From`, `Text` or `MessageUUID`: whoever holds one callback's signature and nonce can send them again with a different sender and text. Plivo's [messaging documentation](https://www.plivo.com/docs/messaging/concepts/signature-validation) describes V2 for message callbacks.

The adapter remembers the nonce of every callback it accepts and drops a request that reuses one. That memory lives in the process, so a restart empties it, and it is bounded: 24 hours and 10,000 nonces by default, set with the `nonceTtlMs` and `maxNonces` constructor options. Plivo's signatures carry no timestamp, so a callback sent again after its nonce is forgotten, or one this process never accepted, is accepted. Treat the sender number as a claim: do not let an inbound SMS authorize an action by its `From` alone.

A GET callback carries its params in the query string. Pass `method: 'GET'` and the full URL Plivo requested, query string included; the adapter reads the message from that query.

---

## Custom Channel Adapter

Implement [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) to add a platform outside the built-in set, or extend `BaseChannelAdapter`, which supplies the event plumbing and retries and leaves `doConnect`, `doSendMessage` and `doShutdown` to you. The router subscribes with `on()` and routes each `message` event's `data`, a `ChannelMessage`:

```typescript
import type {
  IChannelAdapter,
  ChannelAuthConfig,
  ChannelCapability,
  ChannelConnectionInfo,
  ChannelEvent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelMessage,
  ChannelSendResult,
  MessageContent,
} from '@framers/agentos/channels';

// MyPlatformClient stands for the platform's own SDK client.
class MyPlatformAdapter implements IChannelAdapter {
  readonly platform = 'my-platform';
  readonly displayName = 'My Platform';
  readonly capabilities: readonly ChannelCapability[] = ['text', 'images'];

  private client: MyPlatformClient | null = null;
  private subscribers = new Set<{ handler: ChannelEventHandler; types?: ChannelEventType[] }>();

  async initialize(auth: ChannelAuthConfig): Promise<void> {
    this.client = new MyPlatformClient(auth.credential);
    await this.client.connect();

    this.client.on('message', (raw) => {
      const message: ChannelMessage = {
        messageId: raw.messageId,
        platform: this.platform,
        conversationId: raw.channelId,
        conversationType: 'channel',
        sender: { id: raw.userId },
        content: [{ type: 'text', text: raw.body }],
        text: raw.body,
        timestamp: new Date(raw.ts).toISOString(),
      };
      this.emit({
        type: 'message',
        platform: this.platform,
        conversationId: message.conversationId,
        timestamp: message.timestamp,
        data: message,
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
  }

  getConnectionInfo(): ChannelConnectionInfo {
    return { status: this.client ? 'connected' : 'disconnected' };
  }

  async sendMessage(conversationId: string, content: MessageContent): Promise<ChannelSendResult> {
    const text = content.blocks.find((b) => b.type === 'text')?.text ?? '';
    const sent = await this.client!.send({ channelId: conversationId, body: text });
    return { messageId: sent.id };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // The platform has no typing indicator.
  }

  on(handler: ChannelEventHandler, eventTypes?: ChannelEventType[]): () => void {
    const entry = { handler, types: eventTypes };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  private emit(event: ChannelEvent): void {
    for (const { handler, types } of this.subscribers) {
      if (!types || types.includes(event.type)) void handler(event);
    }
  }
}
```

Register and use:

```typescript
const myAdapter = new MyPlatformAdapter();
await myAdapter.initialize({ platform: 'my-platform', credential: 'my-api-key' });
router.registerAdapter(myAdapter);
```

---

## Message Routing

`ChannelRouter` holds the registered adapters (one per platform; `registerAdapter(adapter, { platformKey })` registers a second one under another key) and routes inbound messages to your handlers through bindings:

```typescript
import { ChannelRouter } from '@framers/agentos/channels';

const router = new ChannelRouter();

router.registerAdapter(discordAdapter);
router.registerAdapter(slackAdapter);
router.registerAdapter(telegramAdapter);

// One binding per conversation the agent (its seedId) serves.
router.addBinding({
  bindingId: 'support-slack',
  seedId: 'support-agent',
  ownerUserId: 'owner-1',
  platform: 'slack',
  channelId: 'C01234ABCDE',
  conversationType: 'channel',
  isActive: true,
  autoBroadcast: true,
  groupPolicy: { activation: 'mention' }, // answer group messages only when mentioned
});

// Messages from bound conversations, across all platforms
router.onMessage(async (message, binding) => {
  console.log(`[${message.platform}] ${message.sender.id}: ${message.text}`);
  const reply = await assistant.generate(message.text);
  await router.sendMessage(binding.seedId, message.platform, message.conversationId, {
    blocks: [{ type: 'text', text: reply.text }],
  });
});

// Adapters and their connection state
console.log(router.listAdapters());
console.log(router.getStats()); // { adapters, bindings, activeSessions, totalSessions }
```

---

## Broadcast to Multiple Channels

`router.broadcast(seedId, content)` sends the same content to every active binding of that seed with `autoBroadcast: true`, one send per binding; a failed send is logged and the others go on. It returns the send results of the ones that went out.

```typescript
const results = await router.broadcast('support-agent', {
  blocks: [{ type: 'text', text: 'AgentOS 2.0 is live.' }],
});
```

For social media broadcast (Twitter, Bluesky, LinkedIn, etc.), see
[SOCIAL_POSTING.md](./SOCIAL_POSTING.md) which provides the [`MultiChannelPostTool`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/tools/multi-channel-post/src/MultiChannelPostTool.ts)
with content adaptation per platform.

---

## Related Guides

- [SOCIAL_POSTING.md](./SOCIAL_POSTING.md) — publishing to social media platforms
- [VOICE_PIPELINE.md](./VOICE_PIPELINE.md) — voice call channels (telephony)
- [AGENCY_API.md](../orchestration/AGENCY_API.md) — `agency().connect()` for channel-aware agencies
- [RFC_EXTENSION_STANDARDS.md](../extensions/RFC_EXTENSION_STANDARDS.md) — extension packaging for channel adapters
