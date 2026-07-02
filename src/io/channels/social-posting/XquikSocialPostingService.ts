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

type XquikCreateTweetResponse =
  | XquikCreateTweetSuccess
  | XquikCreateTweetPending;

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
  ): Promise<SocialPostPlatformResult> {
    const response = await this.fetchJson<XquikCreateTweetResponse>(
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

    if ("success" in response && response.success) {
      return {
        platform: this.platform,
        postId: response.tweetId,
        publishedAt: new Date().toISOString(),
        status: "success",
        url: `https://x.com/i/web/status/${response.tweetId}`,
      };
    }

    return {
      platform: this.platform,
      status: "pending",
    };
  }

  publishPost(
    post: SocialPost,
    options: SocialRequestOptions = {},
  ): Promise<SocialPostPlatformResult> {
    const input: XquikPublishInput = {
      text:
        post.adaptations[this.platform] ??
        post.adaptations.twitter ??
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
