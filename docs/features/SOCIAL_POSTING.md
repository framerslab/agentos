# Social Posting — Multi-Platform Publishing

> Schedule, adapt, and publish content across 18+ social platforms from a single API.

---

## Table of Contents

1. [Overview](#overview)
2. [SocialPostManager](#socialpostmanager)
3. [Post Lifecycle](#post-lifecycle)
4. [ContentAdaptationEngine](#contentadaptationengine)
5. [Platform-Specific Examples](#platform-specific-examples)
6. [Scheduling API](#scheduling-api)
7. [Media Attachments](#media-attachments)
8. [MultiChannelPostTool](#multichannelposttool)
9. [Cross-Platform Analytics](#cross-platform-analytics)

---

## Overview

AgentOS provides full Postiz-parity social media automation:

- **SocialPostManager** — state machine for post lifecycle (draft → published)
- **ContentAdaptationEngine** — rule-based content transformation per platform
- **MultiChannelPostTool** — post to N platforms in one agent tool call
- **BulkSchedulerTool** — batch schedule hundreds of posts
- **CrossPlatformAnalyticsTool** — aggregate metrics across platforms

**Supported platforms for social posting:**

Twitter, Instagram, LinkedIn, Facebook, Threads, Bluesky, Mastodon,
TikTok, YouTube, Pinterest, Reddit, Farcaster, Lemmy, Dev.to, Hashnode,
Medium, WordPress, Google Business (18 platforms)

---

## SocialPostManager

[`SocialPostManager`](https://github.com/framerslab/agentos/blob/master/src/io/channels/social-posting/SocialPostManager.ts) is the low-level post lifecycle engine. It maintains
an in-memory state machine for each post.

```typescript
import { SocialPostManager } from '@framers/agentos/social-posting';

const manager = new SocialPostManager();

// Create a draft
const post = manager.createDraft({
  seedId:    'agent-alpha',
  content:   'Excited to announce our new AI feature! 🚀 Check it out: https://example.com',
  platforms: ['twitter', 'linkedin', 'bluesky'],
  mediaUrls: ['https://cdn.example.com/screenshot.png'],
});

console.log(post.id);     // UUID
console.log(post.status); // 'draft'

// Schedule it
manager.schedulePost(post.id, '2026-04-01T09:00:00Z');
console.log(post.status); // 'scheduled'

// Publish immediately (skip scheduling)
await manager.publishNow(post.id, async (platform, content) => {
  // Your platform-specific publish logic here
  return { postId: 'abc123', url: `https://${platform}.com/post/abc123` };
});

console.log(post.status); // 'published'
```

### Creating a Draft

```typescript
const post = manager.createDraft({
  seedId:     'my-agent',
  content:    'Base content — platform-agnostic text.',
  platforms:  ['twitter', 'instagram', 'linkedin'],
  mediaUrls:  ['https://cdn.example.com/image.png'],
  maxRetries: 3,   // default: 3
});
```

### Listing Posts

```typescript
const allDrafts = manager.listByStatus('draft');
const scheduled = manager.listByStatus('scheduled');
const published = manager.listByAgent('agent-alpha');
```

---

## Post Lifecycle

```
createDraft()
     ↓
   DRAFT ──────────────────────────────────────────────┐
     ↓ schedulePost()                                   │ publishNow()
SCHEDULED                                               │
     ↓ (scheduler fires)                                │
PUBLISHING ◄────────────────────────────────────────────┘
     ↓                ↓
PUBLISHED           ERROR
                      ↓ retry
                    RETRY
                      ↓
                  PUBLISHING
```

**State transition methods:**

| Method | Transitions |
|--------|-------------|
| `createDraft()` | Creates in `draft` |
| `schedulePost(id, isoDate)` | `draft` → `scheduled` |
| `publishNow(id, publishFn)` | `draft\|scheduled` → `publishing` → `published\|error` |
| `markError(id, platform, msg)` | `publishing` → `error` |
| `scheduleRetry(id)` | `error` → `retry` → `publishing` |
| `cancel(id)` | `draft\|scheduled` → `cancelled` |

---

## ContentAdaptationEngine

The adaptation engine applies deterministic, platform-specific rules to a
base content string — enforcing character limits, hashtag placement, and
generating warnings.

```typescript
import { ContentAdaptationEngine } from '@framers/agentos/social-posting';

const engine = new ContentAdaptationEngine();

const adapted = engine.adaptContent(
  'Announcing our new AI feature! It automatically summarizes long documents into bullet points. Try it now at https://example.com #AI #productivity',
  ['twitter', 'linkedin', 'instagram', 'bluesky'],
  ['announcement', 'AI', 'productivity'],
);

console.log(adapted.twitter.text);
// "Announcing our new AI feature! It automatically summarizes long docs
//  into bullet points. Try it now at https://example.com"  (280 chars)

console.log(adapted.linkedin.text);
// Full text preserved — LinkedIn allows 3000 chars

console.log(adapted.instagram.hashtags);
// ['#announcement', '#AI', '#productivity']

console.log(adapted.twitter.truncated);  // true if content was cut
console.log(adapted.twitter.warnings);   // ['Content truncated from 145 to 280 characters']
```

### Platform Constraints Reference

| Platform | Max Length | Hashtag Style | Media | Threading |
|----------|-----------|---------------|-------|-----------|
| Twitter | 280 | inline | yes | yes |
| Instagram | 2,200 | footer | yes | no |
| LinkedIn | 3,000 | footer | yes | no |
| Facebook | 63,206 | inline | yes | no |
| Threads | 500 | inline | yes | no |
| Bluesky | 300 | inline | yes | yes |
| Mastodon | 500 | inline | yes | yes |
| TikTok | 2,200 | footer | video | no |
| YouTube | 5,000 | footer | video | no |
| Pinterest | 500 | none | yes | no |
| Reddit | 40,000 | none | yes | yes |
| Dev.to | unlimited | footer | yes | no |
| Hashnode | unlimited | footer | yes | no |
| Medium | unlimited | none | yes | no |
| WordPress | unlimited | none | yes | no |
| Farcaster | 320 | inline | yes | yes |
| Lemmy | 10,000 | none | yes | yes |
| Google Business | 1,500 | none | yes | no |

### Custom Platform Rules

```typescript
engine.registerPlatform('my-platform', {
  maxLength:       500,
  hashtagStyle:    'inline',
  maxHashtags:     5,
  supportsMedia:   true,
  supportsVideo:   false,
  supportsCarousel: false,
  supportsPoll:    false,
  supportsThreading: false,
  toneGuidance:    'Professional and concise.',
});
```

---

## Platform-Specific Examples

### Twitter thread

```typescript
// Long content is automatically split into a thread
const post = manager.createDraft({
  seedId:    'news-agent',
  content:   longArticleSummary,  // > 280 chars
  platforms: ['twitter'],
  metadata:  { thread: true },    // opt in to thread splitting
});
```

### LinkedIn article

```typescript
const post = manager.createDraft({
  seedId:   'thought-leader-agent',
  content:  `
# The Future of AI Agents

Over the past year, we've seen a dramatic shift in how organizations
deploy AI. Rather than isolated chatbots, teams are building networks
of specialized agents that collaborate to solve complex problems.

Here's what I've learned building AgentOS...
  `.trim(),
  platforms: ['linkedin'],
  mediaUrls: ['https://cdn.example.com/header.jpg'],
});
```

### Instagram carousel

```typescript
const post = manager.createDraft({
  seedId:    'brand-agent',
  content:   '5 things I learned building AI agents 🧵',
  platforms: ['instagram'],
  mediaUrls: [
    'https://cdn.example.com/slide-1.jpg',
    'https://cdn.example.com/slide-2.jpg',
    'https://cdn.example.com/slide-3.jpg',
  ],
  tags: ['AI', 'machinelearning', 'buildinpublic'],
});
```

### Bluesky + Mastodon (federated)

```typescript
const post = manager.createDraft({
  seedId:    'open-web-agent',
  content:   'Decentralized social is the future. Here is why...',
  platforms: ['bluesky', 'mastodon', 'farcaster'],
  tags:      ['web3', 'decentralized', 'atprotocol'],
});
```

---

## Scheduling API

```typescript
const manager = new SocialPostManager();

// Schedule for a specific time
const post = manager.createDraft({ seedId: 'agent', content: '...', platforms: ['twitter'] });
manager.schedulePost(post.id, '2026-04-15T08:00:00Z');

// Get upcoming scheduled posts
const upcoming = manager.listScheduled();
console.log(upcoming.map((p) => ({ id: p.id, at: p.scheduledAt })));

// Cancel a scheduled post
manager.cancel(post.id);

// Reschedule
manager.schedulePost(post.id, '2026-04-16T08:00:00Z');
```

**Production scheduling** — the backend `SocialPostSchedulerService` (NestJS cron)
polls `manager.listScheduled()` every minute and fires `publishNow()` for due posts:

```typescript
// Example NestJS cron-based scheduler service
@Cron('* * * * *')
async publishDuePosts(): Promise<void> {
  const due = this.manager.listScheduled().filter(
    (p) => new Date(p.scheduledAt!) <= new Date()
  );
  for (const post of due) {
    await this.manager.publishNow(post.id, this.platformPublisher);
  }
}
```

---

## Media Attachments

```typescript
import { MediaUploadTool } from '@framers/agentos-extensions/tools/media-upload';

const mediaUpload = new MediaUploadTool();

// Upload to the media library
const { mediaId, url } = await mediaUpload.execute({
  filePath: './assets/promo-image.png',
  mimeType: 'image/png',
  tags:     ['promo', 'Q2-2026'],
});

// Attach to post
const post = manager.createDraft({
  seedId:    'brand-agent',
  content:   'Check out our latest launch!',
  platforms: ['twitter', 'instagram', 'linkedin'],
  mediaUrls: [url],
});
```

---

## MultiChannelPostTool

For agents, use [`MultiChannelPostTool`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/tools/multi-channel-post/src/MultiChannelPostTool.ts) to publish to multiple platforms in
one tool call:

```typescript
import { MultiChannelPostTool } from '@framers/agentos-extensions/tools/multi-channel-post';

const tool = new MultiChannelPostTool();

// Agent calls this tool:
const result = await tool.execute({
  content:   'We just shipped a major update to AgentOS! 🚀',
  platforms: ['twitter', 'linkedin', 'bluesky', 'mastodon'],
  tags:      ['AgentOS', 'AI', 'opensource'],
  mediaUrls: ['https://cdn.example.com/release-banner.png'],
  schedule:  '2026-04-01T09:00:00Z',  // optional
});

console.log(result.scheduled);  // { twitter: 'post-123', linkedin: 'urn:...' }
console.log(result.errors);     // {} if all succeeded
```

---

## Cross-Platform Analytics

Aggregate engagement metrics from all platforms:

```typescript
import { CrossPlatformAnalyticsTool } from '@framers/agentos-extensions/tools/social-analytics';

const analytics = new CrossPlatformAnalyticsTool();

const report = await analytics.execute({
  platforms:  ['twitter', 'linkedin', 'bluesky'],
  dateRange:  { from: '2026-03-01', to: '2026-03-31' },
  metrics:    ['impressions', 'engagements', 'clicks', 'followers'],
});

console.log(report.summary);
// {
//   totalImpressions: 84203,
//   totalEngagements: 3147,
//   topPlatform: 'linkedin',
//   bestPost: { id: '...', platform: 'twitter', engagements: 891 },
// }
```

---

## Related Guides

- [CHANNELS.md](./CHANNELS.md) — channel adapter setup
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — content pipeline and blog publisher examples
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — installing and first steps
