/**
 * @fileoverview Core types for the AgentOS Channel System.
 *
 * Channels represent external human-facing messaging platforms (Telegram,
 * WhatsApp, Discord, Slack, etc.). This is distinct from the inter-agent
 * {@link CommunicationChannelPayload} (`communication-channel` extension kind)
 * which handles agent-to-agent messaging.
 *
 * @module @framers/agentos/channels/types
 */

// ============================================================================
// Platform Identification
// ============================================================================

/**
 * Supported messaging platforms. Extensible via string literal union —
 * concrete adapters can use any string, but well-known platforms get
 * first-class type support.
 */
export type ChannelPlatform =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'webchat'
  | 'signal'
  | 'imessage'
  | 'google-chat'
  | 'teams'
  | 'matrix'
  | 'zalo'
  | 'email'
  | 'sms'
  | 'nostr'
  | 'twitch'
  | 'line'
  | 'feishu'
  | 'mattermost'
  | 'nextcloud-talk'
  | 'tlon'
  | 'irc'
  | 'zalouser'
  | 'twitter'
  | 'instagram'
  | 'reddit'
  | 'pinterest'
  | 'tiktok'
  | 'youtube'
  | 'linkedin'
  | 'facebook'
  | 'threads'
  | 'bluesky'
  | 'mastodon'
  | 'devto'
  | 'hashnode'
  | 'medium'
  | 'wordpress'
  | 'farcaster'
  | 'lemmy'
  | 'google-business'
  | (string & {});

// ============================================================================
// Channel Capabilities
// ============================================================================

/**
 * Capabilities that a channel adapter can declare. Consumers can check
 * capabilities before attempting actions that not all platforms support.
 */
export type ChannelCapability =
  | 'text'
  | 'rich_text'
  | 'images'
  | 'video'
  | 'audio'
  | 'voice_notes'
  | 'documents'
  | 'stickers'
  | 'reactions'
  | 'threads'
  | 'typing_indicator'
  | 'read_receipts'
  | 'group_chat'
  | 'channels'
  | 'buttons'
  | 'inline_keyboard'
  | 'embeds'
  | 'mentions'
  | 'editing'
  | 'deletion'
  | 'stories'
  | 'reels'
  | 'hashtags'
  | 'polls'
  | 'carousel'
  | 'engagement_metrics'
  | 'scheduling'
  | 'dm_automation'
  | 'content_discovery'
  | (string & {});

// ============================================================================
// Connection Status
// ============================================================================

/** Connection health of a channel adapter. */
export type ChannelConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/** Detailed connection info returned by adapters. */
export interface ChannelConnectionInfo {
  status: ChannelConnectionStatus;
  /** When the connection was last established. */
  connectedSince?: string;
  /** Human-readable error if status is 'error'. */
  errorMessage?: string;
  /** Platform-specific metadata (e.g., bot username, workspace name). */
  platformInfo?: Record<string, unknown>;
}

// ============================================================================
// Authentication
// ============================================================================

/** Authentication configuration passed to an adapter during initialization. */
export interface ChannelAuthConfig {
  /** Platform this config targets. */
  platform: ChannelPlatform;
  /** Primary credential (bot token, API key, session data, etc.). */
  credential: string;
  /** Additional auth parameters (e.g., webhook URL, app secret). */
  params?: Record<string, string>;
}

// ============================================================================
// Messages
// ============================================================================

/** Conversation type within a channel. */
export type ConversationType = 'direct' | 'group' | 'channel' | 'thread';

/**
 * Content block within a message. A single message can contain multiple
 * content blocks (e.g., text + image attachment).
 */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; caption?: string; mimeType?: string }
  | { type: 'video'; url: string; caption?: string; mimeType?: string }
  | { type: 'audio'; url: string; duration?: number; mimeType?: string }
  | { type: 'document'; url: string; filename: string; mimeType?: string }
  | { type: 'sticker'; stickerId: string; url?: string }
  | { type: 'location'; latitude: number; longitude: number; name?: string }
  | { type: 'button_group'; buttons: MessageButton[] }
  | { type: 'embed'; title: string; description?: string; url?: string; color?: string; fields?: { name: string; value: string; inline?: boolean }[] }
  | { type: 'poll'; question: string; options: string[]; durationHours?: number }
  | { type: 'story'; mediaUrl: string; caption?: string; stickers?: string[] }
  | { type: 'reel'; videoUrl: string; caption?: string; audio?: string; hashtags?: string[] }
  | { type: 'carousel'; items: { url: string; caption?: string; mimeType?: string }[] };

/** Interactive button in a message. */
export interface MessageButton {
  id: string;
  label: string;
  /** 'callback' triggers an event; 'url' opens a link. */
  action: 'callback' | 'url';
  value: string;
}

/**
 * Outbound message content — what the agent wants to send.
 */
export interface MessageContent {
  /** Content blocks to send. At minimum one 'text' block. */
  blocks: MessageContentBlock[];
  /** Reply to a specific message (platform threading). */
  replyToMessageId?: string;
  /** Platform-specific send options. */
  platformOptions?: Record<string, unknown>;
}

/**
 * Identity of a remote user on an external platform.
 */
export interface RemoteUser {
  /** Platform-native user ID. */
  id: string;
  /** Display name (may change). */
  displayName?: string;
  /** Username/handle if available. */
  username?: string;
  /** Avatar URL if available. */
  avatarUrl?: string;
  /** True when the platform marks this sender as a bot/automated account. */
  isBot?: boolean;
}

/**
 * Inbound message received from an external platform.
 */
export interface ChannelMessage {
  /** Unique message ID assigned by the platform. */
  messageId: string;
  /** Platform this message came from. */
  platform: ChannelPlatform;
  /** Conversation/chat ID. */
  conversationId: string;
  /** Conversation type. */
  conversationType: ConversationType;
  /** Who sent the message. */
  sender: RemoteUser;
  /** Message content. */
  content: MessageContentBlock[];
  /** Raw text representation (convenience — extracted from content blocks). */
  text: string;
  /** ISO timestamp from the platform. */
  timestamp: string;
  /** Message being replied to, if this is a reply. */
  replyToMessageId?: string;
  /**
   * Platform-native user IDs mentioned in this message, when the adapter can
   * extract them (used by GroupPolicy mention gating). Adapters that cannot
   * detect mentions leave this undefined and SHOULD NOT set supportsMentions.
   */
  mentions?: string[];
  /** Set true by adapters that reliably populate `mentions`. */
  supportsMentions?: boolean;
  /** Platform-specific raw data (for adapters that need pass-through). */
  rawEvent?: unknown;
}

/** Send result from an adapter. */
export interface ChannelSendResult {
  /** Platform-assigned message ID for the sent message. */
  messageId: string;
  /** Timestamp of the sent message. */
  timestamp?: string;
}

/** Group activation modes for GroupPolicy. */
export type GroupActivation = 'mention' | 'always' | 'owner-only';

/**
 * Group-chat safety policy. Evaluated by evaluateGroupPolicy()
 * (./group-policy.ts) before inbound group messages reach the agent —
 * enforced in ChannelRouter and reusable by host security gates.
 */
export interface GroupPolicy {
  /** When the agent engages in group conversations. Recommended default for new bindings: 'mention'. */
  activation: GroupActivation;
  /** Extra owner user IDs honored by 'owner-only' (the binding's ownerUserId always counts). */
  ownerIds?: string[];
  /** Only these sender IDs may activate the agent (empty/undefined = everyone). */
  allowFrom?: string[];
  /** These sender IDs are always dropped (wins over allowFrom). */
  denyFrom?: string[];
  /** Tool names blocked for turns originating from this group (host-enforced). */
  toolRestrictions?: string[];
  /** Drop messages from bot senders (loop protection). Default true. */
  botLoopProtection?: boolean;
}

// ============================================================================
// Channel Events
// ============================================================================

/** Events emitted by channel adapters. */
export type ChannelEventType =
  | 'message'
  | 'message_edited'
  | 'message_deleted'
  | 'reaction_added'
  | 'reaction_removed'
  | 'member_joined'
  | 'member_left'
  | 'typing'
  | 'button_callback'
  | 'error'
  | 'connection_change';

/**
 * Generic channel event wrapper. The `data` field varies by event type.
 */
export interface ChannelEvent<T = unknown> {
  type: ChannelEventType;
  platform: ChannelPlatform;
  conversationId: string;
  timestamp: string;
  data: T;
}

/** Handler function for channel events. */
export type ChannelEventHandler = (event: ChannelEvent) => void | Promise<void>;

/** Message-specific event data. */
export type MessageEvent = ChannelEvent<ChannelMessage> & { type: 'message' };

/** Button callback event data. */
export interface ButtonCallbackData {
  callbackId: string;
  buttonId: string;
  sender: RemoteUser;
  messageId: string;
}
export type ButtonCallbackEvent = ChannelEvent<ButtonCallbackData> & { type: 'button_callback' };

// ============================================================================
// Channel Binding (extended from Wunderland core)
// ============================================================================

/**
 * Binding between an agent (seed) and a channel on an external platform.
 * Extended from the original Wunderland `ChannelBinding` with additional fields
 * for the full channel system.
 */
export interface ChannelBindingConfig {
  /** Unique binding identifier. */
  bindingId: string;
  /** Agent seed ID. */
  seedId: string;
  /** Owner user ID (for permission checks). */
  ownerUserId: string;
  /** Target platform. */
  platform: ChannelPlatform;
  /** Platform-native channel/chat ID. */
  channelId: string;
  /** Type of conversation. */
  conversationType: ConversationType;
  /** Credential ID (references encrypted credential in vault). */
  credentialId?: string;
  /** Whether this binding is active. */
  isActive: boolean;
  /** Whether agent posts should auto-broadcast to this channel. */
  autoBroadcast: boolean;
  /** Platform-specific configuration. */
  platformConfig?: Record<string, unknown>;
  /** Group-chat safety policy for this binding (see GroupPolicy / group-policy.ts). */
  groupPolicy?: GroupPolicy;
}

/**
 * Active session between an agent and a remote conversation.
 */
export interface ChannelSession {
  /** Unique session ID. */
  sessionId: string;
  /** Agent seed ID. */
  seedId: string;
  /** Platform. */
  platform: ChannelPlatform;
  /** Platform-native conversation ID. */
  conversationId: string;
  /** Conversation type. */
  conversationType: ConversationType;
  /** Remote user (for DMs). */
  remoteUser?: RemoteUser;
  /** Last message timestamp. */
  lastMessageAt: string;
  /** Total messages exchanged. */
  messageCount: number;
  /** Whether this session is active. */
  isActive: boolean;
  /** Session context data (for multi-turn state). */
  context?: Record<string, unknown>;
}

// ============================================================================
// Channel Info (for registry/discovery)
// ============================================================================

/** Metadata about an available channel adapter. */
export interface ChannelInfo {
  /** Platform identifier. */
  platform: ChannelPlatform;
  /** Human-friendly display name (e.g., "WhatsApp Business"). */
  displayName: string;
  /** Description of the channel. */
  description: string;
  /** Capabilities this adapter supports. */
  capabilities: ChannelCapability[];
  /** Whether the adapter's dependencies are installed. */
  available: boolean;
  /** Required secret IDs for this channel. */
  requiredSecrets: string[];
  /** Icon identifier or URL. */
  icon?: string;
}
