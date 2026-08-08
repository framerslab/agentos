/**
 * @fileoverview Barrel exports for channel adapter implementations.
 *
 * Provides the abstract {@link BaseChannelAdapter} that all concrete
 * adapters extend, plus all first-party adapter implementations for
 * the P0 core messaging platforms, social media, and extended platforms.
 *
 * @module @framers/agentos/channels/adapters
 */

export { BaseChannelAdapter } from './BaseChannelAdapter.js';
export type { RetryConfig } from './BaseChannelAdapter.js';

export { IRCChannelAdapter } from './IRCChannelAdapter.js';
export type { IRCAuthParams } from './IRCChannelAdapter.js';

// P0: Core messaging platforms
export { TelegramChannelAdapter } from './TelegramChannelAdapter.js';
export type { TelegramAuthParams } from './TelegramChannelAdapter.js';

export { DiscordChannelAdapter } from './DiscordChannelAdapter.js';
export type { DiscordAuthParams } from './DiscordChannelAdapter.js';

export { SlackChannelAdapter } from './SlackChannelAdapter.js';
export type { SlackAuthParams } from './SlackChannelAdapter.js';

export { WhatsAppChannelAdapter } from './WhatsAppChannelAdapter.js';
export type { WhatsAppAuthParams } from './WhatsAppChannelAdapter.js';

export { PlivoSmsChannelAdapter, computePlivoV3Signature } from './PlivoSmsChannelAdapter.js';
export type { PlivoSmsAuthParams } from './PlivoSmsChannelAdapter.js';

export { WebChatChannelAdapter } from './WebChatChannelAdapter.js';
export type { WebChatAuthParams } from './WebChatChannelAdapter.js';

// P0: Social media platforms
export { TwitterChannelAdapter } from './TwitterChannelAdapter.js';
export type { TwitterAuthParams } from './TwitterChannelAdapter.js';

export { RedditChannelAdapter } from './RedditChannelAdapter.js';
export type { RedditAuthParams } from './RedditChannelAdapter.js';

// P1: Extended messaging platforms
export { SignalChannelAdapter } from './SignalChannelAdapter.js';
export type { SignalAuthParams } from './SignalChannelAdapter.js';

export { TeamsChannelAdapter } from './TeamsChannelAdapter.js';
export type { TeamsAuthParams } from './TeamsChannelAdapter.js';

export { GoogleChatChannelAdapter } from './GoogleChatChannelAdapter.js';
export type { GoogleChatAuthParams } from './GoogleChatChannelAdapter.js';
