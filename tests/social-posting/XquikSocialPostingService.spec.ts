import { afterEach, describe, expect, it, vi } from "vitest";

import { XquikSocialPostingService } from "../../src/io/channels/social-posting/XquikSocialPostingService.js";
import type { SocialPost } from "../../src/io/channels/social-posting/SocialPostManager.js";

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
    expect(init.body).toBe(
      JSON.stringify({ account: "@agent", text: "hello" }),
    );
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

    expect(result).toEqual({ platform: "x", status: "pending" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        account: "@agent",
        media: ["https://example.com/image.png"],
      }),
    );
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

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        account: "@override",
        text: "hello",
        media: ["https://example.com/image.png"],
        reply_to_tweet_id: "tweet-1",
        attachment_url: "https://example.com/card",
        community_id: "community-1",
        is_note_tweet: true,
      }),
    );
  });

  it("rejects unexpected Xquik create tweet responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("accepted", {
        headers: { "content-type": "text/plain" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new XquikSocialPostingService({
      account: "@agent",
      apiKey: "test-key",
    });

    await expect(service.publish({ text: "hello" })).rejects.toThrow(
      "Unexpected Xquik create tweet response.",
    );
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
    const post = {
      adaptations: { twitter: "fallback text", x: "adapted x text" },
      baseContent: "base text",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "post-1",
      platforms: ["x"],
      results: { x: { platform: "x", status: "pending" } },
      retryCount: 0,
      maxRetries: 3,
      seedId: "seed-1",
      status: "publishing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies SocialPost;

    await service.publishPost(post);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({ account: "@agent", text: "adapted x text" }),
    );
  });

  it("falls back from platform adaptation to twitter adaptation and base content", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
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
    const postWithTwitterFallback = {
      adaptations: { twitter: "fallback text" },
      baseContent: "base text",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "post-2",
      platforms: ["x"],
      results: { x: { platform: "x", status: "pending" } },
      retryCount: 0,
      maxRetries: 3,
      seedId: "seed-2",
      status: "publishing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies SocialPost;
    const postWithBaseFallback = {
      ...postWithTwitterFallback,
      adaptations: {},
      baseContent: "base only",
      id: "post-3",
      seedId: "seed-3",
    } satisfies SocialPost;

    await service.publishPost(postWithTwitterFallback);
    await service.publishPost(postWithBaseFallback);

    const twitterFallbackInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const baseFallbackInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(twitterFallbackInit.body).toBe(
      JSON.stringify({ account: "@agent", text: "fallback text" }),
    );
    expect(baseFallbackInit.body).toBe(
      JSON.stringify({ account: "@agent", text: "base only" }),
    );
  });
});
