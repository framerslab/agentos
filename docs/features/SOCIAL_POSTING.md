# Social Posting — Multi-Platform Publishing

> Track, adapt, and publish posts across social platforms: a post lifecycle manager and per-platform content rules in AgentOS, and posting tools in the extension packs.

---

## Table of Contents

1. [Overview](#overview)
2. [SocialPostManager](#socialpostmanager)
3. [Post Lifecycle](#post-lifecycle)
4. [ContentAdaptationEngine](#contentadaptationengine)
5. [Platform-Specific Examples](#platform-specific-examples)
6. [Scheduling](#scheduling)
7. [Media Attachments](#media-attachments)
8. [MultiChannelPostTool](#multichannelposttool)
9. [Cross-Platform Analytics](#cross-platform-analytics)

---

## Overview

AgentOS ships two building blocks, exported from `@framers/agentos/social-posting`:

- **SocialPostManager**: an in-memory state machine for each post's lifecycle (draft → published), which calls a publish handler you supply.
- **ContentAdaptationEngine**: deterministic per-platform rules for length, hashtag placement and warnings.

The extension packs add the agent-facing tools: `@framers/agentos-ext-tool-multi-channel-post` (`MultiChannelPostTool`), `@framers/agentos-ext-tool-bulk-scheduler`, `@framers/agentos-ext-tool-social-analytics` and `@framers/agentos-ext-tool-media-upload`, plus one channel pack per platform ([Channels](./CHANNELS.md)).

**Platforms with adaptation rules:** Twitter, Threads, Bluesky, Mastodon, Farcaster, Instagram, TikTok, Pinterest, YouTube, LinkedIn, Facebook, Reddit, Lemmy, Dev.to, Hashnode, Medium, WordPress (17). Any other platform id gets the default rules.

---

## SocialPostManager

[`SocialPostManager`](https://github.com/framerslab/agentos/blob/master/src/io/channels/social-posting/SocialPostManager.ts) is the low-level post lifecycle engine. It keeps each post in memory, and every method returns a snapshot of the post after the change, so read the returned value rather than an earlier one.

```typescript
import { SocialPostManager } from '@framers/agentos/social-posting';

const manager = new SocialPostManager();

// Called once per platform when a post is published.
manager.setPublishHandler(async (post, platform) => {
  const text = post.adaptations[platform] ?? post.baseContent;
  // Your platform-specific publish logic here
  return { platform, status: 'success', postId: 'abc123', url: `https://${platform}.example/post/abc123` };
});

// Create a draft
const draft = manager.createDraft({
  seedId:    'agent-alpha',
  content:   'Excited to announce our new AI feature! Check it out: https://example.com',
  platforms: ['twitter', 'linkedin', 'bluesky'],
  mediaUrls: ['https://cdn.example.com/screenshot.png'],
});
console.log(draft.id);     // UUID
console.log(draft.status); // 'draft'

// Schedule it
const scheduled = manager.schedulePost(draft.id, '2026-04-01T09:00:00Z');
console.log(scheduled.status); // 'scheduled'

// Or publish now: every platform in parallel through the handler
const published = await manager.publishNow(draft.id);
console.log(published.status); // 'published', or 'error' when any platform failed
console.log(published.results); // { twitter: { status: 'success', postId, url }, ... }
```

Without a publish handler, `publishNow()` moves the post to `publishing` and stops there; record each platform's outcome yourself with `markPlatformResult(postId, platform, result)`, which moves the post to `published` once every platform succeeded, or to `error` once none is pending and one failed.

### Creating a Draft

```typescript
const post = manager.createDraft({
  seedId:      'my-agent',
  content:     'Base content: platform-agnostic text.',
  platforms:   ['twitter', 'instagram', 'linkedin'],
  mediaUrls:   ['https://cdn.example.com/image.png'],
  adaptations: { twitter: 'Short version for X.' },   // per-platform text overrides
  schedule:    '2026-04-15T08:00:00Z',                 // optional: created as 'scheduled'
});
```

Each post allows 3 retries (`maxRetries`).

### Listing Posts

```typescript
const drafts    = manager.listPosts(undefined, 'draft');
const scheduled = manager.listPosts(undefined, 'scheduled');
const byAgent   = manager.listPosts('agent-alpha');
const one       = manager.getPost(post.id);
const due       = manager.getDuePosts();   // scheduled posts whose time has come
```

---

## Post Lifecycle

```
createDraft()
     ↓
   DRAFT ──────────────────────────────────────────────┐
     ↓ schedulePost()                                   │ publishNow()
SCHEDULED                                               │
     ↓ publishNow() (your scheduler)                    │
PUBLISHING ◄────────────────────────────────────────────┘
     ↓                ↓
PUBLISHED           ERROR
                      ↓ retryFailed()
                    RETRY
                      ↓ publishNow()
                  PUBLISHING
```

| Method | Transitions |
|--------|-------------|
| `createDraft(input)` | Creates in `draft`, or in `scheduled` when `input.schedule` is set |
| `schedulePost(id, isoDate)` | `draft` → `scheduled` |
| `publishNow(id)` | `draft`, `scheduled` or `retry` → `publishing` → `published` or `error` |
| `markPlatformResult(id, platform, result)` | Records one platform's result; moves the post to `published` or `error` when no platform is pending |
| `retryFailed(id)` | `error` → `retry`, resetting the failed platforms to `pending`; throws after `maxRetries` |

Any other transition throws.

---

## ContentAdaptationEngine

The adaptation engine applies deterministic, platform-specific rules to a base content string: character limits, hashtag placement and limits, and warnings.

```typescript
import { ContentAdaptationEngine } from '@framers/agentos/social-posting';

const engine = new ContentAdaptationEngine();

const adapted = engine.adaptContent(
  'Announcing our new AI feature! It automatically summarizes long documents into bullet points. Try it now at https://example.com',
  ['twitter', 'linkedin', 'instagram', 'bluesky'],
  ['announcement', 'AI', 'productivity'],
);

console.log(adapted.twitter.text);        // the text with inline hashtags, cut to 280 characters when longer
console.log(adapted.instagram.hashtags);  // the hashtags placed in the footer
console.log(adapted.bluesky.hashtags);    // [] (Bluesky takes no hashtags)
console.log(adapted.twitter.truncated);   // true if content was cut
console.log(adapted.twitter.warnings);    // e.g. a hashtag-count or truncation warning
```

Each entry is an `AdaptedContent`: `platform`, `text`, `hashtags`, `truncated`, `mediaSupported` and `warnings`. `getConstraints(platform)` returns a platform's rules, and `truncateWithEllipsis(text, maxLength)` is the cutter the engine uses.

### Platform Constraints Reference

| Platform | Max Length | Hashtag Style | Max Hashtags | Media | Video | Threading |
|----------|-----------|---------------|--------------|-------|-------|-----------|
| Twitter | 280 | inline | 5 | yes | yes | yes |
| Threads | 500 | inline | 5 | yes | yes | yes |
| Bluesky | 300 | none | 0 | yes | yes | yes |
| Mastodon | 500 | inline | 10 | yes | yes | yes |
| Farcaster | 320 | none | 0 | yes | no | yes |
| Instagram | 2,200 | footer | 30 | yes | yes | no |
| TikTok | 2,200 | inline | 10 | no | yes | no |
| Pinterest | 500 | none | 0 | yes | yes | no |
| YouTube | 5,000 | inline | 15 | no | yes | no |
| LinkedIn | 3,000 | footer | 5 | yes | yes | no |
| Facebook | 63,206 | inline | 10 | yes | yes | no |
| Reddit | 40,000 | none | 0 | yes | yes | no |
| Lemmy | 10,000 | none | 0 | yes | no | no |
| Dev.to | 100,000 | none | 0 | yes | no | no |
| Hashnode | 100,000 | none | 0 | yes | no | no |
| Medium | 100,000 | none | 0 | yes | no | no |
| WordPress | 100,000 | none | 0 | yes | yes | no |
| Any other id | 10,000 | inline | 10 | yes | yes | no |

The rules are fixed in the engine; it has no API for registering a platform.

---

## Platform-Specific Examples

### A short and a long version

```typescript
const post = manager.createDraft({
  seedId:    'news-agent',
  content:   longArticleSummary,
  platforms: ['twitter', 'linkedin'],
  adaptations: {
    twitter: 'The short version, under 280 characters, with a link.',
  },
});
```

The manager does not split long text into threads; a publish handler that wants a thread splits it itself.

### Adapted text for every platform

```typescript
const base = '5 things I learned building AI agents';
const platforms = ['instagram', 'bluesky', 'mastodon', 'farcaster'];
const adapted = engine.adaptContent(base, platforms, ['AI', 'buildinpublic']);

const post = manager.createDraft({
  seedId:      'brand-agent',
  content:     base,
  platforms,
  mediaUrls:   ['https://cdn.example.com/slide-1.jpg', 'https://cdn.example.com/slide-2.jpg'],
  adaptations: Object.fromEntries(platforms.map((p) => [p, adapted[p].text])),
});
```

---

## Scheduling

`SocialPostManager` keeps the schedule and runs nothing on a timer: `getDuePosts()` returns the scheduled posts whose time has come, and your process publishes them.

```typescript
const manager = new SocialPostManager();
manager.setPublishHandler(publishToPlatform);

const draft = manager.createDraft({ seedId: 'agent', content: '...', platforms: ['twitter'] });
manager.schedulePost(draft.id, '2026-04-15T08:00:00Z');

// Upcoming posts
const upcoming = manager.listPosts(undefined, 'scheduled');
console.log(upcoming.map((p) => ({ id: p.id, at: p.scheduledAt })));

// Your scheduler: publish what is due every minute
setInterval(async () => {
  for (const post of manager.getDuePosts()) {
    await manager.publishNow(post.id);
  }
}, 60_000);
```

The manager holds posts in memory only, so a process restart loses them; a host that needs schedules to survive keeps them in its own store.

---

## Media Attachments

A post carries media as URLs in `mediaUrls`; the publish handler attaches them on each platform. `ContentAdaptationEngine` reports per platform whether it takes media (`mediaSupported`). The `@framers/agentos-ext-tool-media-upload` pack gives agents a media upload tool.

---

## MultiChannelPostTool

For agents, [`MultiChannelPostTool`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/tools/multi-channel-post/src/MultiChannelPostTool.ts) (`@framers/agentos-ext-tool-multi-channel-post`) publishes to several platforms in one tool call. It calls each platform's own posting tool (`twitterPost`, `linkedinPost`, `blueskyPost`, `mastodonPost`, and so on) through a tool executor that the host, or the orchestrator that loads the pack, sets with `setToolExecutor()`:

```typescript
import { MultiChannelPostTool } from '@framers/agentos-ext-tool-multi-channel-post';

const tool = new MultiChannelPostTool();
tool.setToolExecutor(async (toolName, args) => {
  // Run the platform tool through your tool orchestrator.
  return { success: true, data: { postId: 'post-123' } };
});

const result = await tool.execute({
  content:   'We just shipped a major update to AgentOS!',
  platforms: ['twitter', 'linkedin', 'bluesky', 'mastodon'],
  hashtags:  ['AgentOS', 'AI', 'opensource'],
  mediaUrls: ['https://cdn.example.com/release-banner.png'],
  // adaptations, platformConfigs (per-platform tool arguments) and dryRun are optional
});
```

The output reports `totalPlatforms`, `successful`, `failed` and one result per platform (`platform`, `success`, `postId`, `url`, `adaptedContent`, `error`). The tool does not schedule; scheduling is the bulk-scheduler pack's or your own.

---

## Cross-Platform Analytics

The `@framers/agentos-ext-tool-social-analytics` pack gives agents a social analytics tool; its README describes its input and output.

---

## Related Guides

- [CHANNELS.md](./CHANNELS.md) — channel adapter setup
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — content pipeline and blog publisher examples
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — installing and first steps
