/**
 * @file IAgentCommunicationBus.ts
 * @description Interface for inter-agent communication within AgentOS agencies.
 * Enables GMIs to send messages, broadcast to agencies, and coordinate tasks.
 *
 * Supports multiple communication patterns:
 * - Point-to-point messaging
 * - Broadcast to agency
 * - Request-response
 * - Task delegation and handoff
 * - Pub/sub for topics
 *
 * @module AgentOS/Agency
 * @version 1.0.0
 *
 * @example
 * ```typescript
 * const bus = new AgentCommunicationBus(logger);
 *
 * // Subscribe to messages
 * const unsubscribe = bus.subscribe('agent-1', (message) => {
 *   console.log('Received:', message);
 * });
 *
 * // Send a message
 * await bus.sendToAgent('agent-2', {
 *   type: 'task_delegation',
 *   content: 'Please analyze this data',
 *   metadata: { priority: 'high' },
 * });
 *
 * // Request-response
 * const response = await bus.requestResponse('agent-3', {
 *   type: 'question',
 *   content: 'What is your analysis?',
 * });
 * ```
 */

// ILogger import removed - not currently used in this interface file

// ============================================================================
// Message Types
// ============================================================================

/**
 * Types of messages that can be sent between agents.
 */
export type AgentMessageType =
  | 'task_delegation'    // Delegate a task to another agent
  | 'status_update'      // Update on task progress
  | 'question'           // Ask another agent a question
  | 'answer'             // Response to a question
  | 'finding'            // Share a discovery or insight
  | 'decision'           // Announce a decision
  | 'critique'           // Provide feedback on another agent's work
  | 'handoff'            // Transfer responsibility to another agent
  | 'acknowledgment'     // Acknowledge receipt of a message
  | 'error'              // Report an error
  | 'broadcast'          // General broadcast to all agents
  | 'heartbeat';         // Keep-alive signal

/**
 * Priority levels for messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * A message sent between agents.
 */
export interface AgentMessage {
  /** Unique message identifier */
  messageId: string;
  /** Type of message */
  type: AgentMessageType;
  /** Sender agent ID */
  fromAgentId: string;
  /** Sender's role in the agency */
  fromRoleId?: string;
  /** Target agent ID (null for broadcasts) */
  toAgentId?: string;
  /** Target role (for role-based routing) */
  toRoleId?: string;
  /** Agency context */
  agencyId?: string;
  /** Message content */
  content: string | Record<string, unknown>;
  /** Message priority */
  priority: MessagePriority;
  /** Timestamp when sent */
  sentAt: Date;
  /** Expiration time for time-sensitive messages */
  expiresAt?: Date;
  /** If this is a reply, the original message ID */
  inReplyTo?: string;
  /** Thread/conversation ID for related messages */
  threadId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Whether delivery confirmation is required */
  requiresAck?: boolean;
}

/**
 * A request expecting a response.
 */
export interface AgentRequest extends Omit<AgentMessage, 'type' | 'messageId' | 'toAgentId' | 'sentAt'> {
  /** Request type (subset of message types) */
  type: 'question' | 'task_delegation' | 'critique';
  /** Timeout for response in ms */
  timeoutMs?: number;
}

/**
 * Response to an agent request.
 */
export interface AgentResponse {
  /** Response identifier */
  responseId: string;
  /** Original request ID */
  requestId: string;
  /** Responding agent ID */
  fromAgentId: string;
  /** Response status */
  status: 'success' | 'error' | 'timeout' | 'rejected';
  /** Response content */
  content: unknown;
  /** Error details if status is 'error' */
  error?: string;
  /** Timestamp */
  respondedAt: Date;
}

// ============================================================================
// Handoff Types
// ============================================================================

/**
 * Context for task handoff between agents.
 */
export interface HandoffContext {
  /** Task being handed off */
  taskId: string;
  /** Task description */
  taskDescription: string;
  /** Current progress (0-1) */
  progress: number;
  /** Work completed so far */
  completedWork: string[];
  /** Remaining work items */
  remainingWork: string[];
  /** Relevant context/data */
  context: Record<string, unknown>;
  /** Reason for handoff */
  reason: 'completion' | 'escalation' | 'specialization' | 'capacity' | 'timeout';
  /** Instructions for receiving agent */
  instructions?: string;
  /** Deadline if any */
  deadline?: Date;
}

/**
 * Result of a handoff operation.
 */
export interface HandoffResult {
  /** Whether handoff was accepted */
  accepted: boolean;
  /** New owner agent ID */
  newOwnerId?: string;
  /** New owner role */
  newOwnerRoleId?: string;
  /** Rejection reason if not accepted */
  rejectionReason?: string;
  /** Acknowledgment message */
  acknowledgment?: string;
  /** Timestamp */
  handoffAt: Date;
}

// ============================================================================
// Subscription Types
// ============================================================================

/**
 * Handler function for incoming messages.
 */
export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

/**
 * Function to unsubscribe from messages.
 */
export type Unsubscribe = () => void;

/**
 * Subscription options.
 */
export interface SubscriptionOptions {
  /** Filter by message types */
  messageTypes?: AgentMessageType[];
  /** Filter by sender role */
  fromRoles?: string[];
  /** Filter by priority */
  minPriority?: MessagePriority;
  /** Only messages in specific thread */
  threadId?: string;
}

// ============================================================================
// Topic-Based Pub/Sub
// ============================================================================

/**
 * A topic for publish/subscribe messaging.
 */
export interface MessageTopic {
  /** Topic identifier */
  topicId: string;
  /** Topic name */
  name: string;
  /** Topic description */
  description?: string;
  /** Agency scope (null for global) */
  agencyId?: string;
  /** Allowed publisher roles */
  publisherRoles?: string[];
  /** Allowed subscriber roles */
  subscriberRoles?: string[];
}

// ============================================================================
// Delivery & Routing
// ============================================================================

/**
 * Delivery status for a message.
 */
export interface DeliveryStatus {
  /** Message ID */
  messageId: string;
  /** Target agent */
  targetAgentId: string;
  /** Delivery status */
  status: 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'expired';
  /** Delivery timestamp */
  deliveredAt?: Date;
  /** Acknowledgment timestamp */
  acknowledgedAt?: Date;
  /** Failure reason */
  failureReason?: string;
  /** Retries made through `retryDelivery()`; the status a re-send stores keeps the count. */
  retryCount: number;
}

/**
 * Message routing configuration.
 */
export interface RoutingConfig {
  /** Enable role-based routing */
  enableRoleRouting: boolean;
  /** Enable load balancing across agents with same role */
  enableLoadBalancing: boolean;
  /** Default message TTL in ms */
  defaultTtlMs: number;
  /** Maximum retries for failed delivery */
  maxRetries: number;
  /** Retry delay in ms */
  retryDelayMs: number;
}

// ============================================================================
// Bus Statistics
// ============================================================================

/**
 * Statistics about message bus activity.
 */
export interface BusStatistics {
  /** Total messages sent */
  totalMessagesSent: number;
  /** Total messages delivered */
  totalMessagesDelivered: number;
  /** Total messages failed */
  totalMessagesFailed: number;
  /** Messages by type */
  messagesByType: Record<AgentMessageType, number>;
  /** Active subscriptions */
  activeSubscriptions: number;
  /** Average delivery time in ms */
  avgDeliveryTimeMs: number;
  /** Messages in queue */
  queueDepth: number;
}

// ============================================================================
// IAgentCommunicationBus Interface
// ============================================================================

/**
 * Interface for the AgentOS Agent Communication Bus.
 *
 * The Communication Bus enables structured messaging between agents
 * within an agency, supporting various communication patterns:
 *
 * - **Point-to-Point**: Direct messages between two agents
 * - **Broadcast**: Messages to all agents in an agency
 * - **Request-Response**: Synchronous-style communication
 * - **Pub/Sub**: Topic-based messaging
 * - **Handoff**: Structured task transfer between agents
 *
 * @example
 * ```typescript
 * // Initialize bus
 * const bus = new AgentCommunicationBus({ logger, routingConfig });
 *
 * // Agent subscribes to messages
 * bus.subscribe('analyst-gmi', async (msg) => {
 *   if (msg.type === 'task_delegation') {
 *     const result = await analyzeData(msg.content);
 *     await bus.sendToAgent(msg.fromAgentId, {
 *       type: 'answer',
 *       content: result,
 *       inReplyTo: msg.messageId,
 *     });
 *   }
 * });
 *
 * // Coordinator delegates task
 * await bus.sendToAgent('analyst-gmi', {
 *   type: 'task_delegation',
 *   content: { data: [...], instructions: 'Analyze trends' },
 *   priority: 'high',
 * });
 * ```
 */
export interface IAgentCommunicationBus {
  // ==========================================================================
  // Point-to-Point Messaging
  // ==========================================================================

  /**
   * Sends a message to a specific agent.
   *
   * @param targetAgentId - Target agent identifier
   * @param message - Message to send (without routing fields)
   * @returns Delivery status
   *
   * @example
   * ```typescript
   * await bus.sendToAgent('researcher-gmi', {
   *   type: 'question',
   *   content: 'What did you find about topic X?',
   *   priority: 'normal',
   * });
   * ```
   */
  sendToAgent(
    targetAgentId: string,
    message: Omit<AgentMessage, 'messageId' | 'toAgentId' | 'sentAt'>,
  ): Promise<DeliveryStatus>;

  /**
   * Sends a message to an agent by role.
   * If multiple agents have the role, uses load balancing.
   *
   * @param agencyId - Agency context
   * @param targetRoleId - Target role identifier
   * @param message - Message to send
   * @returns Delivery status
   */
  sendToRole(
    agencyId: string,
    targetRoleId: string,
    message: Omit<AgentMessage, 'messageId' | 'toRoleId' | 'sentAt'>,
  ): Promise<DeliveryStatus>;

  // ==========================================================================
  // Broadcast
  // ==========================================================================

  /**
   * Broadcasts a message to all agents in an agency.
   *
   * @param agencyId - Target agency
   * @param message - Message to broadcast
   * @returns Array of delivery statuses
   *
   * @example
   * ```typescript
   * await bus.broadcast('agency-123', {
   *   type: 'broadcast',
   *   content: 'Meeting in 5 minutes',
   *   priority: 'high',
   * });
   * ```
   */
  broadcast(
    agencyId: string,
    message: Omit<AgentMessage, 'messageId' | 'toAgentId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]>;

  /**
   * Broadcasts to specific roles within an agency.
   *
   * @param agencyId - Target agency
   * @param roleIds - Target roles
   * @param message - Message to broadcast
   * @returns Array of delivery statuses
   */
  broadcastToRoles(
    agencyId: string,
    roleIds: string[],
    message: Omit<AgentMessage, 'messageId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]>;

  // ==========================================================================
  // Request-Response
  // ==========================================================================

  /**
   * Sends a request and waits for a response.
   * Implements request-response pattern over async messaging.
   *
   * @param targetAgentId - Target agent
   * @param request - Request message
   * @returns Response from target agent
   *
   * @example
   * ```typescript
   * const response = await bus.requestResponse('expert-gmi', {
   *   type: 'question',
   *   content: 'What is the optimal approach?',
   *   fromAgentId: 'coordinator-gmi',
   *   timeoutMs: 30000,
   * });
   * if (response.status === 'success') {
   *   console.log('Answer:', response.content);
   * }
   * ```
   */
  requestResponse(targetAgentId: string, request: AgentRequest): Promise<AgentResponse>;

  // ==========================================================================
  // Handoff
  // ==========================================================================

  /**
   * Initiates a structured handoff between agents.
   * Used for transferring task ownership with full context.
   *
   * @param fromAgentId - Current owner
   * @param toAgentId - New owner
   * @param context - Handoff context
   * @returns Handoff result
   *
   * @example
   * ```typescript
   * const result = await bus.handoff('analyst-gmi', 'reviewer-gmi', {
   *   taskId: 'analysis-task-1',
   *   taskDescription: 'Data analysis for Q4 report',
   *   progress: 0.8,
   *   completedWork: ['Data collection', 'Initial analysis'],
   *   remainingWork: ['Final review', 'Report generation'],
   *   context: { findings: [...] },
   *   reason: 'completion',
   * });
   * ```
   */
  handoff(fromAgentId: string, toAgentId: string, context: HandoffContext): Promise<HandoffResult>;

  // ==========================================================================
  // Subscription
  // ==========================================================================

  /**
   * Subscribes an agent to receive messages.
   *
   * @param agentId - Agent to subscribe
   * @param handler - Message handler function
   * @param options - Subscription filter options
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsub = bus.subscribe('worker-gmi', async (msg) => {
   *   console.log('Received:', msg.type, msg.content);
   * }, {
   *   messageTypes: ['task_delegation', 'question'],
   *   minPriority: 'normal',
   * });
   *
   * // Later: unsub();
   * ```
   */
  subscribe(agentId: string, handler: MessageHandler, options?: SubscriptionOptions): Unsubscribe;

  /**
   * Unsubscribes an agent from all messages.
   *
   * @param agentId - Agent to unsubscribe
   */
  unsubscribeAll(agentId: string): void;

  // ==========================================================================
  // Topic-Based Pub/Sub
  // ==========================================================================

  /**
   * Creates a message topic.
   *
   * @param topic - Topic configuration
   * @returns Created topic
   */
  createTopic(topic: Omit<MessageTopic, 'topicId'>): Promise<MessageTopic>;

  /**
   * Publishes a message to a topic.
   *
   * @param topicId - Topic identifier
   * @param message - Message to publish
   * @returns Delivery statuses for all subscribers
   */
  publishToTopic(
    topicId: string,
    message: Omit<AgentMessage, 'messageId' | 'sentAt'>,
  ): Promise<DeliveryStatus[]>;

  /**
   * Subscribes an agent to a topic.
   *
   * @param agentId - Agent to subscribe
   * @param topicId - Topic identifier
   * @param handler - Message handler
   * @returns Unsubscribe function
   */
  subscribeToTopic(agentId: string, topicId: string, handler: MessageHandler): Unsubscribe;

  // ==========================================================================
  // Delivery Management
  // ==========================================================================

  /**
   * Gets the delivery status of a message.
   *
   * @param messageId - Message identifier
   * @returns Delivery status or null if not found
   */
  getDeliveryStatus(messageId: string): Promise<DeliveryStatus | null>;

  /**
   * Acknowledges receipt of a message.
   *
   * @param messageId - Message to acknowledge
   * @param agentId - Acknowledging agent
   */
  acknowledgeMessage(messageId: string, agentId: string): Promise<void>;

  /**
   * Retries delivery of a failed message.
   *
   * Each call counts one retry, which the returned status carries in
   * `retryCount`. Once `RoutingConfig.maxRetries` retries have been made, the
   * call throws without sending.
   *
   * @param messageId - Message to retry
   * @returns New delivery status
   */
  retryDelivery(messageId: string): Promise<DeliveryStatus>;

  // ==========================================================================
  // Statistics & Monitoring
  // ==========================================================================

  /**
   * Gets message bus statistics.
   *
   * @returns Current bus statistics
   */
  getStatistics(): BusStatistics;

  /**
   * Gets message history for an agent.
   *
   * @param agentId - Agent identifier
   * @param options - Query options
   * @returns Message history
   */
  getMessageHistory(
    agentId: string,
    options?: {
      limit?: number;
      since?: Date;
      types?: AgentMessageType[];
      direction?: 'sent' | 'received' | 'both';
    },
  ): Promise<AgentMessage[]>;
}


