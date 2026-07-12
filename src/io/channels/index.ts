/**
 * Barrel exports for the AgentOS Channel System.
 *
 * @module @framers/agentos/channels
 */

export * from './types.js';
export type { IChannelAdapter } from './IChannelAdapter.js';
export { ChannelRouter } from './ChannelRouter.js';
export type { InboundMessageHandler, RegisterAdapterOptions } from './ChannelRouter.js';
export { evaluateGroupPolicy } from './group-policy.js';
export type { GroupPolicyInput, GroupPolicyResult, GroupPolicyReason } from './group-policy.js';

// Phase 4: Adapter implementations — base class + 13 platform adapters
export { BaseChannelAdapter } from './adapters/BaseChannelAdapter.js';
export type { RetryConfig } from './adapters/BaseChannelAdapter.js';

// P0 Core Messaging
export { TelegramChannelAdapter } from './adapters/TelegramChannelAdapter.js';
export type { TelegramAuthParams } from './adapters/TelegramChannelAdapter.js';
export { DiscordChannelAdapter } from './adapters/DiscordChannelAdapter.js';
export type { DiscordAuthParams } from './adapters/DiscordChannelAdapter.js';
export { SlackChannelAdapter } from './adapters/SlackChannelAdapter.js';
export type { SlackAuthParams } from './adapters/SlackChannelAdapter.js';
export { WhatsAppChannelAdapter } from './adapters/WhatsAppChannelAdapter.js';
export type { WhatsAppAuthParams } from './adapters/WhatsAppChannelAdapter.js';
export { WebChatChannelAdapter } from './adapters/WebChatChannelAdapter.js';
export type { WebChatAuthParams } from './adapters/WebChatChannelAdapter.js';

// P0 Social Media
export { TwitterChannelAdapter } from './adapters/TwitterChannelAdapter.js';
export type { TwitterAuthParams } from './adapters/TwitterChannelAdapter.js';
export { RedditChannelAdapter } from './adapters/RedditChannelAdapter.js';
export type { RedditAuthParams } from './adapters/RedditChannelAdapter.js';

// P1 Extended Messaging
export { IRCChannelAdapter } from './adapters/IRCChannelAdapter.js';
export type { IRCAuthParams } from './adapters/IRCChannelAdapter.js';
export { SignalChannelAdapter } from './adapters/SignalChannelAdapter.js';
export type { SignalAuthParams } from './adapters/SignalChannelAdapter.js';
export { TeamsChannelAdapter } from './adapters/TeamsChannelAdapter.js';
export type { TeamsAuthParams } from './adapters/TeamsChannelAdapter.js';
export { GoogleChatChannelAdapter } from './adapters/GoogleChatChannelAdapter.js';
export type { GoogleChatAuthParams } from './adapters/GoogleChatChannelAdapter.js';
