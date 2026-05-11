/**
 * @file AgentCommunicationBus.ts
 * @description Implementation of the AgentOS Agent Communication Bus.
 * Provides structured messaging between agents within agencies.
 *
 * @module AgentOS/Agency
 * @version 1.0.0
 */

import type { ILogger } from '../../logging/ILogger';
import { uuidv4 } from '../../core/utils/uuid';
import type {
  IAgentCommunicationBus,
  AgentMessage,
  AgentMessageType,
  AgentRequest,
  AgentResponse,
  HandoffContext,
  HandoffResult,
  MessageHandler,
  Unsubscribe,
  SubscriptionOptions,
  MessageTopic,
  DeliveryStatus,
  RoutingConfig,
  BusStatistics,
  MessagePriority,
} from './IAgentCommunicationBus';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for AgentCommunicationBus.
 */
export interface AgentCommunicationBusConfig {
  /** Logger instance */
  logger?: ILogger;
  /** Routing configuration */
  routingConfig?: Partial<RoutingConfig>;
  /** Maximum messages to keep in history per agent */
  maxHistoryPerAgent?: number;
}

/**
 * Internal subscription record.
 */
interface Subscription {
  id: string;
  agentId: string;
  handler: MessageHandler;
  options: SubscriptionOptions;
}

/**
 * Internal topic subscription.
 */
interface TopicSubscription {
  agentId: string;
  handler: MessageHandler;
}

/**
 * Pending request awaiting response.
 */
interface PendingRequest {
  requestId: string;
  targetAgentId: string;
  resolve: (response: AgentResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ============================================================================
// AgentCommunicationBus Implementation
// ============================================================================

/**
 * Implementation of the Agent Communication Bus.
 *
 * Features:
 * - Point-to-point messaging between agents
 * - Broadcast to agencies
 * - Request-response pattern
 * - Topic-based pub/sub
 * - Task handoff protocol
 * - Message persistence and history
 * - Delivery tracking and retries
 *
 * @implements {IAgentCommunicationBus}
 */
export class AgentCommunicationBus implements IAgentCommunicationBus {
  private readonly logger?: ILogger;
  private readonly routingConfig: RoutingConfig;
  private readonly maxHistoryPerAgent: number;

  /** Agent subscriptions */
  private readonly subscriptions = new Map<string, Subscription[]>();

  /** Topic definitions */
  private readonly topics = new Map<string, MessageTopic>();

  /** Topic subscriptions */
  private readonly topicSubscriptions = new Map<string, TopicSubscription[]>();

  /** Message history per agent */
  private readonly messageHistory = new Map<string, AgentMessage[]>();

  /** Delivery statuses */
  private readonly deliveryStatuses = new Map<string, DeliveryStatus>();

  /** Pending request-response calls */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /** Agent to agency mapping for routing */
  private readonly agentToAgency = new Map<string, string>();

  /** Agency role mappings */
  private readonly agencyRoles = new Map<string, Map<string, string[]>>(); // agencyId -> roleId -> agentIds

  /** Statistics */
  private stats: BusStatistics = {
    totalMessagesSent: 0,
    totalMessagesDelivered: 0,
    totalMessagesFailed: 0,
    messagesByType: {} as Record<AgentMessageType, number>,
    activeSubscriptions: 0,
    avgDeliveryTimeMs: 0,
    queueDepth: 0,
  };

  /**
   * Creates a new AgentCommunicationBus instance.
   *
   * @param config - Bus configuration
   */
  constructor(config: AgentCommunicationBusConfig = {}) {
    this.logger = config.logger;
    this.maxHistoryPerAgent = config.maxHistoryPerAgent ?? 100;
    this.routingConfig = {
      enableRoleRouting: true,
      enableLoadBalancing: true,
      defaultTtlMs: 60000,
      maxRetries: 3,
      retryDelayMs: 1000,
      ...config.routingConfig,
    };

    this.logger?.info?.('AgentCommunicationBus initialized');
  }

  // ==========================================================================
  // Point-to-Point Messaging
  // ==========================================================================

  /**
   * Sends a message to a specific agent.
   */
  public async sendToAgent(
    targetAgentId: string,
    message: Omit<AgentMessage, 'messageId' | 'toAgentId' | 'sentAt'>,
  ): Promise<DeliveryStatus> {
    const fullMessage: AgentMessage = {
      ...message,
      messageId: `msg-${uuidv4()}`,
      toAgentId: targetAgentId,
      sentAt: new Date(),
      priority: message.priority ?? 'normal',
    };

    return this.deliverMessage(fullMessage);
  }

  /**
   * Sends a message to an agent by role.
   */
  public async sendToRole(
    agencyId: string,
    targetRoleId: string,
    message: Omit<AgentMessage, 'messageId' | 'toRoleId' | 'sentAt'>,
  ): Promise<DeliveryStatus> {
    const agencyRoleMap = this.agencyRoles.get(agencyId);
    const agentIds = agencyRoleMap?.get(targetRoleId) ?? [];

    if (agentIds.length === 0) {
      return this.createFailedDelivery(`msg-${uuidv4()}`, '', 'No agents with role ' + targetRoleId);
    }

    // Load balance if multiple agents
    const targetAgentId = this.routingConfig.enableLoadBalancing
      ? agentIds[Math.floor(Math.random() * agentIds.length)]
      : agentIds[0];

    const fullMessage: AgentMessage = {
      ...message,
      messageId: `msg-${uuidv4()}`,
      toAgentId: targetAgentId,
      toRoleId: targetRoleId,
      agencyId,
      sentAt: new Date(),
      priority: message.priority ?? 'normal',
    };

    return this.deliverMessage(fullMessage);
  }

  // ==========================================================================
  // Broadcast
  // ==========================================================================

  /**
   * Broadcasts a message to all agents in an agency.
   */
  public async broadcast(
    agencyId: string,
    message: Omit<AgentMessage, 'messageId' | 'toAgentId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]> {
    const agentIds = this.getAgentsInAgency(agencyId);
    const statuses: DeliveryStatus[] = [];

    for (const agentId of agentIds) {
      if (agentId !== message.fromAgentId) {
        const status = await this.sendToAgent(agentId, {
          ...message,
          type: 'broadcast',
          agencyId,
        });
        statuses.push(status);
      }
    }

    this.logger?.debug?.('Broadcast sent', { agencyId, recipients: statuses.length });
    return statuses;
  }

  /**
   * Broadcasts to specific roles within an agency.
   */
  public async broadcastToRoles(
    agencyId: string,
    roleIds: string[],
    message: Omit<AgentMessage, 'messageId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]> {
    const statuses: DeliveryStatus[] = [];
    const agencyRoleMap = this.agencyRoles.get(agencyId);

    if (!agencyRoleMap) {
      return statuses;
    }

    for (const roleId of roleIds) {
      const agentIds = agencyRoleMap.get(roleId) ?? [];
      for (const agentId of agentIds) {
        if (agentId !== message.fromAgentId) {
          const status = await this.sendToAgent(agentId, {
            ...message,
            toRoleId: roleId,
            agencyId,
          });
          statuses.push(status);
        }
      }
    }

    return statuses;
  }

  // ==========================================================================
  // Request-Response
  // ==========================================================================

  /**
   * Sends a request and waits for a response.
   */
  public async requestResponse(
    targetAgentId: string,
    request: AgentRequest,
  ): Promise<AgentResponse> {
    const timeoutMs = request.timeoutMs ?? 30000;
    const messageId = `req-${uuidv4()}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        resolve({
          responseId: `res-${uuidv4()}`,
          requestId: messageId,
          fromAgentId: targetAgentId,
          status: 'timeout',
          content: null,
          error: 'Request timed out',
          respondedAt: new Date(),
        });
      }, timeoutMs);

      this.pendingRequests.set(messageId, {
        requestId: messageId,
        targetAgentId,
        resolve,
        reject,
        timeoutId,
      });

      const fullMessage: AgentMessage = {
        ...request,
        messageId,
        toAgentId: targetAgentId,
        sentAt: new Date(),
        priority: request.priority ?? 'normal',
      };

      this.deliverMessage(fullMessage)
        .then((status) => {
          if (status.status === 'failed' || status.status === 'expired') {
            clearTimeout(timeoutId);
            this.pendingRequests.delete(messageId);
            resolve({
              responseId: `res-${uuidv4()}`,
              requestId: messageId,
              fromAgentId: targetAgentId,
              status: 'error',
              content: null,
              error: status.failureReason ?? 'Request delivery failed',
              respondedAt: new Date(),
            });
          }
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(messageId);
          reject(error);
        });
    });
  }

  // ==========================================================================
  // Handoff
  // ==========================================================================

  /**
   * Initiates a structured handoff between agents.
   */
  public async handoff(
    fromAgentId: string,
    toAgentId: string,
    context: HandoffContext,
  ): Promise<HandoffResult> {
    this.logger?.info?.('Initiating handoff', {
      from: fromAgentId,
      to: toAgentId,
      task: context.taskId,
    });

    // Send handoff request - convert context to Record for type compatibility
    const response = await this.requestResponse(toAgentId, {
      type: 'task_delegation',
      fromAgentId,
      content: context as unknown as Record<string, unknown>,
      priority: 'high',
      timeoutMs: 60000,
    });

    if (response.status === 'success') {
      // Notify completion
      await this.sendToAgent(fromAgentId, {
        type: 'acknowledgment',
        fromAgentId: toAgentId,
        content: { handoffAccepted: true, taskId: context.taskId },
        priority: 'normal',
      });

      return {
        accepted: true,
        newOwnerId: toAgentId,
        acknowledgment: 'Handoff accepted',
        handoffAt: new Date(),
      };
    }

    return {
      accepted: false,
      rejectionReason: response.error ?? 'Unknown rejection',
      handoffAt: new Date(),
    };
  }

  // ==========================================================================
  // Subscription
  // ==========================================================================

  /**
   * Subscribes an agent to receive messages.
   */
  public subscribe(
    agentId: string,
    handler: MessageHandler,
    options: SubscriptionOptions = {},
  ): Unsubscribe {
    const subscription: Subscription = {
      id: `sub-${uuidv4()}`,
      agentId,
      handler,
      options,
    };

    const agentSubs = this.subscriptions.get(agentId) ?? [];
    agentSubs.push(subscription);
    this.subscriptions.set(agentId, agentSubs);
    this.stats.activeSubscriptions++;

    this.logger?.debug?.('Agent subscribed', { agentId, subscriptionId: subscription.id });

    return () => {
      const subs = this.subscriptions.get(agentId);
      if (subs) {
        const idx = subs.findIndex((s) => s.id === subscription.id);
        if (idx >= 0) {
          subs.splice(idx, 1);
          this.stats.activeSubscriptions--;
        }
      }
    };
  }

  /**
   * Unsubscribes an agent from all messages.
   */
  public unsubscribeAll(agentId: string): void {
    const subs = this.subscriptions.get(agentId);
    if (subs) {
      this.stats.activeSubscriptions -= subs.length;
      this.subscriptions.delete(agentId);
    }
    this.logger?.debug?.('Agent unsubscribed from all', { agentId });
  }

  // ==========================================================================
  // Topic-Based Pub/Sub
  // ==========================================================================

  /**
   * Creates a message topic.
   */
  public async createTopic(topic: Omit<MessageTopic, 'topicId'>): Promise<MessageTopic> {
    const fullTopic: MessageTopic = {
      ...topic,
      topicId: `topic-${uuidv4()}`,
    };

    this.topics.set(fullTopic.topicId, fullTopic);
    this.topicSubscriptions.set(fullTopic.topicId, []);

    this.logger?.info?.('Topic created', { topicId: fullTopic.topicId, name: fullTopic.name });
    return fullTopic;
  }

  /**
   * Publishes a message to a topic.
   */
  public async publishToTopic(
    topicId: string,
    message: Omit<AgentMessage, 'messageId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]> {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error(`Topic ${topicId} not found`);
    }

    const subscribers = this.topicSubscriptions.get(topicId) ?? [];
    const statuses: DeliveryStatus[] = [];

    const fullMessage: AgentMessage = {
      ...message,
      messageId: `msg-${uuidv4()}`,
      sentAt: new Date(),
      priority: message.priority ?? 'normal',
      metadata: { ...message.metadata, topicId },
    };

    for (const sub of subscribers) {
      try {
        await sub.handler(fullMessage);
        statuses.push(this.createDeliveredStatus(fullMessage.messageId, sub.agentId));
      } catch (error) {
        statuses.push(
          this.createFailedDelivery(
            fullMessage.messageId,
            sub.agentId,
            error instanceof Error ? error.message : 'Handler error',
          ),
        );
      }
    }

    return statuses;
  }

  /**
   * Subscribes an agent to a topic.
   */
  public subscribeToTopic(
    agentId: string,
    topicId: string,
    handler: MessageHandler,
  ): Unsubscribe {
    const subs = this.topicSubscriptions.get(topicId);
    if (!subs) {
      throw new Error(`Topic ${topicId} not found`);
    }

    const subscription: TopicSubscription = { agentId, handler };
    subs.push(subscription);

    return () => {
      const idx = subs.findIndex((s) => s.agentId === agentId);
      if (idx >= 0) {
        subs.splice(idx, 1);
      }
    };
  }

  // ==========================================================================
  // Delivery Management
  // ==========================================================================

  /**
   * Gets the delivery status of a message.
   */
  public async getDeliveryStatus(messageId: string): Promise<DeliveryStatus | null> {
    return this.deliveryStatuses.get(messageId) ?? null;
  }

  /**
   * Acknowledges receipt of a message.
   */
  public async acknowledgeMessage(messageId: string, agentId: string): Promise<void> {
    const status = this.deliveryStatuses.get(messageId);
    if (status && status.targetAgentId === agentId) {
      status.status = 'acknowledged';
      status.acknowledgedAt = new Date();

      // Handle request-response acknowledgment
      const pending = this.pendingRequests.get(messageId);
      if (pending) {
        // This is handled by the agent sending an answer message
      }
    }
  }

  /**
   * Retries delivery of a failed message.
   */
  public async retryDelivery(messageId: string): Promise<DeliveryStatus> {
    const status = this.deliveryStatuses.get(messageId);
    if (!status || status.status !== 'failed') {
      throw new Error(`Cannot retry message ${messageId}`);
    }

    if (status.retryCount >= this.routingConfig.maxRetries) {
      throw new Error(`Max retries exceeded for message ${messageId}`);
    }

    // Re-deliver from history
    const history = this.messageHistory.get(status.targetAgentId);
    const message = history?.find((m) => m.messageId === messageId);

    if (!message) {
      throw new Error(`Message ${messageId} not found in history`);
    }

    status.retryCount++;
    return this.deliverMessage(message);
  }

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Gets message bus statistics.
   */
  public getStatistics(): BusStatistics {
    return { ...this.stats };
  }

  /**
   * Gets message history for an agent.
   */
  public async getMessageHistory(
    agentId: string,
    options?: {
      limit?: number;
      since?: Date;
      types?: AgentMessageType[];
      direction?: 'sent' | 'received' | 'both';
    },
  ): Promise<AgentMessage[]> {
    const history = this.messageHistory.get(agentId) ?? [];
    let filtered = history;

    if (options?.since) {
      filtered = filtered.filter((m) => m.sentAt >= options.since!);
    }

    if (options?.types) {
      filtered = filtered.filter((m) => options.types!.includes(m.type));
    }

    if (options?.direction === 'sent') {
      filtered = filtered.filter((m) => m.fromAgentId === agentId);
    } else if (options?.direction === 'received') {
      filtered = filtered.filter((m) => m.toAgentId === agentId);
    }

    if (options?.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  // ==========================================================================
  // Agency Management (for routing)
  // ==========================================================================

  /**
   * Registers an agent with an agency for routing.
   */
  public registerAgent(agentId: string, agencyId: string, roleId: string): void {
    this.agentToAgency.set(agentId, agencyId);

    let agencyRoleMap = this.agencyRoles.get(agencyId);
    if (!agencyRoleMap) {
      agencyRoleMap = new Map();
      this.agencyRoles.set(agencyId, agencyRoleMap);
    }

    const agents = agencyRoleMap.get(roleId) ?? [];
    if (!agents.includes(agentId)) {
      agents.push(agentId);
    }
    agencyRoleMap.set(roleId, agents);

    this.logger?.debug?.('Agent registered', { agentId, agencyId, roleId });
  }

  /**
   * Unregisters an agent from routing.
   */
  public unregisterAgent(agentId: string): void {
    const agencyId = this.agentToAgency.get(agentId);
    if (agencyId) {
      const agencyRoleMap = this.agencyRoles.get(agencyId);
      if (agencyRoleMap) {
        for (const [_roleId, agents] of agencyRoleMap.entries()) {
          const idx = agents.indexOf(agentId);
          if (idx >= 0) {
            agents.splice(idx, 1);
          }
        }
      }
    }
    this.agentToAgency.delete(agentId);
    this.unsubscribeAll(agentId);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async deliverMessage(message: AgentMessage): Promise<DeliveryStatus> {
    const startTime = Date.now();
    const targetAgentId = message.toAgentId!;

    // Update stats
    this.stats.totalMessagesSent++;
    this.stats.messagesByType[message.type] = (this.stats.messagesByType[message.type] ?? 0) + 1;

    // Store in history
    this.addToHistory(targetAgentId, message);
    this.addToHistory(message.fromAgentId, message);

    const resolvedPendingRequest = this.resolvePendingRequest(message);

    // Find subscriptions for target agent
    const subs = this.subscriptions.get(targetAgentId) ?? [];
    const matchingSubs = subs.filter((sub) => this.matchesSubscription(message, sub.options));

    if (matchingSubs.length === 0) {
      if (resolvedPendingRequest) {
        this.stats.totalMessagesDelivered++;
        const status = this.createDeliveredStatus(message.messageId, targetAgentId);
        this.deliveryStatuses.set(message.messageId, status);
        return status;
      }

      this.logger?.warn?.('No subscribers for message', { messageId: message.messageId, target: targetAgentId });
      return this.createFailedDelivery(message.messageId, targetAgentId, 'No subscribers');
    }

    // Deliver to all matching subscriptions
    let delivered = false;
    for (const sub of matchingSubs) {
      try {
        await sub.handler(message);
        delivered = true;
      } catch (error) {
        this.logger?.error?.('Handler error', {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const deliveryTime = Date.now() - startTime;
    this.updateAvgDeliveryTime(deliveryTime);

    if (delivered || resolvedPendingRequest) {
      this.stats.totalMessagesDelivered++;
      const status = this.createDeliveredStatus(message.messageId, targetAgentId);
      this.deliveryStatuses.set(message.messageId, status);
      return status;
    }

    this.stats.totalMessagesFailed++;
    return this.createFailedDelivery(message.messageId, targetAgentId, 'Delivery failed');
  }

  private resolvePendingRequest(message: AgentMessage): boolean {
    if (!message.inReplyTo) {
      return false;
    }

    if (message.type !== 'answer' && message.type !== 'error') {
      return false;
    }

    const pending = this.pendingRequests.get(message.inReplyTo);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(message.inReplyTo);

    let error: string | undefined;
    if (message.type === 'error') {
      error = typeof message.content === 'string'
        ? message.content
        : (message.content as Record<string, unknown>)?.error as string | undefined;
    }

    pending.resolve({
      responseId: `res-${uuidv4()}`,
      requestId: message.inReplyTo,
      fromAgentId: message.fromAgentId,
      status: message.type === 'answer' ? 'success' : 'error',
      content: message.content,
      error,
      respondedAt: new Date(),
    });

    return true;
  }

  private matchesSubscription(message: AgentMessage, options: SubscriptionOptions): boolean {
    if (options.messageTypes && !options.messageTypes.includes(message.type)) {
      return false;
    }
    if (options.fromRoles && message.fromRoleId && !options.fromRoles.includes(message.fromRoleId)) {
      return false;
    }
    if (options.minPriority && !this.meetsMinPriority(message.priority, options.minPriority)) {
      return false;
    }
    if (options.threadId && message.threadId !== options.threadId) {
      return false;
    }
    return true;
  }

  private meetsMinPriority(actual: MessagePriority, minimum: MessagePriority): boolean {
    const priorities: MessagePriority[] = ['low', 'normal', 'high', 'urgent'];
    return priorities.indexOf(actual) >= priorities.indexOf(minimum);
  }

  private addToHistory(agentId: string, message: AgentMessage): void {
    const history = this.messageHistory.get(agentId) ?? [];
    history.push(message);
    if (history.length > this.maxHistoryPerAgent) {
      history.shift();
    }
    this.messageHistory.set(agentId, history);
  }

  private getAgentsInAgency(agencyId: string): string[] {
    const agents: string[] = [];
    for (const [agentId, agency] of this.agentToAgency.entries()) {
      if (agency === agencyId) {
        agents.push(agentId);
      }
    }
    return agents;
  }

  private createDeliveredStatus(messageId: string, targetAgentId: string): DeliveryStatus {
    return {
      messageId,
      targetAgentId,
      status: 'delivered',
      deliveredAt: new Date(),
      retryCount: 0,
    };
  }

  private createFailedDelivery(
    messageId: string,
    targetAgentId: string,
    reason: string,
  ): DeliveryStatus {
    const status: DeliveryStatus = {
      messageId,
      targetAgentId,
      status: 'failed',
      failureReason: reason,
      retryCount: 0,
    };
    this.deliveryStatuses.set(messageId, status);
    return status;
  }

  private updateAvgDeliveryTime(newTime: number): void {
    // totalMessagesDelivered is incremented AFTER this method runs (see
    // deliverMessage), so `previousTotal` is the count of deliveries
    // already folded into the running average. Old formula treated
    // `total` as the current count and produced wrong averages from the
    // second delivery onward.
    const previousTotal = this.stats.totalMessagesDelivered;
    if (previousTotal === 0) {
      this.stats.avgDeliveryTimeMs = newTime;
    } else {
      this.stats.avgDeliveryTimeMs =
        (this.stats.avgDeliveryTimeMs * previousTotal + newTime) / (previousTotal + 1);
    }
  }
}
