# Channels — multi-platform deployment guide

The agents people actually use don't live in one window. A useful research assistant gets pinged on Slack during the workday, on Telegram on the weekend, and over email when someone forwards a thread for it to summarise. Each platform has its own ergonomics, its own rate limits, its own message-shape quirks, its own auth model. The work of integrating each one is real, and writing it once per agent is the thing that stops most projects at "demo on Discord."

The channel layer is the boundary that makes this someone else's problem. Every external platform sits behind a single [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/channels/IChannelAdapter.ts) interface; your agent code emits and receives [`ChannelMessage`](https://github.com/framerslab/agentos/blob/master/src/io/channels/types.ts) objects, and the adapter handles serialization, auth, reconnection, and platform-specific edge cases. Twelve adapters ship in-tree (`src/channels/adapters/`); 37 curated extension packs cover the rest of the messaging, social, and publishing surface. Same shape on either side of the boundary — same [`ChannelMessage`](https://github.com/framerslab/agentos/blob/master/src/io/channels/types.ts) envelope, same [`ChannelRouter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/ChannelRouter.ts) for routing inbound traffic to the right agent, same code path for sending replies back out.

```
User (Discord / Telegram / etc.)
  ↕  platform SDK
IChannelAdapter
  ↕  ChannelRouter
Your Agent (AgentOS)
```

Channels are registered as `messaging-channel` extensions and managed by the
[`ChannelRouter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/ChannelRouter.ts), which handles load balancing, health checks, and fallback.

```
User (Discord / Telegram / etc.)
  ↕  platform SDK
IChannelAdapter
  ↕  ChannelRouter
Your Agent (AgentOS)
```

Channels are registered as `messaging-channel` extensions and managed by the
[`ChannelRouter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/ChannelRouter.ts), which handles load balancing, health checks, and fallback.

---

## All 37 Channels

### Messaging & Chat

| Platform | Type | Required Env Vars |
|----------|------|-------------------|
| `discord` | Chat | `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` |
| `slack` | Chat | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| `telegram` | Chat | `TELEGRAM_BOT_TOKEN` |
| `whatsapp` | Chat | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| `google-chat` | Chat | `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` |
| `teams` | Chat | `TEAMS_BOT_ID`, `TEAMS_BOT_PASSWORD` |
| `signal` | Chat | `SIGNAL_CLI_PATH` or `SIGNAL_API_URL` |
| `imessage` | Chat | macOS only — no env vars |
| `matrix` | Chat | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN` |
| `webchat` | Chat | `WEBCHAT_SECRET` (for webhook validation) |
| `sms` | Messaging | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE` |
| `plivo` | Messaging | `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE` |
| `email` | Messaging | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` |
| `line` | Chat | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` |
| `zalo` | Chat | `ZALO_APP_ID`, `ZALO_APP_SECRET` |
| `feishu` | Chat | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` |
| `mattermost` | Chat | `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN` |
| `nextcloud-talk` | Chat | `NEXTCLOUD_URL`, `NEXTCLOUD_TOKEN` |
| `irc` | Chat | `IRC_SERVER`, `IRC_NICK`, `IRC_CHANNELS` |
| `nostr` | Decentralized | `NOSTR_PRIVATE_KEY` |
| `tlon` | Decentralized | `TLON_SHIP`, `TLON_CODE` |
| `twitch` | Streaming | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL` |

### Social Media — Broadcast

| Platform | Type | Required Env Vars |
|----------|------|-------------------|
| `twitter` | Social | `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET` |
| `instagram` | Social | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` |
| `linkedin` | Social | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_ID` |
| `facebook` | Social | `FACEBOOK_PAGE_ACCESS_TOKEN`, `FACEBOOK_PAGE_ID` |
| `threads` | Social | `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` |
| `bluesky` | Social | `BLUESKY_IDENTIFIER`, `BLUESKY_PASSWORD` |
| `mastodon` | Social | `MASTODON_INSTANCE_URL`, `MASTODON_ACCESS_TOKEN` |
| `reddit` | Social | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` |
| `pinterest` | Social | `PINTEREST_ACCESS_TOKEN` |
| `tiktok` | Social | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| `youtube` | Social | `YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID` |
| `farcaster` | Social | `FARCASTER_MNEMONIC` |
| `lemmy` | Social | `LEMMY_INSTANCE_URL`, `LEMMY_USERNAME`, `LEMMY_PASSWORD` |

### Publishing

| Platform | Type | Required Env Vars |
|----------|------|-------------------|
| `devto` | Blog | `DEVTO_API_KEY` |
| `hashnode` | Blog | `HASHNODE_TOKEN`, `HASHNODE_PUBLICATION_ID` |
| `medium` | Blog | `MEDIUM_INTEGRATION_TOKEN` |
| `wordpress` | Blog | `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_PASSWORD` |
| `google-business` | Business | `GOOGLE_BUSINESS_ACCOUNT_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` |

---

## Setup Guides

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
export DISCORD_APPLICATION_ID=your-application-id
export DISCORD_GUILD_ID=your-server-id   # optional: restrict to one guild
```

**3. Register the adapter**

Each channel ships its own `<Channel>Service` (transport client) and
`<Channel>ChannelAdapter` (the [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) implementation). The
adapter takes the service in its constructor:

```typescript
import { ChannelRouter } from '@framers/agentos/channels';
import { DiscordService, DiscordChannelAdapter } from '@framers/agentos-ext-channel-discord';

const router = new ChannelRouter();

const service = new DiscordService({
  botToken: process.env.DISCORD_BOT_TOKEN!,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  // guildId: process.env.DISCORD_GUILD_ID, // optional
});
await service.initialize();

const discord = new DiscordChannelAdapter(service);
await discord.initialize({ credential: process.env.DISCORD_BOT_TOKEN! });

router.registerAdapter(discord);

// Listen for incoming messages via ChannelRouter's onMessage handler.
// Handler receives the parsed message + the resolved binding + session.
router.onMessage(async (message, binding, session) => {
  const response = await agent.reply(message.text);
  await discord.sendMessage(message.conversationId, {
    blocks: [{ type: 'text', text: response }],
  });
});
```

> **Recommended: registry pattern.** For multi-channel apps, use
> [`createCuratedManifest`](https://github.com/framerslab/agentos-extensions-registry)
> from `@framers/agentos-extensions-registry` — it instantiates each
> channel's `Service` + `ChannelAdapter` from your env vars and registers
> them with the router automatically.

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
```

**2. Register the adapter**

```typescript
import { SlackService, SlackChannelAdapter } from '@framers/agentos-ext-channel-slack';

const service = new SlackService({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});
await service.initialize();

const slack = new SlackChannelAdapter(service);
await slack.initialize({ credential: process.env.SLACK_BOT_TOKEN! });

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
await telegram.initialize({ credential: process.env.TELEGRAM_BOT_TOKEN! });

router.registerAdapter(telegram);
```

---

### Twitter / X

**1. Create a Twitter Developer Project**

1. Go to [developer.twitter.com](https://developer.twitter.com) → Create Project → Create App
2. In the App settings, enable "Read and Write" permissions
3. Generate Access Token and Secret under "Keys and Tokens"

```bash
export TWITTER_API_KEY=your-api-key
export TWITTER_API_SECRET=your-api-secret
export TWITTER_ACCESS_TOKEN=your-access-token
export TWITTER_ACCESS_SECRET=your-access-secret
```

**2. Register the adapter**

```typescript
import { TwitterService, TwitterChannelAdapter } from '@framers/agentos-ext-channel-twitter';

const service = new TwitterService({
  apiKey:        process.env.TWITTER_API_KEY!,
  apiSecret:     process.env.TWITTER_API_SECRET!,
  accessToken:   process.env.TWITTER_ACCESS_TOKEN!,
  accessSecret:  process.env.TWITTER_ACCESS_SECRET!,
});
await service.initialize();

const twitter = new TwitterChannelAdapter(service);
await twitter.initialize({
  credential: JSON.stringify({
    apiKey:        process.env.TWITTER_API_KEY,
    apiSecret:     process.env.TWITTER_API_SECRET,
    accessToken:   process.env.TWITTER_ACCESS_TOKEN,
    accessSecret:  process.env.TWITTER_ACCESS_SECRET,
  }),
});

router.registerAdapter(twitter);
```

---

### WhatsApp

**1. Set up WhatsApp Business API**

1. Create a Meta Business account at [business.facebook.com](https://business.facebook.com)
2. Add a WhatsApp Business App in Meta for Developers
3. Configure a phone number and copy the Access Token and Phone Number ID

```bash
export WHATSAPP_ACCESS_TOKEN=your-access-token
export WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
```

**2. Register the adapter**

```typescript
import { WhatsAppService, WhatsAppChannelAdapter } from '@framers/agentos-ext-channel-whatsapp';

const service = new WhatsAppService({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
});
await service.initialize();

const whatsapp = new WhatsAppChannelAdapter(service);
await whatsapp.initialize({ credential: process.env.WHATSAPP_ACCESS_TOKEN! });

router.registerAdapter(whatsapp);
```

---

### Plivo (SMS)

Plivo is available as its own messaging channel for SMS. Get your Auth ID and Auth Token from the Plivo console at [cx.plivo.com](https://cx.plivo.com), and use one of your Plivo numbers as the sender.

```bash
export PLIVO_AUTH_ID=your-auth-id
export PLIVO_AUTH_TOKEN=your-auth-token
export PLIVO_PHONE=+14150000000
```

```typescript
import { PlivoSmsChannelAdapter } from '@framers/agentos'; // src/io/channels/adapters

const sms = new PlivoSmsChannelAdapter();
await sms.initialize({
  platform: 'plivo',
  credential: process.env.PLIVO_AUTH_TOKEN!, // Auth Token
  params: {
    authId: process.env.PLIVO_AUTH_ID!,
    phoneNumber: process.env.PLIVO_PHONE!,
    // The externally-visible URL you set as the number's Message URL in Plivo.
    webhookUrl: 'https://your-host.example/plivo/inbound',
  },
});

router.registerAdapter(sms);
```

**Inbound messages.** Point your Plivo number's Message URL at a route on your host and forward the request to the adapter. Plivo signs inbound webhooks, so pass the method, the exact URL Plivo posted to, and the headers — the adapter verifies `X-Plivo-Signature-V3` and drops anything unsigned or tampered:

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

---

## Custom Channel Adapter

Implement [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) to add any platform not in the built-in set:

```typescript
import type {
  IChannelAdapter,
  ChannelAuthConfig,
  ChannelSendResult,
  MessageContent,
  ChannelEventHandler,
  ChannelEventType,
  ChannelConnectionInfo,
} from '@framers/agentos/channels';

class MyPlatformAdapter implements IChannelAdapter {
  readonly platform    = 'my-platform';
  readonly displayName = 'My Platform';
  readonly capabilities = ['text', 'images'] as const;

  private client: MyPlatformClient | null = null;
  private handlers = new Map<ChannelEventType, ChannelEventHandler[]>();

  async initialize(auth: ChannelAuthConfig): Promise<void> {
    this.client = new MyPlatformClient(auth.credential);
    await this.client.connect();

    this.client.on('message', (raw) => {
      const normalizedMessage = {
        id:             raw.messageId,
        conversationId: raw.channelId,
        text:           raw.body,
        senderId:       raw.userId,
        timestamp:      raw.ts,
        platform:       'my-platform',
      };
      this.emit('message', normalizedMessage);
    });
  }

  async shutdown(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
  }

  async sendMessage(
    conversationId: string,
    content: MessageContent,
  ): Promise<ChannelSendResult> {
    const text = content.blocks.find((b) => b.type === 'text')?.text ?? '';
    const sent = await this.client!.send({ channelId: conversationId, body: text });
    return { messageId: sent.id };
  }

  on(event: ChannelEventType, handler: ChannelEventHandler): void {
    const existing = this.handlers.get(event) ?? [];
    this.handlers.set(event, [...existing, handler]);
  }

  off(event: ChannelEventType, handler: ChannelEventHandler): void {
    const existing = this.handlers.get(event) ?? [];
    this.handlers.set(event, existing.filter((h) => h !== handler));
  }

  async getConnectionInfo(): Promise<ChannelConnectionInfo> {
    return { status: this.client ? 'connected' : 'disconnected' };
  }

  private emit(event: ChannelEventType, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload as any);
    }
  }
}
```

Register and use:

```typescript
const myAdapter = new MyPlatformAdapter();
await myAdapter.initialize({ credential: 'my-api-key' });
router.registerAdapter(myAdapter);
```

---

## Message Routing

`ChannelRouter` manages all registered adapters and routes messages by platform:

```typescript
import { ChannelRouter } from '@framers/agentos/channels';

const router = new ChannelRouter();

// Register all desired adapters
router.registerAdapter(discordAdapter);
router.registerAdapter(slackAdapter);
router.registerAdapter(telegramAdapter);

// Route a message to a specific platform
await router.send('discord', channelId, {
  blocks: [{ type: 'text', text: 'Hello from AgentOS!' }],
});

// Listen for messages across all platforms
router.onMessage(async (message, platform) => {
  console.log(`[${platform}] ${message.senderId}: ${message.text}`);
  const reply = await myAgent.reply(message.text);
  await router.send(platform, message.conversationId, {
    blocks: [{ type: 'text', text: reply }],
  });
});

// Health check all adapters
const health = await router.healthCheck();
console.log(health);
// { discord: 'connected', slack: 'connected', telegram: 'error' }
```

---

## Broadcast to Multiple Channels

Send the same message to multiple platforms simultaneously:

```typescript
import { ChannelRouter } from '@framers/agentos/channels';

const router = new ChannelRouter();
// ... register adapters ...

// Broadcast to a fixed list of channels
await router.broadcast(
  ['discord', 'slack', 'telegram'],
  {
    blocks: [
      { type: 'text', text: '🚀 AgentOS v2.0 is now live!' },
    ],
  },
  {
    // Map platform to its target conversation/channel ID
    conversationIds: {
      discord:  '1234567890',
      slack:    'C01234ABCDE',
      telegram: '-100123456789',
    },
  }
);
```

For social media broadcast (Twitter, Bluesky, LinkedIn, etc.), see
[SOCIAL_POSTING.md](./SOCIAL_POSTING.md) which provides the [`MultiChannelPostTool`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/tools/multi-channel-post/src/MultiChannelPostTool.ts)
with content adaptation per platform.

---

## Related Guides

- [SOCIAL_POSTING.md](./SOCIAL_POSTING.md) — publishing to social media platforms
- [VOICE_PIPELINE.md](./VOICE_PIPELINE.md) — voice call channels (telephony)
- [AGENCY_API.md](./AGENCY_API.md) — `agency().connect()` for channel-aware agencies
- [RFC_EXTENSION_STANDARDS.md](./RFC_EXTENSION_STANDARDS.md) — extension packaging for channel adapters
