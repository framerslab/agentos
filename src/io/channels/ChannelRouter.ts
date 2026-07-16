/**
 * @fileoverview Channel Router — routes messages between external platforms
 * and agent seeds.
 *
 * The ChannelRouter sits between {@link IChannelAdapter} implementations
 * and the agent runtime (e.g., Wunderland's StimulusRouter). It:
 *
 * 1. Manages adapter instances per platform.
 * 2. Maintains binding lookups (platform+conversationId -> seedId).
 * 3. Dispatches inbound messages to registered handlers.
 * 4. Routes outbound agent messages to the correct adapter.
 *
 * @module @framers/agentos/channels/ChannelRouter
 */

import type { IChannelAdapter } from './IChannelAdapter.js';
import { evaluateGroupPolicy } from './group-policy.js';
import type {
  ChannelBindingConfig,
  ChannelInfo,
  ChannelMessage,
  ChannelPlatform,
  ChannelSendResult,
  ChannelSession,
  MessageContent,
} from './types.js';

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler invoked when an inbound message is received and matched to a seed.
 */
export type InboundMessageHandler = (
  message: ChannelMessage,
  binding: ChannelBindingConfig,
  session: ChannelSession,
) => void | Promise<void>;

/**
 * Options for registering an adapter with the router.
 */
export interface RegisterAdapterOptions {
  /** Override the platform key (defaults to adapter.platform). */
  platformKey?: string;
}

// ============================================================================
// ChannelRouter
// ============================================================================

/**
 * Central routing hub for all external messaging channels.
 *
 * @example
 * ```typescript
 * const router = new ChannelRouter();
 *
 * // Register adapters
 * router.registerAdapter(telegramAdapter);
 * router.registerAdapter(discordAdapter);
 *
 * // Add bindings
 * router.addBinding({
 *   bindingId: 'b1',
 *   seedId: 'cipher-001',
 *   ownerUserId: 'user-1',
 *   platform: 'telegram',
 *   channelId: '123456789',
 *   conversationType: 'direct',
 *   isActive: true,
 *   autoBroadcast: false,
 * });
 *
 * // Handle inbound messages
 * router.onMessage(async (message, binding, session) => {
 *   // Route to StimulusRouter or agent runtime
 *   await stimulusRouter.ingestChannelMessage(message, binding.seedId);
 * });
 *
 * // Send outbound message
 * await router.sendMessage('cipher-001', 'telegram', '123456789', {
 *   blocks: [{ type: 'text', text: 'Hello from Cipher!' }],
 * });
 * ```
 */
export class ChannelRouter {
  /** Registered adapters keyed by platform. */
  private adapters: Map<string, IChannelAdapter> = new Map();

  /** Active bindings keyed by bindingId. */
  private bindings: Map<string, ChannelBindingConfig> = new Map();

  /** Active sessions keyed by sessionId. */
  private sessions: Map<string, ChannelSession> = new Map();

  /** Inbound message handlers. */
  private messageHandlers: Set<InboundMessageHandler> = new Set();

  /** Lookup index: `${platform}:${conversationId}` -> bindingId[]. */
  private bindingIndex: Map<string, string[]> = new Map();

  /** Unsubscribe functions for adapter event listeners. */
  private adapterUnsubs: Map<string, () => void> = new Map();

  // ── Adapter Management ──

  /**
   * Register a channel adapter. The router will subscribe to its events.
   */
  registerAdapter(adapter: IChannelAdapter, options?: RegisterAdapterOptions): void {
    const key = options?.platformKey ?? adapter.platform;

    if (this.adapters.has(key)) {
      // Tear down existing adapter for this platform
      this.unregisterAdapter(key);
    }

    this.adapters.set(key, adapter);

    // Subscribe to all events from this adapter
    const unsub = adapter.on(async (event) => {
      if (event.type === 'message') {
        await this.handleInboundMessage(event.data as ChannelMessage);
      }
    });
    this.adapterUnsubs.set(key, unsub);
  }

  /**
   * Unregister and shut down an adapter.
   */
  async unregisterAdapter(platformKey: string): Promise<void> {
    const unsub = this.adapterUnsubs.get(platformKey);
    if (unsub) {
      unsub();
      this.adapterUnsubs.delete(platformKey);
    }

    const adapter = this.adapters.get(platformKey);
    if (adapter) {
      await adapter.shutdown();
      this.adapters.delete(platformKey);
    }
  }

  /**
   * Get a registered adapter by platform.
   */
  getAdapter(platform: string): IChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  /**
   * List all registered adapters with their info.
   */
  listAdapters(): ChannelInfo[] {
    const result: ChannelInfo[] = [];
    for (const [_key, adapter] of this.adapters) {
      const conn = adapter.getConnectionInfo();
      result.push({
        platform: adapter.platform,
        displayName: adapter.displayName,
        description: `${adapter.displayName} channel adapter`,
        capabilities: [...adapter.capabilities],
        available: conn.status === 'connected',
        requiredSecrets: [], // Populated by extension descriptor
      });
    }
    return result;
  }

  // ── Binding Management ──

  /**
   * Add or update a channel binding.
   */
  addBinding(binding: ChannelBindingConfig): void {
    this.bindings.set(binding.bindingId, binding);
    this.rebuildBindingIndex();
  }

  /**
   * Remove a channel binding.
   */
  removeBinding(bindingId: string): void {
    this.bindings.delete(bindingId);
    this.rebuildBindingIndex();
  }

  /**
   * Get all bindings for a seed.
   */
  getBindingsForSeed(seedId: string): ChannelBindingConfig[] {
    return [...this.bindings.values()].filter((b) => b.seedId === seedId && b.isActive);
  }

  /**
   * Get all bindings for a platform + conversation.
   */
  getBindingsForConversation(platform: ChannelPlatform, conversationId: string): ChannelBindingConfig[] {
    const key = `${platform}:${conversationId}`;
    const bindingIds = this.bindingIndex.get(key) || [];
    return bindingIds
      .map((id) => this.bindings.get(id))
      .filter((b): b is ChannelBindingConfig => b !== undefined && b.isActive);
  }

  /**
   * Get all auto-broadcast bindings for a seed (used when agent publishes a post).
   */
  getBroadcastBindings(seedId: string): ChannelBindingConfig[] {
    return [...this.bindings.values()].filter(
      (b) => b.seedId === seedId && b.isActive && b.autoBroadcast,
    );
  }

  // ── Message Handling ──

  /**
   * Register a handler for inbound messages. Returns unsubscribe function.
   */
  onMessage(handler: InboundMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Send a message from an agent to a specific conversation.
   */
  async sendMessage(
    seedId: string,
    platform: ChannelPlatform,
    conversationId: string,
    content: MessageContent,
  ): Promise<ChannelSendResult> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for platform '${platform}'`);
    }

    const result = await adapter.sendMessage(conversationId, content);

    // Update session metrics
    this.touchSession(seedId, platform, conversationId);

    return result;
  }

  /**
   * Broadcast a message from an agent to all auto-broadcast bindings.
   */
  async broadcast(seedId: string, content: MessageContent): Promise<ChannelSendResult[]> {
    const bindings = this.getBroadcastBindings(seedId);
    const results: ChannelSendResult[] = [];

    for (const binding of bindings) {
      try {
        const result = await this.sendMessage(
          seedId,
          binding.platform,
          binding.channelId,
          content,
        );
        results.push(result);
      } catch (err) {
        console.error(
          `[ChannelRouter] Broadcast to ${binding.platform}:${binding.channelId} failed:`,
          err,
        );
      }
    }

    return results;
  }

  /**
   * Send a typing indicator for an agent on a channel.
   */
  async sendTypingIndicator(
    platform: ChannelPlatform,
    conversationId: string,
    isTyping: boolean,
  ): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (adapter) {
      await adapter.sendTypingIndicator(conversationId, isTyping);
    }
  }

  // ── Session Management ──

  /**
   * Get or create a session for an agent + conversation.
   */
  getOrCreateSession(
    seedId: string,
    platform: ChannelPlatform,
    conversationId: string,
  ): ChannelSession {
    const sessionKey = `${seedId}:${platform}:${conversationId}`;
    let session = this.sessions.get(sessionKey);

    if (!session) {
      session = {
        sessionId: sessionKey,
        seedId,
        platform,
        conversationId,
        conversationType: 'direct',
        lastMessageAt: new Date().toISOString(),
        messageCount: 0,
        isActive: true,
      };
      this.sessions.set(sessionKey, session);
    }

    return session;
  }

  /**
   * Get active sessions for a seed.
   */
  getSessionsForSeed(seedId: string): ChannelSession[] {
    return [...this.sessions.values()].filter((s) => s.seedId === seedId && s.isActive);
  }

  // ── Stats ──

  getStats(): {
    adapters: number;
    bindings: number;
    activeSessions: number;
    totalSessions: number;
  } {
    let activeSessions = 0;
    for (const s of this.sessions.values()) {
      if (s.isActive) activeSessions++;
    }
    return {
      adapters: this.adapters.size,
      bindings: this.bindings.size,
      activeSessions,
      totalSessions: this.sessions.size,
    };
  }

  /**
   * Shut down all adapters and clear state.
   */
  async shutdown(): Promise<void> {
    for (const key of [...this.adapters.keys()]) {
      await this.unregisterAdapter(key);
    }
    this.bindings.clear();
    this.sessions.clear();
    this.bindingIndex.clear();
    this.messageHandlers.clear();
  }

  /**
   * @internal Route one inbound message through binding resolution + group
   * policy + handler dispatch. Adapter 'message' events flow through the same
   * path; exposed publicly for hosts and tests that inject messages directly.
   */
  public async routeInboundMessage(message: ChannelMessage): Promise<void> {
    return this.handleInboundMessage(message);
  }

  // ── Private ──

  private async handleInboundMessage(message: ChannelMessage): Promise<void> {
    const bindings = this.getBindingsForConversation(message.platform, message.conversationId);

    if (bindings.length === 0) {
      // No binding found — message is from an unbound conversation
      return;
    }

    // Dispatch to all matching bindings (usually 1, but multi-agent groups are possible)
    for (const binding of bindings) {
      // Group policy gate: drops are silent to the sender (unprobeable) and
      // skip session bookkeeping so dropped traffic leaves no footprint.
      const policyResult = evaluateGroupPolicy(binding.groupPolicy, {
        isGroup: message.conversationType !== 'direct',
        senderId: message.sender.id,
        senderIsBot: message.sender.isBot === true,
        mentions: message.mentions,
        supportsMentions: message.supportsMentions === true,
        botUserId: binding.platformConfig?.botUserId as string | undefined,
        bindingOwnerUserId: binding.ownerUserId,
      });
      if (policyResult.verdict === 'drop') {
        // Audit at info level WITHOUT raw sender / conversation identifiers:
        // mention-gated groups drop most traffic, so this fires often and must
        // not become a high-volume PII sink. bindingId locates the group config;
        // per-sender detail belongs behind a debug/redacted channel.
        console.info(
          `[ChannelRouter] group-policy drop reason=${policyResult.reason} platform=${message.platform} binding=${binding.bindingId}`,
        );
        continue;
      }

      const session = this.getOrCreateSession(
        binding.seedId,
        message.platform,
        message.conversationId,
      );
      session.lastMessageAt = message.timestamp;
      session.messageCount++;
      session.conversationType = message.conversationType;
      if (message.sender) {
        session.remoteUser = message.sender;
      }

      // Dispatch to all registered handlers
      const handlerPromises = [...this.messageHandlers].map(async (handler) => {
        try {
          await Promise.resolve(handler(message, binding, session));
        } catch (err) {
          console.error(
            `[ChannelRouter] Handler error for ${message.platform}:${message.conversationId}:`,
            err,
          );
        }
      });

      await Promise.allSettled(handlerPromises);
    }
  }

  private touchSession(
    seedId: string,
    platform: ChannelPlatform,
    conversationId: string,
  ): void {
    const session = this.getOrCreateSession(seedId, platform, conversationId);
    session.lastMessageAt = new Date().toISOString();
    session.messageCount++;
  }

  private rebuildBindingIndex(): void {
    this.bindingIndex.clear();
    for (const [id, binding] of this.bindings) {
      if (!binding.isActive) continue;
      const key = `${binding.platform}:${binding.channelId}`;
      const existing = this.bindingIndex.get(key) || [];
      existing.push(id);
      this.bindingIndex.set(key, existing);
    }
  }
}
