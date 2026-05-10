---
description: "AgentCommunicationBus — structured messaging between AgentOS GMIs in a multi-agent agency. Point-to-point, broadcast, request/response, pub/sub, handoff, threading. Three layers: Message Router → Subscription Manager → Delivery Manager with retry, ACK, and audit."
keywords: [agent communication bus, multi-agent messaging, pub/sub agents, agent handoff, multi-agent collaboration, agent runtime messaging, agentos agency]
---

# AgentOS Agent Communication Bus

> **Live run**: side-by-side code + captured bus traffic (delegation + handoff between two GMIs) on the [agentos.sh demo gallery](https://agentos.sh/#live-demo). Source: [`examples/agent-communication-bus.mjs`](https://github.com/framersai/agentos/blob/master/examples/agent-communication-bus.mjs).

The `AgentCommunicationBus` is the inter-agent messaging primitive for AgentOS agencies. Agents in the same agency share a memory layer, a runtime, and a tool catalog, but cross-agent task transfer, query/response, and topic-based publishing require explicit routing. The bus provides routing rules, subscription filters, retry-on-failure semantics, and a replayable message history. It supports six message patterns over three internal layers, exposed via one API.

| Pattern | Use it for |
| --- | --- |
| **Point-to-Point** | Direct message between two agents — *researcher → writer* with findings |
| **Broadcast** | One message to every agent in the agency — *"world state has changed"* |
| **Request-Response** | Synchronous-style query with a callback — *manager → specialist asking for a verdict* |
| **Pub/Sub** | Topic-based — every agent subscribed to `events.tool-result` gets the next one |
| **Handoff** | Structured task transfer with full context payload — moves ownership |
| **Threading** | Conversation tracking with `threadId` + `inReplyTo` — multi-turn exchanges |

## Architecture

![AgentCommunicationBus three-layer architecture: Message Router (point-to-point, role-based, topic router, load balancer) feeds Subscription Manager (agent subs, topic subs, filters) feeds Delivery Manager (queue manager, retry handler, ACK tracker, history store).](/img/diagrams/agent-communication-bus.svg)

## Implementation Details

### Routing Architecture

The bus uses a multi-layered routing system:

- **sendToAgent()**: Direct 1:1 routing by agent ID
- **sendToRole()**: Routes to agents by role (load-balanced if multiple)
- **broadcast()**: All agents in agency except sender
- **broadcastToRoles()**: Specific roles only

### Load Balancing

When multiple agents hold the same role, messages are distributed via **random selection**:

```typescript
const agentIds = agencyRoleMap?.get(targetRoleId) ?? [];
const targetAgentId = this.routingConfig.enableLoadBalancing
  ? agentIds[Math.floor(Math.random() * agentIds.length)]  // Random selection
  : agentIds[0];                                             // First agent
```

### Delivery Guarantees

| Level | Supported | Notes |
|-------|-----------|-------|
| **At-most-once** | Yes | No persisted queue; handler exceptions logged but no retry |
| **At-least-once** | No | Handlers execute once per delivery attempt |
| **Exactly-once** | No | No transaction support |
| **Message persistence** | Limited | Circular buffer (100 msgs per agent) |

### Priority System

Four-tier priority: `low` < `normal` < `high` < `urgent`

- Used for subscription filtering (`minPriority` option)
- Messages delivered FIFO regardless of priority (no reordering)
- Default: `'normal'` if not specified

### Message Ordering

- **Per-agent FIFO**: Strict ordering per subscription
- **No global ordering**: Independent delivery per agent
- **Threading**: Optional `threadId` and `inReplyTo` fields for conversation tracking

### Error Handling

- Handler errors are caught and logged, other handlers still execute
- No subscribers: Returns `DeliveryStatus` with status `'failed'`
- Request-response timeout: Returns `AgentResponse` with status `'timeout'` (default 30s)

## Message Types

| Type | Description | Use Case |
|------|-------------|----------|
| `task_delegation` | Delegate a task to another agent | Work distribution |
| `status_update` | Update on task progress | Progress tracking |
| `question` | Ask another agent a question | Information gathering |
| `answer` | Response to a question | Q&A flow |
| `finding` | Share a discovery or insight | Knowledge sharing |
| `decision` | Announce a decision | Coordination |
| `critique` | Provide feedback on work | Quality assurance |
| `handoff` | Transfer responsibility | Task transitions |
| `broadcast` | General announcement | Team-wide updates |

## Usage

### Initialize the Bus

```typescript
import { AgentCommunicationBus } from '@framers/agentos';

const bus = new AgentCommunicationBus({
  logger,
  routingConfig: {
    enableRoleRouting: true,
    enableLoadBalancing: true,
    defaultTtlMs: 60000,
    maxRetries: 3,
  },
});
```

### Register Agents

```typescript
// Register agents with their agency and role
bus.registerAgent('analyst-gmi-1', 'agency-123', 'analyst');
bus.registerAgent('researcher-gmi-1', 'agency-123', 'researcher');
bus.registerAgent('coordinator-gmi-1', 'agency-123', 'coordinator');
```

### Subscribe to Messages

```typescript
// Agent subscribes to receive messages
const unsubscribe = bus.subscribe('analyst-gmi-1', async (message) => {
  console.log(`Received ${message.type} from ${message.fromAgentId}`);
  
  if (message.type === 'task_delegation') {
    // Process the delegated task
    const result = await processTask(message.content);
    
    // Send response
    await bus.sendToAgent(message.fromAgentId, {
      type: 'answer',
      fromAgentId: 'analyst-gmi-1',
      content: result,
      inReplyTo: message.messageId,
      priority: 'normal',
    });
  }
}, {
  messageTypes: ['task_delegation', 'question'],
  minPriority: 'normal',
});

// Later: unsubscribe()
```

### Point-to-Point Messaging

```typescript
// Send to specific agent
await bus.sendToAgent('researcher-gmi-1', {
  type: 'question',
  fromAgentId: 'coordinator-gmi-1',
  content: 'What findings do you have on topic X?',
  priority: 'high',
});

// Send by role (load-balanced if multiple agents)
await bus.sendToRole('agency-123', 'analyst', {
  type: 'task_delegation',
  fromAgentId: 'coordinator-gmi-1',
  content: { data: [...], instructions: 'Analyze trends' },
  priority: 'high',
});
```

### Broadcast

```typescript
// Broadcast to all agents in agency
await bus.broadcast('agency-123', {
  type: 'broadcast',
  fromAgentId: 'coordinator-gmi-1',
  content: 'New priority: Focus on Q4 data',
  priority: 'high',
});

// Broadcast to specific roles
await bus.broadcastToRoles('agency-123', ['analyst', 'researcher'], {
  type: 'status_update',
  fromAgentId: 'coordinator-gmi-1',
  content: 'Phase 1 complete, moving to Phase 2',
  priority: 'normal',
});
```

### Request-Response Pattern

```typescript
// Send request and wait for response
const response = await bus.requestResponse('expert-gmi-1', {
  type: 'question',
  fromAgentId: 'coordinator-gmi-1',
  content: 'What is the optimal approach for this problem?',
  priority: 'high',
  timeoutMs: 30000,
});

if (response.status === 'success') {
  console.log('Answer:', response.content);
} else if (response.status === 'timeout') {
  console.log('Request timed out');
}
```

### Task Handoff

```typescript
// Structured handoff between agents
const result = await bus.handoff('analyst-gmi-1', 'reviewer-gmi-1', {
  taskId: 'analysis-task-1',
  taskDescription: 'Data analysis for Q4 report',
  progress: 0.8,
  completedWork: ['Data collection', 'Initial analysis'],
  remainingWork: ['Final review', 'Report generation'],
  context: { findings: [...], metrics: {...} },
  reason: 'completion',
  instructions: 'Please review and finalize',
});

if (result.accepted) {
  console.log(`Handoff accepted by ${result.newOwnerId}`);
} else {
  console.log(`Handoff rejected: ${result.rejectionReason}`);
}
```

### Topic-Based Pub/Sub

```typescript
// Create a topic
const topic = await bus.createTopic({
  name: 'findings',
  description: 'Research findings channel',
  agencyId: 'agency-123',
  publisherRoles: ['researcher', 'analyst'],
  subscriberRoles: ['coordinator', 'reviewer'],
});

// Subscribe to topic
bus.subscribeToTopic('coordinator-gmi-1', topic.topicId, (message) => {
  console.log('New finding:', message.content);
});

// Publish to topic
await bus.publishToTopic(topic.topicId, {
  type: 'finding',
  fromAgentId: 'researcher-gmi-1',
  content: { discovery: '...', confidence: 0.9 },
  priority: 'high',
});
```

## Message History & Statistics

```typescript
// Get message history
const history = await bus.getMessageHistory('analyst-gmi-1', {
  limit: 50,
  since: new Date(Date.now() - 3600000), // Last hour
  types: ['task_delegation', 'answer'],
  direction: 'received',
});

// Get bus statistics
const stats = bus.getStatistics();
console.log(`Messages sent: ${stats.totalMessagesSent}`);
console.log(`Messages delivered: ${stats.totalMessagesDelivered}`);
console.log(`Avg delivery time: ${stats.avgDeliveryTimeMs}ms`);
```

## Integration with Agency Memory

The Communication Bus integrates with AgencyMemoryManager for automatic context sharing:

```typescript
import { AgencyMemoryManager, AgentCommunicationBus } from '@framers/agentos';

// Auto-ingest important communications to shared memory
bus.subscribe('coordinator-gmi-1', async (message) => {
  if (message.type === 'decision' || message.type === 'finding') {
    await agencyMemoryManager.broadcastToAgency(agencyId, {
      content: JSON.stringify(message.content),
      senderGmiId: message.fromAgentId,
      senderRoleId: message.fromRoleId!,
      broadcastType: message.type === 'decision' ? 'decision' : 'finding',
      priority: message.priority === 'urgent' ? 'critical' : 'normal',
    });
  }
});
```

## Key Interfaces

### AgentMessage

```typescript
interface AgentMessage {
  messageId: string;
  type: AgentMessageType;
  fromAgentId: string;
  fromRoleId?: string;
  toAgentId?: string;
  toRoleId?: string;
  agencyId?: string;
  content: string | Record<string, unknown>;
  priority: MessagePriority;
  sentAt: Date;
  inReplyTo?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}
```

### HandoffContext

```typescript
interface HandoffContext {
  taskId: string;
  taskDescription: string;
  progress: number;
  completedWork: string[];
  remainingWork: string[];
  context: Record<string, unknown>;
  reason: 'completion' | 'escalation' | 'specialization' | 'capacity' | 'timeout';
  instructions?: string;
  deadline?: Date;
}
```

See `IAgentCommunicationBus.ts` for complete type definitions.

## Related Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [Planning Engine](./PLANNING_ENGINE.md)
- [Human-in-the-Loop](./HUMAN_IN_THE_LOOP.md)
- [Guardrails Usage Guide](./GUARDRAILS_USAGE.md)



