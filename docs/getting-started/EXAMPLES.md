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
15. [Agency with Shared Memory + RAG](#15-agency-with-shared-memory--rag)
16. [Multi-Agent Team with Dependency Graph](#16-multi-agent-team-with-dependency-graph)
17. [Emergent Self-Improvement Agent](#17-emergent-self-improvement-agent)

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
});

// Guardrails are runtime instances, not string IDs. Pull packs from
// `@framers/agentos-extensions` (PII redaction, ML toxicity classifiers,
// topicality, grounding guard, etc.) and pass them via `guardrails: [...]`.
// See https://docs.agentos.sh/features/guardrails for the full catalog.

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
// Bring your own tool implementations. The examples below show ITool-shaped
// stubs; in production wire these to Tavily / Serper / arxiv-api / etc.
const webSearchTool = {
  name: 'web_search',
  description: 'Search the web.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) ${query}` }),
};
const arxivTool = {
  name: 'arxiv_search',
  description: 'Search arXiv for papers.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) arxiv: ${query}` }),
};
const newsTool = {
  name: 'news_search',
  description: 'Search recent news.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async ({ query }) => ({ success: true, output: `(stub) news: ${query}` }),
};

const researchTeam = agency({
  provider: 'anthropic',
  strategy: 'parallel',
  agents: {
    webResearcher: {
      instructions: 'Search the web. Return 5 facts with sources.',
      tools: [webSearchTool],
    },
    academicResearcher: {
      instructions: 'Search arXiv. Summarize 3 papers.',
      tools: [arxivTool],
    },
    newsAnalyst: {
      instructions: 'Find recent news. Highlight what changed in the last month.',
      tools: [newsTool],
    },
  },
  synthesizer: {
    instructions: `Synthesize the three researchers' output into:
      1. 3-paragraph executive summary
      2. Key facts (bullets, with sources)
      3. Open questions and limitations`,
  },
});

const report = await researchTeam.generate(
  'Impact of quantum error correction on near-term quantum computing.',
);
console.log(report.text);
```

> **Tools must be [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) instances, not bare names.** Agencies don't auto-resolve string identifiers like `'web_search'` to registered tools; pass the actual object the agent should call. See [Agent Memory Tools](/features/memory-operations#agent-memory-tools) for the contract.

---

## 3. Content Pipeline

Review loop with social posting on approval. The high-level path is `agency({ strategy: 'sequential' })` — each agent's output feeds the next, with [`hitl`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) gating the human-approval step. Use this when every step is an LLM/GMI call. Reach for the lower-level `workflow()` DSL only when you need explicit graph control, branches, or non-LLM tool steps wired into the same graph (see [workflow() DSL](/features/workflow-dsl) for that path). For the full [`hitl`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) surface (5 triggers, 6 handler factories, judge + fallback), see the [Human-in-the-Loop guide](/features/human-in-the-loop).

```typescript
import { agency } from '@framers/agentos';

// A host-side helper for the final "publish" step — replace with your real
// social-posting implementation (Twitter / LinkedIn API calls).
async function postToTwitterAndLinkedIn(text: string) {
  // ... your network code here
  return { posted: true, channels: ['twitter', 'linkedin'] };
}

const contentPipeline = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  strategy: 'sequential',
  agents: {
    researcher: {
      instructions:
        'Research {{topic}} for {{audience}}. Output 5 short bullet facts.',
    },
    writer: {
      instructions:
        'Turn the researcher\'s facts into a 400-word blog post with 3 insights and a call to action.',
    },
    reviewer: {
      instructions:
        'Approve the draft as-is, or list specific edits. Reply "APPROVED" if good.',
      // Optional HITL gate: when the reviewer flags `needs_human_review`, pause
      // for a real reviewer. Omit `hitl` to run fully autonomous.
      hitl: {
        conditions: [{ type: 'agent_flag', flag: 'needs_human_review' }],
        prompt: 'A human reviewer should approve this draft.',
      },
    },
    socialDraft: {
      instructions:
        'Write a 280-char Twitter/LinkedIn teaser of the approved post.',
    },
  },
});

const result = await contentPipeline.generate(
  'Topic: how AI agents will change software development in 2026. Audience: senior software engineers.',
);

console.log('Final teaser:', result.text);
// Each agent's output is in `result.agentCalls[i].output`.
console.log('Pipeline steps:', result.agentCalls?.map((c) => c.agentName));

// Publish the final teaser. This step is host-driven — agencies are the
// orchestration layer for LLM-driven steps, not for network side effects.
const posted = await postToTwitterAndLinkedIn(result.text);
console.log('Posted:', posted);
```

> **When to reach for `workflow()` or [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) instead.** `agency({ strategy: 'sequential' })` covers LLM-driven content pipelines cleanly. Switch to the lower-level [`workflow()` DSL](/features/workflow-dsl) when you need a typed DAG with non-LLM `tool:` nodes wired into the same graph, branches based on `state.artifacts`, or reusable sub-graphs. Switch to [`AgentGraph`](/features/agent-graph) when you need explicit conditional edges or programmatic graph construction.

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

RAG-powered Q&A with cognitive memory across sessions. The standalone `Memory` facade owns ingestion, vector storage, and recall; `agent()` wires it in via the `standaloneMemory` config bridge so the same store powers the agent's long-term retrieval AND its session memory.

```typescript
import { agent, Memory } from '@framers/agentos';

// 1. Build (or open) the persistent brain. SQLite is the default; swap
//    `createSqlite` for `createPostgres` in production. Requires the peer
//    `better-sqlite3` for native Node runs (`npm install better-sqlite3`).
const memory = await Memory.createSqlite({
  path: './brain.sqlite',
  graph: true,
  selfImprove: false,
});

// 2. Ingest a corpus once. Supports folders, single files, and URLs.
//    Re-running ingest is idempotent — already-indexed chunks are skipped.
await memory.ingest('./docs/product');
await memory.ingest('./docs/api-reference');

// 3. Construct the answering agent. The KB pattern here is explicit
//    retrieval-then-inject: pull top-K hits via `memory.recall()` and
//    feed them into `session.send()` as grounding context. This is
//    the most predictable RAG path — your prompt deterministically
//    contains the retrieved chunks, so the model can cite them.
const kb = agent({
  provider: 'openai',
  model: 'gpt-4o-mini',
  instructions: `
    You are a documentation assistant. Use the provided context to answer.
    Cite passages by file path. If the context does not answer the question,
    say so explicitly rather than guessing.
  `,
});
const session = kb.session('user-alice');

async function ask(question: string) {
  // `recall()` returns `{ trace, score }` pairs. `trace.content` is the
  // raw chunk text; `trace.id` is stable across runs.
  const hits = await memory.recall(question, { topK: 5 });
  const context = hits
    .map(({ trace }, i) => `[${i + 1}] ${trace.id}\n${trace.content}`)
    .join('\n\n');
  return session.send(`Context:\n${context}\n\nQuestion: ${question}`);
}

console.log((await ask('How do I configure rate limiting in the AgentOS middleware?')).text);
console.log((await ask('What about for the voice pipeline specifically?')).text);

await memory.close();
```

> **Why not just `standaloneMemory: { memory, longTermRetriever: true }`?** The `agent()` helper accepts that bridge for forward compatibility, but automatic per-turn RAG injection requires the full runtime (`new AgentOS()` or `agency()`). When you want deterministic, debuggable retrieval — show me the chunks the model saw — keep `memory.recall()` explicit in your turn loop. See [Memory Operations](/features/memory-operations) for ingest/export options and [Multimodal RAG](/features/multimodal-rag) for image/audio sources.

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

Direct [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) initialization with runtime-configured tools via
`createTestAgentOSConfig({ tools })`.

Runnable source: [`packages/agentos/examples/agentos-config-tools.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agentos-config-tools.mjs)

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

Runnable source: [`packages/agentos/examples/agency-streaming.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agency-streaming.mjs)

---

## 11. Query Router

Tier classification, retrieval routing, and fallback metadata from the
standalone [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts).

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

Runnable source: [`packages/agentos/examples/query-router.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router.mjs)

---

## 12. Query Router Host Hooks

Host-provided graph expansion, reranking, and deep research hooks layered onto
the same [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts) interface.

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

Runnable source: [`packages/agentos/examples/query-router-host-hooks.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router-host-hooks.mjs)

---

## 13. Per-Agent Identity via SOUL.md

Load identity, voice, hard limits, and HEXACO scores from a markdown workspace. The runtime injects `SOUL.md` body as the first system message and parses YAML frontmatter into [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) fields. Compatible with the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md) and OpenClaw conventions.

Workspace layout (per agent):

```
~/.agentos/agents/aria/
├── SOUL.md       # identity, values, tone, hard limits (REQUIRED)
├── STYLE.md      # voice, syntax, vocabulary patterns (optional)
├── IDENTITY.md   # display card: name, role, agent-ID (optional)
├── AGENTS.md     # procedural rules (optional)
├── memory/       # long-term memory wiki: index.md + entities/ + concepts/ + log/ (auto-managed)
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

The HEXACO frontmatter flows into the same `PersonaDriftMechanism` and [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts) as inline `personality:` config — both paths produce identical runtime behavior. See [SOUL_FILES.md](../SOUL_FILES.md) for the full 6-file workspace spec.

For an agent whose long-term memory **is** its `memory/` wiki, use `souledAgent()` instead of `agent()`. It injects `memory/index.md` into the prelude, adds the `read_memory_page` tool, and folds new conversation into entity/concept pages:

```typescript
import { souledAgent } from '@framers/agentos';

const aria = await souledAgent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });

const reply = await aria.generate('I need help with my invoice.');

// Fold this session's conversation into the wiki mid-session
// (also runs automatically on close()):
await aria.memory?.compileWiki();
await aria.close();
```

See [High-Level API](./HIGH_LEVEL_API.md) for the full `souledAgent()` reference.

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
  provider: 'openai', model: 'gpt-4o',
  instructions: 'You are a research assistant. Search the web and summarize findings.',
  tools: [webSearchTool],
  maxSteps: 5,
});

const result = await researcher.generate('What are the latest advances in RAG?');
console.log(result.text);
```

---

## 15. Agency with Shared Memory + RAG

Three brains in one agency. `memory: { shared: true }` gives every agent
read+write access to one cognitive memory store. `rag: { ... }` points the
whole roster at one retrieval corpus. The strategy picks the order;
the shared layer means each brain reads what the previous one wrote
without an explicit handoff payload.

```typescript
import { agency } from '@framers/agentos';

const team = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'sequential',
  memory: { shared: true },                  // cognitive memory shared across brains
  rag: {                                     // shared retrieval corpus (RAG)
    vectorStore: 'in-memory',
    documents: ['./docs/quic-rfc-9000.md', './docs/tcp-rfc-9293.md'],
    topK: 5,
  },
  agents: {
    researcher: { instructions: 'Pull factual claims from the RAG corpus.' },
    writer:     { instructions: "Compose a briefing from the researcher's notes." },
    reviewer:   { instructions: 'Verify the briefing against the same RAG corpus.' },
  },
});

// Same .generate() surface as a single agent. The agency routes outputs
// between brains; the shared memory + RAG layer means each brain reads
// what the previous one wrote without an explicit handoff payload.
const result = await team.generate(
  'Compare QUIC and TCP for low-latency game networking.',
);
console.log(result.text);
console.log(result.agentCalls);              // who read which chunks, in what order
```

Scope to keep in mind: `memory: { shared: true }` is scoped to a single
`generate()` call. Across `session().send()` turns only the message
history persists; the shared cognitive memory store, the shared RAG
context, and any runtime-spawned specialists reset on every turn. See
[Agency API: Memory and RAG](/features/agency-api#memory-and-rag) for
the full scope rules and the cross-turn workaround using a hand-wired
[`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) and [`AgencyMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyMemoryManager.ts).

The companion runnable file
[`examples/agency-shared-memory.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agency-shared-memory.mjs)
runs this exact agency against the OpenAI API. Diff it against
[`examples/single-agent-briefing.mjs`](https://github.com/framerslab/agentos/blob/master/examples/single-agent-briefing.mjs)
(the single-`agent()` baseline) and
[`examples/emergent-hierarchical-spawning.mjs`](https://github.com/framerslab/agentos/blob/master/examples/emergent-hierarchical-spawning.mjs)
(team + runtime synthesis) to see the three rungs of the progression.

---

## 16. Multi-Agent Team with Dependency Graph

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
      provider: 'openai', model: 'gpt-4o',
      instructions: 'Find relevant research papers and data.',
      tools: [webSearchTool, arxivTool],
    },
    analyst: {
      provider: 'openai', model: 'gpt-4o',
      instructions: 'Analyze the research and extract key insights.',
    },
    writer: {
      provider: 'openai', model: 'gpt-4o',
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

## 17. Emergent Self-Improvement Agent

Enable the emergent subsystem so the agent can forge new tools, adapt its own
personality, and manage its skill set at runtime. Guard the mutation surface
with `maxDeltaPerSession` and skill allowlists.

> **Use `agency()` or `new AgentOS()` — not `agent()`.** Emergent tooling requires the full runtime that initializes [`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts) with emergent support. The lightweight `agent()` helper accepts `emergent: true` for config compatibility but emits a `[AgentOS] agent() accepted config that requires the full AgentOS runtime` warning and does not activate `forge_tool` on its own.

```typescript
import { agency } from '@framers/agentos';

// `emergent.enabled` requires `strategy: 'hierarchical'` or `adaptive: true`.
// When enabled, the runtime's ToolOrchestrator auto-wires the emergent
// meta-tools (`forge_tool`, `adapt_personality`) with the live
// EmergentCapabilityEngine reference — you do NOT pass them in `tools: [...]`
// (those classes require a constructor arg, not a bare reference).
const adaptiveAgent = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'hierarchical',
  agents: {
    manager: {
      instructions: 'Coordinate the work. Decide which specialist to spawn when needed.',
    },
    primary: {
      instructions: 'You are a helpful assistant that learns and adapts.',
    },
  },
  emergent: {
    enabled: true,
    selfImprovement: {
      enabled: true,
      personality: { maxDeltaPerSession: 0.15 },
      skills: { allowlist: ['*'] },
    },
  },
});

// The agency can now:
// - Forge new tools at runtime via the auto-injected `forge_tool`
// - Adapt its personality via the auto-injected `adapt_personality`
// - Enable/disable skills dynamically through the skills subsystem
// - Evaluate its own performance and adjust
const result = await adaptiveAgent.generate('Help me write a creative story.');
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
| [`high-level-api.mjs`](../../examples/high-level-api.mjs) | One-shot text, streaming, image generation, agent sessions | `generateText`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts), `generateImage`, [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) |
| [`single-agent-briefing.mjs`](../../examples/single-agent-briefing.mjs) | Single-agent baseline before agency. One brain, no team, no shared state. | [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts), `.generate()` |
| [`agency-shared-memory.mjs`](../../examples/agency-shared-memory.mjs) | Three agents share one cognitive memory store and one RAG corpus across a sequential run | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `memory: { shared: true }`, `rag: { ... }` |
| [`emergent-hierarchical-spawning.mjs`](../../examples/emergent-hierarchical-spawning.mjs) | Hierarchical agency that mints a specialist at runtime when the static roster falls short | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `emergent`, `spawn_specialist`, [`EmergentAgentJudge`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentAgentJudge.ts) |
| [`agency-graph.mjs`](../../examples/agency-graph.mjs) | Multi-agent agency with graph strategy | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), graph edges, parallel execution |
| [`agency-streaming.mjs`](../../examples/agency-streaming.mjs) | Streaming agency output with real-time chunks | [`agency`](https://github.com/framersai/agentos/blob/master/src/api/agency.ts), `onChunk` callbacks |
| [`agent-graph.mjs`](../../examples/agent-graph.mjs) | AgentGraph runtime with typed nodes and edges | [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts), node definitions, edge routing |
| [`agent-communication-bus.mjs`](../../examples/agent-communication-bus.mjs) | Inter-agent messaging via communication bus | [`AgentCommunicationBus`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgentCommunicationBus.ts), pub/sub topics |
| [`workflow-dsl.mjs`](../../examples/workflow-dsl.mjs) | Declarative workflow definitions | [`workflow`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts), sequential/parallel/conditional steps |
| [`mission-api.mjs`](../../examples/mission-api.mjs) | Self-expanding mission orchestration with planner | [`mission`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts), goal decomposition, fact-checking |
| [`multi-agent-workflow.mjs`](../../examples/multi-agent-workflow.mjs) | Coordinated multi-agent pipeline with handoffs | Multi-agent, handoff protocol |
| [`query-router.mjs`](../../examples/query-router.mjs) | Intent-based routing to specialized agents | [`QueryRouter`](https://github.com/framersai/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts), route definitions |
| [`query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) | Query router with host lifecycle hooks | `QueryRouter`, `onRoute`, `onFallback` hooks |
| [`generate-image.mjs`](../../examples/generate-image.mjs) | Image generation across providers | `generateImage`, provider selection |
| [`agentos-config-tools.mjs`](../../examples/agentos-config-tools.mjs) | Full AgentOS runtime with tool registration | [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), `processRequest`, custom tools |
| [`schema-on-demand-local-module.mjs`](../../examples/schema-on-demand-local-module.mjs) | Dynamic extension loading from local modules | [`createCuratedManifest`](https://github.com/framerslab/agentos/blob/master/src/core/types/vendor.d.ts), lazy imports |

---

## Related Guides

- [GETTING_STARTED.md](./GETTING_STARTED.md) — installation and first steps
- [ORCHESTRATION.md](../orchestration/ORCHESTRATION.md) — graphs, workflows, missions
- [CHANNELS.md](../features/CHANNELS.md) — channel setup
- [SOCIAL_POSTING.md](../features/SOCIAL_POSTING.md) — social media publishing
- [HIGH_LEVEL_API.md](./HIGH_LEVEL_API.md) — [`AgentOS`](https://github.com/framersai/agentos/blob/master/src/api/AgentOS.ts), helper wrappers, and runtime tool registration
- [COGNITIVE_MEMORY.md](../memory/COGNITIVE_MEMORY.md) — memory system
- [COGNITIVE_MEMORY.md#mechanism-implementation-reference](../memory/COGNITIVE_MEMORY.md#mechanism-implementation-reference) — 8 neuroscience-backed mechanisms (implementation reference)
- [IMAGE_GENERATION.md](../features/IMAGE_GENERATION.md) — image provider setup
- [EVALUATION.md](../features/EVALUATION.md) — testing and benchmarking
- [AGENCY_API.md](../features/AGENCY_API.md) — full agency reference
