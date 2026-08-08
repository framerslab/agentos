import type { SocialPost, SocialPostPlatformResult } from "./SocialPostManager";
import {
  SocialAbstractService,
  type SocialRequestOptions,
  type SocialServiceConfig,
} from "./SocialAbstractService";

export interface XquikSocialPostingConfig extends SocialServiceConfig {
  apiKey: string;
  account: string;
  baseUrl?: string;
  platform?: string;
}

export interface XquikPublishInput {
  text: string;
  account?: string;
  attachmentUrl?: string;
  communityId?: string;
  isNoteTweet?: boolean;
  mediaUrls?: string[];
  replyToTweetId?: string;
}

interface XquikCreateTweetBody {
  account: string;
  text?: string;
  attachment_url?: string;
  community_id?: string;
  is_note_tweet?: boolean;
  media?: string[];
  reply_to_tweet_id?: string;
}

interface XquikCreateTweetSuccess {
  success: true;
  tweetId: string;
  writeActionId?: string;
}

interface XquikCreateTweetPending {
  error: "x_write_unconfirmed";
  status: "pending_confirmation";
  writeActionId: string;
}

export interface XquikSocialPostPlatformResult extends SocialPostPlatformResult {
  writeActionId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isXquikCreateTweetSuccess = (
  response: unknown,
): response is XquikCreateTweetSuccess =>
  isRecord(response) &&
  response.success === true &&
  typeof response.tweetId === "string";

const isXquikCreateTweetPending = (
  response: unknown,
): response is XquikCreateTweetPending =>
  isRecord(response) &&
  response.error === "x_write_unconfirmed" &&
  response.status === "pending_confirmation" &&
  typeof response.writeActionId === "string";

const getXquikErrorMessage = (response: unknown): string => {
  if (isRecord(response)) {
    if (typeof response.error === "string") {
      return response.error;
    }

    if (typeof response.message === "string") {
      return response.message;
    }
  }

  return "Unexpected Xquik create tweet response.";
};

export class XquikSocialPostingService extends SocialAbstractService {
  private readonly account: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly platform: string;

  constructor(config: XquikSocialPostingConfig) {
    super(config);
    this.account = config.account;
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://xquik.com").replace(/\/+$/, "");
    this.platform = config.platform ?? "twitter";
  }

  async publish(
    input: XquikPublishInput,
    options: SocialRequestOptions = {},
  ): Promise<XquikSocialPostPlatformResult> {
    const response = await this.fetchJson<unknown>(
      `${this.baseUrl}/api/v1/x/tweets`,
      {
        body: JSON.stringify(this.createRequestBody(input)),
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        method: "POST",
      },
      options,
    );

    if (isXquikCreateTweetSuccess(response)) {
      return {
        platform: this.platform,
        postId: response.tweetId,
        publishedAt: new Date().toISOString(),
        status: "success",
        url: `https://x.com/i/web/status/${response.tweetId}`,
      };
    }

    if (isXquikCreateTweetPending(response)) {
      return {
        platform: this.platform,
        status: "pending",
        writeActionId: response.writeActionId,
      };
    }

    return {
      error: getXquikErrorMessage(response),
      platform: this.platform,
      status: "error",
    };
  }

  publishPost(
    post: SocialPost,
    options: SocialRequestOptions = {},
  ): Promise<XquikSocialPostPlatformResult> {
    const input: XquikPublishInput = {
      text:
        post.adaptations[this.platform] ||
        post.adaptations.twitter ||
        post.baseContent,
    };

    if (post.mediaUrls) {
      input.mediaUrls = [...post.mediaUrls];
    }

    return this.publish(input, options);
  }

  private createRequestBody(input: XquikPublishInput): XquikCreateTweetBody {
    const body: XquikCreateTweetBody = {
      account: input.account ?? this.account,
    };

    if (input.text) {
      body.text = input.text;
    }

    if (input.mediaUrls?.length) {
      body.media = [...input.mediaUrls];
    }

    if (input.replyToTweetId) {
      body.reply_to_tweet_id = input.replyToTweetId;
    }

    if (input.attachmentUrl) {
      body.attachment_url = input.attachmentUrl;
    }

    if (input.communityId) {
      body.community_id = input.communityId;
    }

    if (input.isNoteTweet !== undefined) {
      body.is_note_tweet = input.isNoteTweet;
    }

    return body;
  }
}
