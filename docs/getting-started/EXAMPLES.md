# Examples — Practical Cookbook

> Complete, runnable code snippets for common AgentOS patterns.

---

## Table of Contents

1. [Customer Service Agency](#1-customer-service-agency)
2. [Research Team](#2-research-team)
3. [Content Pipeline](#3-content-pipeline)
4. [Call Center over a WebSocket](#4-call-center-over-a-websocket)
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
15. [Agency with a Sequential Hand-off](#15-agency-with-a-sequential-hand-off)
16. [Multi-Agent Team with Dependency Graph](#16-multi-agent-team-with-dependency-graph)
17. [Self-Improvement Tools on the Runtime](#17-self-improvement-tools-on-the-runtime)

---

## 1. Customer Service Agency

Sequential pipeline with a human approval before the reply goes out.

```typescript
import { agency, hitl } from '@framers/agentos';

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
        - If classified as "escalate", say that a human will take over
      `,
    },
  },
  // Approval is configured on the agency. `beforeReturn` asks the handler
  // before generate() returns; hitl.cli() prompts on the terminal. A rejection
  // makes generate() throw.
  hitl: {
    approvals: { beforeReturn: true },
    handler: hitl.cli(),
  },
});

const result = await supportTeam.generate(
  'My account was charged twice for the same subscription and I am very upset.'
);

console.log(result.text);
```

`agency()` accepts a `guardrails` list of ids and reports each one through `on.guardrailResult` with `enforced: false`: it evaluates none of them. Guardrail packs run on the full runtime ([Guardrails](/features/guardrails)).

---

## 2. Research Team

Parallel information gathering and synthesis.

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
  // The parallel strategy builds its synthesizer from the agency-level
  // provider, model and instructions.
  instructions: `Synthesize the three researchers' output into:
    1. 3-paragraph executive summary
    2. Key facts (bullets, with sources)
    3. Open questions and limitations`,
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
});

const report = await researchTeam.generate(
  'Impact of quantum error correction on near-term quantum computing.',
);
console.log(report.text);
```

> **Tools are objects, not bare names.** An agency does not resolve a string such as `'web_search'` to a registered tool: an array of strings is dropped. Pass objects with a `name`, a `description`, an `inputSchema` and an `execute` function, or a map of name to definition.

---

## 3. Content Pipeline

Draft, review and a social teaser, with a human approval before the result is returned. The high-level path is `agency({ strategy: 'sequential' })`: each agent receives the original task and the previous agent's output, and [`hitl`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) on the agency gates the final answer. Use this when every step is a model call. Reach for the lower-level `workflow()` DSL only when you need explicit graph control, branches, or non-LLM tool steps wired into the same graph (see [workflow() DSL](/features/workflow-dsl) for that path). For the full [`hitl`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) surface (5 triggers, 6 handler factories, judge + fallback), see the [Human-in-the-Loop guide](/features/human-in-the-loop).

```typescript
import { agency, hitl } from '@framers/agentos';

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
        'Research the topic for the stated audience. Output 5 short bullet facts.',
    },
    writer: {
      instructions:
        'Turn the researcher\'s facts into a 400-word blog post with 3 insights and a call to action.',
    },
    reviewer: {
      instructions:
        'Approve the draft as-is, or list specific edits. Reply "APPROVED" if good.',
    },
    socialDraft: {
      instructions:
        'Write a 280-char Twitter/LinkedIn teaser of the approved post.',
    },
  },
  // Optional approval before generate() returns. Omit `hitl` to run without one.
  hitl: {
    approvals: { beforeReturn: true },
    handler: hitl.cli(),
  },
});

const result = await contentPipeline.generate(
  'Topic: how AI agents will change software development in 2026. Audience: senior software engineers.',
);

console.log('Final teaser:', result.text);
// Each agent's output is in `result.agentCalls[i].output`.
console.log('Pipeline steps:', result.agentCalls?.map((c) => c.agent));

// Publish the final teaser. This step is host-driven — agencies are the
// orchestration layer for LLM-driven steps, not for network side effects.
const posted = await postToTwitterAndLinkedIn(result.text);
console.log('Posted:', posted);
```

> **When to reach for `workflow()` or [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) instead.** `agency({ strategy: 'sequential' })` covers LLM-driven content pipelines cleanly. Switch to the lower-level [`workflow()` DSL](/features/workflow-dsl) when you need a typed DAG with non-LLM `tool:` nodes wired into the same graph, branches based on `state.artifacts`, or reusable sub-graphs. Switch to [`AgentGraph`](/features/agent-graph) when you need explicit conditional edges or programmatic graph construction.

---

## 4. Call Center over a WebSocket

A hierarchical agency behind a local WebSocket. With `voice.enabled: true`, `agency()` attaches a `listen()` method that starts a WebSocket server on `127.0.0.1`. Each client sends JSON text frames (`{ "text": "..." }`) and receives the agency's reply as `{ "text": "..." }`. `agency()` reads no other `voice` field: it runs no speech-to-text, text-to-speech or telephony. For audio, put the [Voice Pipeline](/features/voice-pipeline) or a [telephony provider](/features/telephony-providers) in front of the socket. `listen()` needs the `ws` package (`npm install ws`).

```typescript
import { agency } from '@framers/agentos';

const callCenter = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'hierarchical',
  // On the hierarchical strategy the agency-level instructions go to the
  // manager, which gets one delegate_to_<name> tool per roster agent.
  instructions: `
    You are a friendly receptionist. Greet the caller, find out the reason for
    the call, and delegate: "billing" for payment issues, "technical" for
    product problems, "sales" for new customer inquiries. Relay the answer.
  `,
  voice: { enabled: true },
  agents: {
    billing: {
      instructions: 'You are a billing specialist. Resolve payment issues calmly and efficiently.',
    },
    technical: {
      instructions: 'You are a technical support specialist. Diagnose and resolve product issues.',
    },
    sales: {
      instructions: 'You are a sales consultant. Help prospects find the right plan.',
    },
  },
});

const { url, close } = await callCenter.listen({ port: 8080 });

console.log(`Call center ready at ${url}`);

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});
```

---

## 5. Code Review Bot

Debate strategy: the roster agents argue for `maxRounds` rounds, then a synthesizer built from the agency-level provider, model and instructions gives the verdict.

```typescript
import { agency } from '@framers/agentos';
import { readFileSync } from 'fs';

const codeReviewer = agency({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  strategy: 'debate',
  maxRounds: 2,
  // Appended to the synthesizer's prompt after the last round.
  instructions: `
    You are a senior engineer making the final call on a code review.
    Weigh the critic's and the advocate's arguments and output one of:
    - APPROVE: code is production-ready
    - REQUEST_CHANGES: fixes are needed (list them)
    - REJECT: the approach is fundamentally flawed
  `,
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

Two agents over two rounds cost four debate calls plus the synthesis call.

---

## 6. Knowledge Base Q&A

Retrieval-augmented Q&A over a document store. The standalone `Memory` facade owns ingestion, storage and recall; the host calls `memory.recall()` and puts the hits into the prompt it sends.

```typescript
import { agent, Memory } from '@framers/agentos';

// 1. Build (or open) the persistent brain. `createSqlite` uses
//    `better-sqlite3` when that package is installed and falls back to sql.js;
//    `createPostgres(connectionString, { brainId })` opens Postgres.
const memory = await Memory.createSqlite({
  path: './brain.sqlite',
  graph: true,
  selfImprove: false,
});

// 2. Ingest a corpus once. Supports folders, single files, and URLs.
//    A document whose content hash is already stored is skipped on a re-run.
await memory.ingest('./docs/product');
await memory.ingest('./docs/api-reference');

// 3. Construct the answering agent. The KB pattern here is explicit
//    retrieval-then-inject: pull the top hits via `memory.recall()` and
//    feed them into `session.send()` as grounding context. The prompt
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
  const hits = await memory.recall(question, { limit: 5 });
  const context = hits
    .map(({ trace }, i) => `[${i + 1}] ${trace.id}\n${trace.content}`)
    .join('\n\n');
  return session.send(`Context:\n${context}\n\nQuestion: ${question}`);
}

console.log((await ask('How do I configure rate limiting in the AgentOS middleware?')).text);
console.log((await ask('What about for the voice pipeline specifically?')).text);

await memory.close();
```

> **Retrieval per turn without host code.** `standaloneMemory: { memory, longTermRetriever: true }` is an option of the full runtime (`AgentOS.create()`), which then retrieves from the same store on each `processRequest()` turn. `agent()` and `agency()` have no such option: with them, keep `memory.recall()` in your turn loop, which also shows you the chunks the model saw. See [Memory Operations](/features/memory-operations) for ingest and export options and [Multimodal RAG](/features/multimodal-rag) for image and audio sources.

---

## 7. Multi-Channel Support Bot

One agency answering on Discord, Slack and Telegram. `agency()` builds no channel adapters, so the host creates them and subscribes to their `message` events. Each adapter loads its platform SDK when it initializes (`discord.js`, `@slack/bolt`, `telegraf`), so install the ones you use.

```typescript
import { agency } from '@framers/agentos';
import {
  DiscordChannelAdapter,
  SlackChannelAdapter,
  TelegramChannelAdapter,
  type ChannelMessage,
  type IChannelAdapter,
} from '@framers/agentos/channels';

// 1. Create the agency
const supportBot = agency({
  provider: 'openai',
  strategy: 'sequential',
  agents: {
    greeter: {
      instructions: 'Restate the user\'s issue in one or two sentences.',
    },
    resolver: {
      instructions: 'Provide a clear, helpful resolution of the issue you receive.',
    },
  },
});

// 2. Connect to channels
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
  params: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
});
await telegram.initialize({
  platform: 'telegram',
  credential: process.env.TELEGRAM_BOT_TOKEN!,
  params: { botToken: process.env.TELEGRAM_BOT_TOKEN! },
});

// 3. Answer messages from any platform
function serve(adapter: IChannelAdapter) {
  adapter.on(async (event) => {
    const message = event.data as ChannelMessage;
    if (message.sender.isBot) return;

    // One agency session per conversation keeps that conversation's history.
    const session = supportBot.session(`${event.platform}:${event.conversationId}`);
    const response = await session.send(message.text);

    await adapter.sendMessage(event.conversationId, {
      blocks: [{ type: 'text', text: response.text }],
    });
  }, ['message']);
}

[discord, slack, telegram].forEach(serve);

console.log('Support bot listening on Discord, Slack, and Telegram...');
```

[`ChannelRouter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/ChannelRouter.ts) adds bindings between conversations and agents, group policies and per-conversation sessions on top of the adapters; its `onMessage` handlers run only for conversations that have a binding ([Channels](/features/channels)).

---

## 8. Automated Blog Publisher

Research, write, illustrate, then hand the result to your publishing code.

```typescript
import { agency, generateImage } from '@framers/agentos';

const writers = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  strategy: 'sequential',
  agents: {
    researcher: {
      instructions: 'List five facts about the topic that matter to the stated audience, one per line.',
    },
    writer: {
      instructions: `
        Write a 600-word Markdown blog post from the facts you receive:
        a headline, three sections with headers, and key takeaways.
      `,
    },
    social: {
      instructions: `
        Write social posts for the blog post you receive and return JSON:
        { "twitter": "<280 characters>", "linkedin": "<three bullet highlights>" }
      `,
    },
  },
});

// Host code: replace with your CMS and scheduler calls.
async function publishToCms(markdown: string, headerImage: string | undefined) {
  return 'https://example.com/blog/new-post';
}
async function scheduleSocial(postsJson: string, postUrl: string) {
  return { scheduled: true };
}

async function publishPost(topic: string, audience: string) {
  const run = await writers.generate(`Topic: ${topic}\nAudience: ${audience}`);

  // result.agentCalls holds every agent's output, in order.
  const post = run.agentCalls?.find((call) => call.agent === 'writer')?.output ?? '';
  const socialPosts = run.text;

  const image = await generateImage({
    provider: 'stability',
    model: 'stable-image-core',
    prompt: `A professional blog header image representing: ${topic}. Clean, modern style.`,
    aspectRatio: '16:9',
    providerOptions: {
      stability: { stylePreset: 'digital-art' },
    },
  });
  const header = image.images[0]?.url ?? image.images[0]?.dataUrl;

  const postUrl = await publishToCms(post, header);
  console.log('Published:', postUrl);
  console.log('Social posts:', await scheduleSocial(socialPosts, postUrl));
}

await publishPost(
  'How vector databases enable semantic search in AI applications',
  'software developers',
);
```

`generateImage()` takes `size` (`'1024x1024'`) or `aspectRatio` (`'16:9'`); it has no `width` or `height` option. To run the steps as a typed graph with tool nodes, use the [`workflow()` DSL](/features/workflow-dsl): a compiled workflow executes `tool` and `gmi` steps only when `compile({ deps })` receives the executors for them.

---

## 9. Runtime-Configured Tools

Direct [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) initialization with runtime-configured tools via
`createTestAgentOSConfig({ tools })`.

Runnable source: [`examples/agentos-config-tools.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agentos-config-tools.mjs)

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
        output: 'Approved for delivery:\n- Risk 1\n- Risk 2\n- Risk 3\n- Risk 4',
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
process.stdout.write('\n');

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

Runnable source: [`examples/agency-streaming.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agency-streaming.mjs)

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

Runnable source: [`examples/query-router.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router.mjs)

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

Runnable source: [`examples/query-router-host-hooks.mjs`](https://github.com/framerslab/agentos/blob/master/examples/query-router-host-hooks.mjs)

---

## 13. Per-Agent Identity via SOUL.md

Load an agent's identity from a markdown workspace. `agent({ soul })` puts the `SOUL.md` body at the head of the system prompt, followed by `STYLE.md` and the `memory/index.md` catalog. The loader also parses the YAML frontmatter (HEXACO scores, voice, mood, hard limits) into an [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts), which the full runtime takes as a persona; `agent()` does not read those fields. Compatible with the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md) and OpenClaw conventions.

Workspace layout (per agent):

```
~/.agentos/agents/aria/
├── SOUL.md       # identity, values, tone, hard limits (REQUIRED)
├── STYLE.md      # voice, syntax, vocabulary patterns (optional)
├── IDENTITY.md   # display card: name, role, agent-ID (optional; loaded, not used by the runtime)
├── AGENTS.md     # procedural rules (optional; loaded, not used by the runtime)
├── memory/       # long-term memory wiki: index.md + entities/ + concepts/ + log/ (auto-managed)
└── examples/     # good-outputs.md + bad-outputs.md (optional; not read)
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

// Direct file path — reads that file as SOUL.md and the companion files beside it
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

`agent({ soul })` does not read the `hexaco` scores; pass `personality` to give the agent its trait directives. On the full runtime the scores become the persona's `personalityTraits`. See [SOUL_FILES.md](../SOUL_FILES.md) for the full 6-file workspace spec.

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
import { agent } from '@framers/agentos';

// Stand-in for a real web-search tool (Tavily, Serper, Firecrawl, etc.).
// Replace with your real implementation.
const webSearchTool = {
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

## 15. Agency with a Sequential Hand-off

Three agents in one agency. `strategy: 'sequential'` runs the roster in
order; each agent after the first receives the original task followed by the
previous agent's output. Nothing else is shared: `agency()` builds no shared
memory store and runs no retrieval of its own (it accepts `memory` and `rag`
and applies neither; `injectRagContext()` returns the prompt unchanged because
no store is initialised), so what flows between agents is the text each one
returns.

```typescript
import { agency } from '@framers/agentos';

const team = agency({
  provider: 'openai',
  model: 'gpt-4o',
  strategy: 'sequential',
  agents: {
    researcher: { instructions: 'List the factual claims that matter for the comparison, one per line.' },
    writer:     { instructions: "Compose a two-paragraph briefing from the researcher's notes you receive." },
    reviewer:   { instructions: 'Review the briefing you receive: flag any claim that needs a source and any sentence a reader could misread.' },
  },
});

// Same .generate() surface as a single agent. The agency puts each
// agent's output into the next agent's prompt, under the original task;
// result.agentCalls lists who ran, in what order, with what input.
const result = await team.generate(
  'Compare QUIC and TCP for low-latency game networking.',
);
console.log(result.text);
console.log(result.agentCalls);
```

To give a roster memory, pass built agents as members: an
[`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) with a `memoryProvider` keeps its own hooks when it
sits in a roster. Cognitive memory and the RAG pipeline run on the full
runtime (see [Memory Model](../MEMORY_MODEL.md) and [Agencies](../AGENCIES.md)).

The companion runnable file
[`examples/agency-sequential-handoff.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agency-sequential-handoff.mjs)
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
import { agency } from '@framers/agentos';

// Stand-ins for the host-supplied tools each agent uses. Replace with real
// implementations (Tavily, arxiv-api, etc.).
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

## 17. Self-Improvement Tools on the Runtime

With `emergent: true` the full runtime gives every GMI the `forge_tool` meta-tool, and `emergentConfig.selfImprovement.enabled` adds `adapt_personality`, `manage_skills`, `create_workflow` and `self_evaluate`. The model decides when to call them; the limits below bound what a call can change.

> **These tools run on the full runtime.** `agent()` accepts `emergent` and logs that it does not apply it. On `agency()`, `emergent: { enabled: true }` with `strategy: 'hierarchical'` gives the manager `spawn_specialist`, which adds agents to the roster ([`examples/emergent-hierarchical-spawning.mjs`](https://github.com/framerslab/agentos/blob/master/examples/emergent-hierarchical-spawning.mjs)); it does not register the tools on this page.

```typescript
import { AgentOS, AgentOSResponseChunkType, BUILT_IN_PERSONAS } from '@framers/agentos';

const agentos = await AgentOS.create({
  personas: BUILT_IN_PERSONAS,
  emergent: true,
  emergentConfig: {
    selfImprovement: {
      enabled: true,
      personality: { maxDeltaPerSession: 0.15, persistWithDecay: true, decayRate: 0.05 },
      skills: { allowlist: ['*'], requireApprovalForNewCategories: true },
      workflows: { maxSteps: 10, allowedTools: ['*'] },
      selfEval: {
        autoAdjust: true,
        adjustableParams: ['temperature', 'verbosity', 'personality'],
        maxEvaluationsPerSession: 10,
      },
    },
  },
});

for await (const chunk of agentos.processRequest({
  userId: 'user-42',
  sessionId: 'story-1',
  selectedPersonaId: 'v_researcher',
  textInput: 'Help me write a creative story, and adapt your tone to mine as we go.',
})) {
  if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) process.stdout.write(chunk.textDelta);
}
```

Compose-mode `forge_tool` requests work as soon as `emergent` is on; code-forged tools stay off until `emergentConfig.allowSandboxTools` is set ([Emergent Capabilities](/features/emergent-capabilities)).

---

## Runnable Example Files

The `examples/` directory of the repository contains standalone `.mjs` files. They import the built package from `../dist`, so build once and run them with Node:

```bash
pnpm install && pnpm run build
node examples/<file>.mjs
```

| File | Description | Key APIs |
|------|-------------|----------|
| [`high-level-api.mjs`](../../examples/high-level-api.mjs) | One-shot text, streaming, image generation, agent sessions | `generateText`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts), `generateImage`, [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) |
| [`single-agent-briefing.mjs`](../../examples/single-agent-briefing.mjs) | Single-agent baseline before agency. One agent, no team, no shared state. | [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts), `.generate()` |
| [`agency-sequential-handoff.mjs`](../../examples/agency-sequential-handoff.mjs) | Three agents in a sequential hand-off: each agent's output, under the original task, is the next agent's input | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `strategy: 'sequential'`, `result.agentCalls` |
| [`emergent-hierarchical-spawning.mjs`](../../examples/emergent-hierarchical-spawning.mjs) | Hierarchical agency that mints a specialist at runtime when the static roster falls short | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `emergent`, `spawn_specialist`, [`EmergentAgentJudge`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentAgentJudge.ts) |
| [`agency-graph.mjs`](../../examples/agency-graph.mjs) | Multi-agent agency with the graph strategy: four agents in three dependency tiers, run with `generate()` and with `stream()` | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `dependsOn`, `result.agentCalls` |
| [`agency-streaming.mjs`](../../examples/agency-streaming.mjs) | The raw text stream, the `final-output` part and the approved final text of one `agency().stream()` run | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `textStream`, `fullStream`, `finalTextStream`, `hitl.approvals.beforeReturn` |
| [`agency-roundtable.mjs`](../../examples/agency-roundtable.mjs) | Multi-provider panel: six seats on four providers with per-seat reasoning effort, a chair that synthesizes, and a two-seat floor the script checks before the run | [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), `strategy: 'parallel'`, per-agent `provider` and `effort` |
| [`agent-graph.mjs`](../../examples/agent-graph.mjs) | An `AgentGraph` with a model node, a human node and a tool node, run on a stubbed node executor, interrupted at the human node and resumed from its checkpoint | [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts), `GraphRuntime.stream()` and `resume()`, `InMemoryCheckpointStore` |
| [`agent-communication-bus.mjs`](../../examples/agent-communication-bus.mjs) | Inter-agent messaging: a role-routed message, a request and its reply, a handoff and the message history | [`AgentCommunicationBus`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgentCommunicationBus.ts), `sendToRole`, `requestResponse`, `handoff` |
| [`workflow-dsl.mjs`](../../examples/workflow-dsl.mjs) | A workflow with a step, a branch, a parallel fan-out and a final step, run on a stubbed node executor | [`workflow`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts), sequential/parallel/conditional steps |
| [`mission-api.mjs`](../../examples/mission-api.mjs) | A mission compiled from a goal into the research plan template, with an anchored fact-check node, run on a stubbed node executor | [`mission`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts), `anchor()`, `explain()` |
| [`multi-agent-workflow.mjs`](../../examples/multi-agent-workflow.mjs) | Checks a four-task dependency list for cycles and prints the rounds in which its tasks become ready, in plain JavaScript, then makes one direct OpenAI API call | None: it calls no AgentOS API |
| [`query-router.mjs`](../../examples/query-router.mjs) | Question answering over a markdown corpus: classify, retrieve, generate, with the classification and retrieval hooks | [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts), `onClassification`, `onRetrieval` |
| [`query-router-host-hooks.mjs`](../../examples/query-router-host-hooks.mjs) | Query router with host-provided graph expansion, reranking and deep research | `QueryRouter`, `graphExpand`, `rerank`, `deepResearch` |
| [`generate-image.mjs`](../../examples/generate-image.mjs) | Image generation across providers | `generateImage`, provider selection |
| [`agentos-config-tools.mjs`](../../examples/agentos-config-tools.mjs) | The full runtime initialized with a tool from its config; the script fetches the tool from the orchestrator and runs it | [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), `createTestAgentOSConfig({ tools })`, `getToolOrchestrator().getTool()` |
| [`gmi-completion-gateway.mjs`](../../examples/gmi-completion-gateway.mjs) | A GMI built with a completion gateway: the primary fails before any output, a fallback hop serves the turn, and the script prints each `USAGE_UPDATE`, `STEP_FINISHED` and `TOOL_RESULT` chunk and the turn's usage total | [`createCompletionGateway`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/completionGateway.ts), [`GatewayProviderManager`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/gatewayProviderManager.ts), [`GMI`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMI.ts) `processTurnStream()` |
| [`schema-on-demand-local-module.mjs`](../../examples/schema-on-demand-local-module.mjs) | Loads an extension pack from a local module at run time through the `extensions_enable` meta-tool | [`createSchemaOnDemandPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/packs/schema-on-demand-pack.ts), [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts) |

---

## Related Guides

- [GETTING_STARTED.md](./GETTING_STARTED.md) — installation and first steps
- [ORCHESTRATION.md](../orchestration/ORCHESTRATION.md) — graphs, workflows, missions
- [CHANNELS.md](../features/CHANNELS.md) — channel setup
- [SOCIAL_POSTING.md](../features/SOCIAL_POSTING.md) — social media publishing
- [HIGH_LEVEL_API.md](./HIGH_LEVEL_API.md) — [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), helper wrappers, and runtime tool registration
- [COGNITIVE_MEMORY.md](../memory/COGNITIVE_MEMORY.md) — memory system
- [COGNITIVE_MEMORY.md#mechanism-implementation-reference](../memory/COGNITIVE_MEMORY.md#mechanism-implementation-reference) — 8 neuroscience-backed mechanisms (implementation reference)
- [IMAGE_GENERATION.md](../features/IMAGE_GENERATION.md) — image provider setup
- [EVALUATION.md](../observability/EVALUATION.md) — testing and benchmarking
- [AGENCY_API.md](../orchestration/AGENCY_API.md) — full agency reference
