# Examples — Practical Cookbook

> Complete, runnable code snippets for common AgentOS patterns.

---

## Table of Contents

1. [Customer Service Agency](#1-customer-service-agency)
2. [Research Team](#2-research-team)
3. [Content Pipeline](#3-content-pipeline)
4. [Voice Call Center](#4-voice-call-center)
5. [Code Review Bot](#5-code-review-bot)
6. [Knowledge Base Q&A](#6-knowledge-base-qa)
7. [Multi-Channel Support Bot](#7-multi-channel-support-bot)
8. [Automated Blog Publisher](#8-automated-blog-publisher)
9. [Runtime-Configured Tools](#9-runtime-configured-tools)
10. [Agency Streaming](#10-agency-streaming)
11. [Query Router](#11-query-router)
12. [Query Router Host Hooks](#12-query-router-host-hooks)
13. [Per-Agent Identity via SOUL.md](#13-per-agent-identity-via-soulmd)
14. [Single Agent — Minimal](#14-single-agent--minimal)
15. [Multi-Agent Team with Dependency Graph](#15-multi-agent-team-with-dependency-graph)
16. [Emergent Self-Improvement Agent](#16-emergent-self-improvement-agent)

---

## 1. Customer Service Agency

Sequential pipeline with human-in-the-loop escalation.

```typescript
import { agency } from '@framers/agentos';

const supportTeam = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'sequential',
  agents: {
    triage: {
      instructions: `
        You are a support triage agent. Classify the issue as:
        - "simple": can be resolved with documentation
        - "billing": requires billing team
        - "technical": requires engineering team
        - "escalate": critical issue requiring human
        Reply with only the classification label.
      `,
    },
    resolver: {
      instructions: `
        You are a support resolver. Based on the classification, provide:
        - A clear, empathetic response to the customer
        - Step-by-step resolution if applicable
        - If classified as "escalate", ask the human team to take over
      `,
      hitl: {
        conditions: [{ type: 'agent_flag', flag: 'needs_escalation' }],
        prompt: 'A customer issue requires human review. Approve the response or redirect.',
      },
    },
  },
  guardrails: ['content-safety', 'pii-filter'],
});

const result = await supportTeam.generate(
  'My account was charged twice for the same subscription and I am very upset.'
);

console.log(result.text);
```

---

## 2. Research Team

Parallel information gathering with RAG and synthesis.

```typescript
import { agency } from '@framers/agentos';

const researchTeam = agency({
  provider: 'anthropic',
  strategy: 'parallel',
  agents: {
    webResearcher: {
      instructions:
        'Search the web for current information on the topic. Return key facts and sources.',
      tools: ['web_search', 'web_fetch'],
    },
    academicResearcher: {
      instructions: 'Search arXiv and Google Scholar for academic papers. Summarize findings.',
      tools: ['arxiv_search'],
    },
    newsAnalyst: {
      instructions:
        'Find recent news and trends on the topic. Highlight what changed in the last month.',
      tools: ['news_search'],
    },
  },
  synthesizer: {
    instructions: `
      You receive research from three specialists. Synthesize their findings into:
      1. A 3-paragraph executive summary
      2. Key facts (bullet points, with sources)
      3. Open questions and limitations
    `,
  },
  memory: {
    enabled: true,
    type: 'semantic',
    scope: 'session',
  },
});

const report = await researchTeam.generate(
  'Impact of quantum error correction on near-term quantum computing.'
);
console.log(report.text);
```

---

## 3. Content Pipeline

Review loop with social posting on approval. The `workflow()` DSL is a
typed graph that compiles into a runtime. Two things are easy to get wrong
the first time, both shown explicitly below:

1. **Pass `deps` into `compile({ deps })`.** The runtime needs an executor
   for every node type you use — `toolOrchestrator` for `tool` nodes,
   `loopController` + `providerCall` for `gmi` nodes, etc. Without these,
   the matching nodes resolve `success: false` and `invoke()` returns `{}`.
   See [`WorkflowRuntimeDeps`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts).
2. **Use `outputAs` to map the final step's output to your `.returns()`
   schema key.** By default each step's `output` lands in
   `state.artifacts[<stepId>]`, so without `outputAs: 'publishedTo'` your
   `result` would have `result.publish` (the step id) rather than
   `result.publishedTo`.

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { agent } from '@framers/agentos';
import { z } from 'zod';

// Stand-ins for the host-side helpers the workflow's tools delegate to.
// Replace with your real implementations (HTTP calls, SDKs, etc.).
async function searchTheWeb(args: Record<string, unknown>) { return { results: [] }; }
async function postToTwitterAndLinkedIn(args: Record<string, unknown>) { return { posted: true }; }

// 1. Wire up a stateful agent that the GMI nodes will delegate to. Any
//    real-world workflow runs LLM calls through your own provider config;
//    the workflow runtime only orchestrates — it does NOT pick a provider
//    for you.
const writer = agent({
  provider: 'openai',
  model: 'gpt-4o-mini',
  instructions: 'You are a senior content marketer.',
});

// 2. Implement the deps the runtime expects. `toolOrchestrator` is the
//    minimal hook for `step({ tool: '...' })` — register the tools your
//    workflow names and `processToolCall` returns their output.
const toolOrchestrator = {
  async processToolCall({ toolCallRequest }: {
    toolCallRequest: { toolName: string; arguments: Record<string, unknown> };
  }) {
    switch (toolCallRequest.toolName) {
      case 'web_search':
        return { success: true, output: await searchTheWeb(toolCallRequest.arguments) };
      case 'multi_channel_post':
        return { success: true, output: await postToTwitterAndLinkedIn(toolCallRequest.arguments) };
      default:
        return { success: false, error: `Unknown tool: ${toolCallRequest.toolName}` };
    }
  },
};

// 3. `providerCall` is the GMI-node hook. It receives the step's
//    instructions string and the current graph state, and yields LoopChunks
//    on the way to a final LoopOutput. The simplest possible implementation
//    just delegates to the agent above.
async function* providerCall(instructions: string) {
  const reply = await writer.generate(instructions);
  yield { type: 'text' as const, text: reply.text };
  return { success: true, output: reply.text };
}

// 4. Build the pipeline. Each step's output is auto-promoted to
//    `state.artifacts[<stepId>]` unless you set `outputAs`.
const contentPipeline = workflow('content-pipeline')
  .input(z.object({ topic: z.string(), audience: z.string() }))
  .returns(z.object({ publishedTo: z.array(z.string()) }))

  // Step 1: Research the topic — output lands in `result.research`.
  .step('research', {
    tool: 'web_search',
    effectClass: 'external',
  })

  // Step 2: Draft the blog post — output lands in `result.draft`.
  .step('draft', {
    gmi: {
      instructions: `
        Write a 400-word blog post on {{topic}} for {{audience}}.
        Include 3 key insights and a call to action.
      `,
    },
  })

  // Step 3: Human approval — uses autoAccept here so the example runs
  // without an interactive terminal. In production, omit autoAccept and
  // wire up `hitl.cli()` or `hitl.llmJudge()` from `@framers/agentos`.
  .step('review', {
    human: { prompt: 'Review the draft. Approve or request changes.', autoAccept: true } as any,
  })

  // Step 4: Generate a social variant — output in `result['social-draft']`.
  .step('social-draft', {
    gmi: {
      instructions: 'Create a Twitter/LinkedIn-optimized 280-char teaser for the blog post.',
    },
  })

  // Step 5: Publish — `outputAs` renames the artifact key to match the
  // `.returns()` schema, so callers get `result.publishedTo` directly.
  .step('publish', {
    tool: 'multi_channel_post',
    effectClass: 'external',
    outputAs: 'publishedTo',
  })

  .compile({
    // Wire the deps you need. Missing deps → matching node types fail.
    deps: {
      toolOrchestrator,
      providerCall, // consumed by GMI nodes
    },
  });

const result = await contentPipeline.invoke({
  topic: 'How AI agents will change software development in 2026',
  audience: 'senior software engineers',
}) as { publishedTo: string[]; research?: unknown; draft?: string };

console.log('Published to:', result.publishedTo); // ['twitter', 'linkedin']
console.log('Draft preview:', String(result.draft).slice(0, 200));
```

> **Prefer the `agency()` API for multi-step LLM pipelines.** When every
> step is a GMI/agent and you don't need explicit graph control,
> [`agency({ strategy: 'sequential', agents: { ... } })`](./HIGH_LEVEL_API.md)
> is the higher-level path — it auto-wires the providers, memory, and
> guardrails so you don't manage `toolOrchestrator` / `providerCall`
> yourself. Reach for `workflow()` when you need a typed DAG, branches,
> or human-in-the-loop gates.

---

## 4. Voice Call Center

Hierarchical agency with voice transport. The `voice.enabled: true` flag attaches a `listen()` method to the returned agency that starts a local WebSocket server; STT, TTS, and telephony bridge to that transport.

```typescript
import { agency } from '@framers/agentos';

const callCenter = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'hierarchical',
  voice: {
    enabled: true,
    transport: 'telephony',
    stt: 'deepgram',
    tts: 'elevenlabs',
    ttsVoice: 'professional-en-us',
    telephony: {
      provider: 'twilio',
      inboundNumber: process.env.TWILIO_PHONE_NUMBER,
    },
  },
  agents: {
    receptionist: {
      instructions: `
        You are a friendly receptionist. Greet callers, collect their name
        and reason for calling, then route to the appropriate specialist.
        Route to "billing" for payment issues, "technical" for product problems,
        or "sales" for new customer inquiries.
      `,
      role: 'orchestrator',
    },
    billing: {
      instructions: 'You are a billing specialist. Resolve payment issues calmly and efficiently.',
      role: 'worker',
    },
    technical: {
      instructions: 'You are a technical support specialist. Diagnose and resolve product issues.',
      role: 'worker',
      tools: ['knowledge_base_search', 'ticket_create'],
    },
    sales: {
      instructions: 'You are a sales consultant. Help prospects find the right plan.',
      role: 'worker',
      tools: ['product_catalog', 'crm_create_lead'],
    },
  },
});

// listen() is attached when voice.enabled is set. It starts a local WebSocket
// server that accepts JSON text frames and routes them through the agency's
// generate(). STT, TTS, and Twilio bridge the WebSocket to live audio via the
// channels system and the telephony adapter — see
// docs.agentos.sh/features/telephony-providers.
const { port, url, close } = await callCenter.listen({ port: 8080 });

console.log(`Call center ready. WebSocket transport listening at ${url}`);

// Optional: graceful shutdown
process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});
```

---

## 5. Code Review Bot

Debate strategy: two agents argue across N rounds, then the agency-level model synthesises a final verdict.

```typescript
import { agency } from '@framers/agentos';
import { readFileSync } from 'fs';

const codeReviewer = agency({
  provider: 'anthropic',
  // Pin the model explicitly so production traffic doesn't drift across snapshots.
  model: 'claude-sonnet-4-6',
  strategy: 'debate',
  maxRounds: 2,
  agents: {
    critic: {
      instructions: `
        You are a strict code reviewer. Find bugs, security issues, performance
        problems, and violations of best practices. Your job is to find
        everything wrong.
      `,
    },
    advocate: {
      instructions: `
        You are a code quality advocate. Identify the strengths of the code:
        good patterns, clear naming, testability, solid architecture choices.
        Push back on overly pedantic criticism.
      `,
    },
    synthesizer: {
      instructions: `
        You are a senior engineer making the final call on a code review.
        Weigh the critic and advocate's arguments and output one of:
        - APPROVE: code is production-ready
        - REQUEST_CHANGES: fixes are needed (list them)
        - REJECT: the approach is fundamentally flawed
      `,
      role: 'orchestrator',
    },
  },
});

const code = readFileSync('./src/auth.ts', 'utf8');

const review = await codeReviewer.generate(`
  Review this TypeScript code for a production auth module:
  \`\`\`typescript
  ${code}
  \`\`\`
`);

console.log(review.text);
// APPROVE / REQUEST_CHANGES / REJECT + detailed feedback
```

---

## 6. Knowledge Base Q&A

RAG-powered Q&A with cognitive memory across sessions. RAG configuration is enforced by the full runtime — use `new AgentOS()` or `agency()`. The lightweight `agent()` helper preserves the `rag` field for forward compatibility but does not actively dispatch to a vector store, so a kb-aware agent built on `agent()` alone will produce ungrounded answers.

```typescript
import { AgentOS } from '@framers/agentos';

const kb = new AgentOS();
await kb.initialize({
  provider: 'openai',
  model: 'gpt-4o',
  instructions: `
    You are a helpful documentation assistant.
    Search the knowledge base to answer questions accurately.
    If you don't find a relevant answer, say so clearly.
  `,
  memory: {
    enabled: true,
    decay: 'ebbinghaus',
    workingMemory: { capacity: 7 },
  },
  rag: {
    enabled: true,
    vectorStore: { type: 'hnsw', dimensions: 1536 },
    collections: ['product-docs', 'api-reference', 'tutorials'],
    topK: 5,
    minSimilarity: 0.7,
  },
});

// Per-user session keeps cognitive memory scoped per actor.
const session = kb.session('user-alice');

// First turn — answered from RAG hits
const { text: answer } = await session.send(
  'How do I configure rate limiting in the AgentOS middleware?',
);
console.log(answer);

// Follow-up benefits from both RAG and the prior turn's session memory
const { text: followUp } = await session.send(
  'What about for the voice pipeline specifically?',
);
console.log(followUp);
```

> **Note on RAG corpus.** This example assumes `product-docs`, `api-reference`, and `tutorials` collections are already populated in the configured vector store. If you run it against an empty store, the agent will correctly report it does not have grounded information instead of hallucinating. See [Multimodal RAG](/features/multimodal-rag) for the ingestion pipeline.

---

## 7. Multi-Channel Support Bot

Agency connected to Discord + Slack + Telegram simultaneously.

```typescript
import { agency } from '@framers/agentos';
import {
  ChannelRouter,
  DiscordChannelAdapter,
  SlackChannelAdapter,
  TelegramChannelAdapter,
} from '@framers/agentos/channels';

// 1. Create the agency
const supportBot = agency({
  provider: 'openai',
  strategy: 'sequential',
  agents: {
    greeter: {
      instructions: 'Greet the user and understand their issue in 1–2 sentences.',
    },
    resolver: {
      instructions: 'Provide a clear, helpful resolution. Use the knowledge base if needed.',
      tools: ['knowledge_base_search', 'ticket_create'],
    },
  },
  guardrails: ['content-safety'],
});

// 2. Connect to channels
const router = new ChannelRouter();

const discord = new DiscordChannelAdapter();
const slack = new SlackChannelAdapter();
const telegram = new TelegramChannelAdapter();

await discord.initialize({
  platform: 'discord',
  credential: process.env.DISCORD_BOT_TOKEN!,
  params: { botToken: process.env.DISCORD_BOT_TOKEN! },
});
await slack.initialize({
  platform: 'slack',
  credential: process.env.SLACK_BOT_TOKEN!,
  params: { botToken: process.env.SLACK_BOT_TOKEN! },
});
await telegram.initialize({
  platform: 'telegram',
  credential: process.env.TELEGRAM_BOT_TOKEN!,
  params: { botToken: process.env.TELEGRAM_BOT_TOKEN! },
});

router.registerAdapter(discord);
router.registerAdapter(slack);
router.registerAdapter(telegram);

// 3. Handle messages from any platform
router.onMessage(async (message, binding, session) => {
  const platform = binding.platform;
  const sessionId = `${platform}:${session.remoteUser ?? message.sender ?? 'anon'}`;

  const response = await supportBot.generate(message.text ?? '', {
    sessionId,
    context: { platform, userId: session.remoteUser },
  });

  await router.sendMessage(
    binding.cipherId,
    platform,
    message.conversationId,
    { blocks: [{ type: 'text', text: response.text }] },
  );
});

console.log('Support bot listening on Discord, Slack, and Telegram...');
```

---

## 8. Automated Blog Publisher

Full pipeline: research → write → image → social posting.

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { generateImage } from '@framers/agentos';
import { SocialPostManager, ContentAdaptationEngine } from '@framers/agentos/social-posting';
import { z } from 'zod';

const blogPublisher = workflow('automated-blog-publisher')
  .input(
    z.object({
      topic: z.string(),
      audience: z.string(),
      platforms: z.array(z.string()).default(['twitter', 'linkedin', 'bluesky']),
    })
  )
  .returns(
    z.object({
      postUrl: z.string(),
      socialUrls: z.record(z.string()),
    })
  )

  // Research
  .step('research', {
    tool: 'web_search',
    effectClass: 'external',
  })

  // Write the post
  .step('write', {
    gmi: {
      instructions: `
        Write a 600-word blog post about {{topic}} for {{audience}}.
        Include: compelling headline, 3 sections with headers, key takeaways.
        Format as Markdown.
      `,
    },
  })

  // Generate a header image
  .step('generate-image', {
    gmi: {
      instructions: 'Describe a header image for this blog post in one sentence.',
    },
  })

  // Parallel: publish to CMS + generate social variants
  .parallel(
    { reducers: {} },
    (wf) =>
      wf.step('publish-cms', {
        tool: 'cms_publish',
        effectClass: 'external',
      }),
    (wf) =>
      wf.step('social-variants', {
        gmi: {
          instructions: `
          Create platform-specific social media posts for this blog post.
          Twitter: 280 chars max, hook + link
          LinkedIn: professional tone, 3 bullet highlights
          Bluesky: casual tone, 300 chars max
          Return as JSON: { twitter, linkedin, bluesky }
        `,
        },
      })
  )

  // Schedule social posts
  .step('schedule-social', {
    tool: 'bulk_scheduler',
    effectClass: 'external',
  })

  .compile();

// Run the pipeline
async function publishPost(topic: string) {
  // First, generate the header image outside the workflow
  const image = await generateImage({
    provider: 'stability',
    model: 'stable-image-core',
    prompt: `A professional blog header image representing: ${topic}. Clean, modern style.`,
    width: 1200,
    height: 628,
    providerOptions: {
      stability: { stylePreset: 'digital-art' },
    },
  });

  const result = await blogPublisher.invoke({
    topic,
    audience: 'software developers',
    platforms: ['twitter', 'linkedin', 'bluesky'],
    // Pass image URL into the workflow context
    headerImageUrl: image.images[0].url,
  });

  console.log('Published:', result.postUrl);
  console.log('Social posts scheduled:', result.socialUrls);
}

await publishPost('How vector databases enable semantic search in AI applications');
```

---

## 9. Runtime-Configured Tools

Direct `AgentOS` initialization with runtime-configured tools via
`createTestAgentOSConfig({ tools })`.

Runnable source: [`packages/agentos/examples/agentos-config-tools.mjs`](https://github.com/framersai/agentos/blob/master/examples/agentos-config-tools.mjs)

```typescript
import { AgentOS } from '@framers/agentos';
import { createTestAgentOSConfig } from '@framers/agentos';

const agent = new AgentOS();

await agent.initialize(
  await createTestAgentOSConfig({
    tools: {
      open_profile: {
        description: 'Load a saved profile record by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
          },
          required: ['profileId'],
        },
        execute: async ({ profileId }) => ({
          success: true,
          output: {
            profile: {
              id: profileId,
              preferredTheme: 'solarized',
            },
          },
        }),
      },
    },
  })
);

const tool = await agent.getToolOrchestrator().getTool('open_profile');
const result = await tool?.execute({ profileId: 'profile-1' }, {});

console.log(result);
await agent.shutdown();
```

Use this path when the tool should be globally prompt-visible and executable on
direct `processRequest()` turns. Use `externalTools` or the registered-tool
helpers only when the host should stay responsible for execution after a tool
pause.

---

## 10. Agency Streaming

Raw live chunks, finalized approved output, and structured final events from a
single `agency().stream()` run.

```typescript
import { agency, type AgencyStreamResult } from '@framers/agentos';

const streamingTeam = agency({
  provider: 'openai',
  strategy: 'sequential',
  agents: {
    researcher: { instructions: 'Collect the key facts and risks.' },
    writer: { instructions: 'Turn the facts into four crisp bullet points.' },
  },
  hitl: {
    approvals: { beforeReturn: true },
    handler: async () => ({
      approved: true,
      modifications: {
        output: 'Approved for delivery:\\n- Risk 1\\n- Risk 2\\n- Risk 3\\n- Risk 4',
      },
    }),
  },
});

const stream: AgencyStreamResult = streamingTeam.stream(
  'Summarize the main HTTP/3 rollout risks.'
);

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk); // raw live output
}
process.stdout.write('\\n');

for await (const event of stream.fullStream) {
  if (event.type === 'final-output') {
    console.log('Finalized answer:', event.text);
    console.log('Agent calls:', event.agentCalls.length);
  }
}

for await (const approved of stream.finalTextStream) {
  console.log('Approved-only stream:', approved);
}

console.log(await stream.text);
console.log(await stream.agentCalls);
```

Runnable source: [`packages/agentos/examples/agency-streaming.mjs`](https://github.com/framersai/agentos/blob/master/examples/agency-streaming.mjs)

---

## 11. Query Router

Tier classification, retrieval routing, and fallback metadata from the
standalone `QueryRouter`.

```typescript
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  availableTools: ['web_search', 'deep_research'],
  onClassification: (result) => {
    console.log(result.tier, result.confidence);
  },
});

await router.init();

const result = await router.route(
  'How does AgentOS memory retrieval work, and when does it fall back to keyword search?'
);

console.log(result.answer);
console.log(result.classification.tier);
console.log(result.tiersUsed);
console.log(result.fallbacksUsed);
console.log(result.sources);

await router.close();
```

Runnable source: [`packages/agentos/examples/query-router.mjs`](https://github.com/framersai/agentos/blob/master/examples/query-router.mjs)

---

## 12. Query Router Host Hooks

Host-provided graph expansion, reranking, and deep research hooks layered onto
the same `QueryRouter` interface.

```typescript
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  graphEnabled: true,
  deepResearchEnabled: true,
  graphExpand: async (seedChunks) => [...seedChunks, extraGraphChunk],
  rerank: async (_query, chunks, topN) => chunks.slice(0, topN),
  deepResearch: async (query, sources) => ({
    synthesis: `Host-provided research for ${query}`,
    sources: externalResearchChunks,
  }),
});

await router.init();
console.log(router.getCorpusStats()); // runtime modes become active
```

Runnable source: [`packages/agentos/examples/query-router-host-hooks.mjs`](https://github.com/framersai/agentos/blob/master/examples/query-router-host-hooks.mjs)

---

## 13. Per-Agent Identity via SOUL.md

Load identity, voice, hard limits, and HEXACO scores from a markdown workspace. The runtime injects `SOUL.md` body as the first system message and parses YAML frontmatter into `IPersonaDefinition` fields. Compatible with the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md) and OpenClaw conventions.

Workspace layout (per agent):

```
~/.agentos/agents/aria/
├── SOUL.md       # identity, values, tone, hard limits (REQUIRED)
├── STYLE.md      # voice, syntax, vocabulary patterns (optional)
├── IDENTITY.md   # display card: name, role, agent-ID (optional)
├── AGENTS.md     # procedural rules (optional)
├── MEMORY.md     # long-term facts (auto-managed)
└── examples/     # good-outputs.md + bad-outputs.md (optional)
```

Sample `SOUL.md`:

```markdown
---
name: Aria
agentId: support-bot
role: Customer support for Meridian SaaS
hexaco:
  honestyHumility: 0.85
  emotionality: 0.55
  extraversion: 0.70
  agreeableness: 0.85
  conscientiousness: 0.90
  openness: 0.65
voice:
  provider: elevenlabs
  voiceId: rachel-warm
defaultMood: helpful_engaged
hardLimits:
  - Never share internal pricing formulas
  - Always recommend human review for refunds over €100
---

## Who You Are

You are Aria, the customer support agent for Meridian SaaS.

## Tone

Direct, friendly, patient. Never condescending.
```

Wire it into `agent()`:

```typescript
import { agent } from '@framers/agentos';

// Workspace path — loads SOUL.md + companion files
const aria = agent({
  provider: 'anthropic',
  soul: '~/.agentos/agents/aria',
});

// Direct file path — loads SOUL.md only
const compact = agent({
  provider: 'openai',
  soul: './personas/aria.soul.md',
});

// Inline content — for tests and ephemeral agents
const ephemeral = agent({
  provider: 'openai',
  soul: { content: '---\nname: Tester\n---\nYou are a test agent.' },
});

const reply = await aria.generate('I need help with my invoice.');
```

The HEXACO frontmatter flows into the same `PersonaDriftMechanism` and `PersonaOverlayManager` as inline `personality:` config — both paths produce identical runtime behavior. See [SOUL_FILES.md](../SOUL_FILES.md) for the full 6-file workspace spec.

---

## 14. Single Agent — Minimal

The simplest entry point: one agent, one tool, one call.

```typescript
import { agent, type ITool } from '@framers/agentos';

// Stand-in for a real web-search tool (Tavily, Serper, Firecrawl, etc.).
// Replace with your real implementation.
const webSearchTool: ITool = {
  name: 'web_search',
  description: 'Search the web for recent information.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) results for "${query}"` }),
};

const researcher = agent({
  model: 'openai:gpt-4o',
  instructions: 'You are a research assistant. Search the web and summarize findings.',
  tools: [webSearchTool],
  maxSteps: 5,
});

const result = await researcher.generate('What are the latest advances in RAG?');
console.log(result.text);
```

---

## 15. Multi-Agent Team with Dependency Graph

Declare dependencies between agents and let the orchestrator schedule them
automatically. Agents with no dependencies run first; downstream agents receive
their predecessors' outputs as context.

```typescript
import { agency, type ITool } from '@framers/agentos';

// Stand-ins for the host-supplied tools each agent uses. Replace with real
// implementations (Tavily, arxiv-api, etc.).
const webSearchTool: ITool = {
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) ${query}` }),
};
const arxivTool: ITool = {
  name: 'arxiv_search',
  description: 'Search arXiv for papers.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) arxiv: ${query}` }),
};

const team = agency({
  agents: {
    researcher: {
      model: 'openai:gpt-4o',
      instructions: 'Find relevant research papers and data.',
      tools: [webSearchTool, arxivTool],
    },
    analyst: {
      model: 'openai:gpt-4o',
      instructions: 'Analyze the research and extract key insights.',
    },
    writer: {
      model: 'openai:gpt-4o',
      instructions: 'Write a clear, well-structured summary.',
      dependsOn: ['researcher', 'analyst'],
    },
  },
  strategy: 'graph', // auto-detected from dependsOn
});

const result = await team.generate(
  'Compare RAG vs fine-tuning for domain-specific LLM applications'
);
console.log(result.text);
```

---

## 16. Emergent Self-Improvement Agent

Enable the emergent subsystem so the agent can forge new tools, adapt its own
personality, and manage its skill set at runtime. Guard the mutation surface
with `maxDeltaPerSession` and skill allowlists.

```typescript
import { agent } from '@framers/agentos';
import { ForgeToolMetaTool, AdaptPersonalityTool } from '@framers/agentos/emergent';

// The emergent toolkit ships these built-in meta-tools. Wire them into the
// agent's tools list so the runtime exposes forge_tool / adapt_personality
// when emergent.enabled is true.
const forgeTool = ForgeToolMetaTool;
const adaptPersonalityTool = AdaptPersonalityTool;
// manageSkillsTool / selfEvaluateTool are illustrative — substitute your own
// skills-management / self-evaluation tool implementations as needed.

const adaptiveAgent = agent({
  model: 'openai:gpt-4o',
  instructions: 'You are a helpful assistant that learns and adapts.',
  tools: [forgeTool, adaptPersonalityTool],
  emergent: {
    enabled: true,
    selfImprovement: {
      enabled: true,
      personality: { maxDeltaPerSession: 0.15 },
      skills: { allowlist: ['*'] },
    },
  },
});

// The agent can now:
// - Forge new tools at runtime
// - Adapt its personality based on task requirements
// - Enable/disable skills dynamically
// - Evaluate its own performance and adjust
const result = await adaptiveAgent.generate('Help me write a creative story');
console.log(result.text);
```

---

## Runnable Example Files

The `examples/` directory contains standalone `.mjs` files you can run directly:

```bash
npx tsx examples/<file>.mjs
```

| File | Description | Key APIs |
|------|-------------|----------|
| [`high-level-api.mjs`](../../examples/high-level-api.mjs) | One-shot text, streaming, image generation, agent sessions | `generateText`, `streamText`, `generateImage`, `agent` |
| [`agency-graph.mjs`](../../examples/agency-graph.mjs) | Multi-agent agency with graph strategy | `agency`, graph edges, parallel execution |
| [`agency-streaming.mjs`](../../examples/agency-streaming.mjs) | Streaming agency output with real-time chunks | `agency`, `onChunk` callbacks |
| [`agent-graph.mjs`](../../examples/agent-graph.mjs) | AgentGraph runtime with typed nodes and edges | `AgentGraph`, node definitions, edge routing |
| [`agent-communication-bus.mjs`](../../examples/agent-communication-bus.mjs) | Inter-agent messaging via communication bus | `AgentCommunicationBus`, pub/sub topics |
| [`workflow-dsl.mjs`](../../examples/workflow-dsl.mjs) | Declarative workflow definitions | `workflow`, sequential/parallel/conditional steps |
| [`mission-api.mjs`](../../examples/mission-api.mjs) | Self-expanding mission orchestration with planner | `mission`, goal decomposition, fact-checking |
| [`multi-agent-workflow.mjs`](../../examples/multi-agent-workflow.mjs) | Coordinated multi-agent pipeline with handoffs | Multi-agent, handoff protocol |
| [`query-router.mjs`](../../examples/query-router.mjs) | Intent-based routing to specialized agents | `QueryRouter`, route definitions |
| [`query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) | Query router with host lifecycle hooks | `QueryRouter`, `onRoute`, `onFallback` hooks |
| [`generate-image.mjs`](../../examples/generate-image.mjs) | Image generation across providers | `generateImage`, provider selection |
| [`agentos-config-tools.mjs`](../../examples/agentos-config-tools.mjs) | Full AgentOS runtime with tool registration | `AgentOS`, `processRequest`, custom tools |
| [`schema-on-demand-local-module.mjs`](../../examples/schema-on-demand-local-module.mjs) | Dynamic extension loading from local modules | `createCuratedManifest`, lazy imports |

---

## Related Guides

- [GETTING_STARTED.md](./GETTING_STARTED.md) — installation and first steps
- [ORCHESTRATION.md](../orchestration/ORCHESTRATION.md) — graphs, workflows, missions
- [CHANNELS.md](../features/CHANNELS.md) — channel setup
- [SOCIAL_POSTING.md](../features/SOCIAL_POSTING.md) — social media publishing
- [HIGH_LEVEL_API.md](./HIGH_LEVEL_API.md) — `AgentOS`, helper wrappers, and runtime tool registration
- [COGNITIVE_MEMORY.md](../memory/COGNITIVE_MEMORY.md) — memory system
- [COGNITIVE_MEMORY.md#mechanism-implementation-reference](../memory/COGNITIVE_MEMORY.md#mechanism-implementation-reference) — 8 neuroscience-backed mechanisms (implementation reference)
- [IMAGE_GENERATION.md](../features/IMAGE_GENERATION.md) — image provider setup
- [EVALUATION.md](../features/EVALUATION.md) — testing and benchmarking
- [AGENCY_API.md](../features/AGENCY_API.md) — full agency reference
