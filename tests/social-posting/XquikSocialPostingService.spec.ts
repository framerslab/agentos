import { afterEach, describe, expect, it, vi } from "vitest";

import { XquikSocialPostingService } from "../../src/io/channels/social-posting/XquikSocialPostingService.js";
import type { SocialPost } from "../../src/io/channels/social-posting/SocialPostManager.js";

const buildTestPost = (overrides: Partial<SocialPost> = {}): SocialPost => ({
  adaptations: { twitter: "fallback text", x: "adapted x text" },
  baseContent: "base text",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "post-1",
  maxRetries: 3,
  platforms: ["x"],
  results: { x: { platform: "x", status: "pending" } },
  retryCount: 0,
  seedId: "seed-1",
  status: "publishing",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const readRequestBody = (
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0,
) => {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
};

describe("XquikSocialPostingService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a tweet through the Xquik create tweet endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, tweetId: "12345" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
    });
    const result = await service.publish({ text: "hello" });

    expect(result).toMatchObject({
      platform: "twitter",
      postId: "12345",
      status: "success",
      url: "https://x.com/i/web/status/12345",
    });
    expect(result.publishedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(result.publishedAt ?? ""))).toBe(false);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://xquik.com/api/v1/x/tweets");

    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      account: "@agent",
      text: "hello",
    });
  });

  it("maps pending confirmation responses to a pending platform result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "x_write_unconfirmed",
          status: "pending_confirmation",
          writeActionId: "42",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 202,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
      platform: "x",
    });
    const result = await service.publish({
      mediaUrls: ["https://example.com/image.png"],
      text: "",
    });

    expect(result).toEqual({
      platform: "x",
      status: "pending",
      writeActionId: "42",
    });
    expect(readRequestBody(fetchMock)).toEqual({
      account: "@agent",
      media: ["https://example.com/image.png"],
    });
  });

  it("maps optional Xquik request fields to the create tweet body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, tweetId: "67890" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
    });

    await service.publish({
      account: "@override",
      attachmentUrl: "https://example.com/card",
      communityId: "community-1",
      isNoteTweet: true,
      mediaUrls: ["https://example.com/image.png"],
      replyToTweetId: "tweet-1",
      text: "hello",
    });

    expect(readRequestBody(fetchMock)).toEqual({
      account: "@override",
      attachment_url: "https://example.com/card",
      community_id: "community-1",
      is_note_tweet: true,
      media: ["https://example.com/image.png"],
      reply_to_tweet_id: "tweet-1",
      text: "hello",
    });
  });

  it("maps Xquik error responses to an error platform result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_request" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
    });

    await expect(service.publish({ text: "hello" })).resolves.toEqual({
      error: "invalid_request",
      platform: "twitter",
      status: "error",
    });
  });

  it("publishes the adapted platform content from a social post", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, tweetId: "67890" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
      platform: "x",
    });
    const post = buildTestPost();

    await service.publishPost(post);

    expect(readRequestBody(fetchMock)).toEqual({
      account: "@agent",
      text: "adapted x text",
    });
  });

  it("falls back from platform adaptation to twitter adaptation and base content", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ success: true, tweetId: "67890" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
      platform: "x",
    });
    const postWithTwitterFallback = buildTestPost({
      adaptations: { twitter: "fallback text" },
      id: "post-2",
      seedId: "seed-2",
    });
    const postWithBaseFallback = buildTestPost({
      adaptations: {},
      baseContent: "base only",
      id: "post-3",
      seedId: "seed-3",
    });
    const postWithEmptyPlatformAdaptation = buildTestPost({
      adaptations: { twitter: "fallback after empty", x: "" },
      id: "post-4",
      seedId: "seed-4",
    });
    const postWithEmptyAdaptations = buildTestPost({
      adaptations: { twitter: "", x: "" },
      baseContent: "base after empty",
      id: "post-5",
      seedId: "seed-5",
    });

    await service.publishPost(postWithTwitterFallback);
    await service.publishPost(postWithBaseFallback);
    await service.publishPost(postWithEmptyPlatformAdaptation);
    await service.publishPost(postWithEmptyAdaptations);

    expect(readRequestBody(fetchMock)).toEqual({
      account: "@agent",
      text: "fallback text",
    });
    expect(readRequestBody(fetchMock, 1)).toEqual({
      account: "@agent",
      text: "base only",
    });
    expect(readRequestBody(fetchMock, 2)).toEqual({
      account: "@agent",
      text: "fallback after empty",
    });
    expect(readRequestBody(fetchMock, 3)).toEqual({
      account: "@agent",
      text: "base after empty",
    });
  });
});
