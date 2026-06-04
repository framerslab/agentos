<div align="center">

<a href="https://agentos.sh">
  <img src="https://raw.githubusercontent.com/framerslab/agentos/master/assets/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS: TypeScript AI Agent Framework with Cognitive Memory" height="100" />
</a>

<br />

# **AgentOS** · TypeScript AI Agent Framework

**Agents that remember, forge their own tools, and survive long-running sessions.** Persistent cognitive memory, optional HEXACO personality, multi-agent orchestration, and one dispatch interface across 11 LLM providers. Apache-2.0.

[![npm](https://img.shields.io/npm/v/@framers/agentos?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/@framers/agentos)
[![CI](https://img.shields.io/github/actions/workflow/status/framerslab/agentos/ci.yml?branch=master&style=flat-square&logo=github&label=CI)](https://github.com/framerslab/agentos/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/framerslab/agentos/master/.github/badges/tests.json&style=flat-square&logo=vitest&logoColor=white)](https://github.com/framerslab/agentos/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/framerslab/agentos/graph/badge.svg)](https://codecov.io/gh/framerslab/agentos)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![LongMemEval-S](https://img.shields.io/badge/LongMemEval--S-85.6%25-2ea043?style=flat-square)](https://docs.agentos.sh/blog/2026/04/27/longmemeval-s-83-with-semantic-embedder)
[![LongMemEval-M](https://img.shields.io/badge/LongMemEval--M-70.2%25-2ea043?style=flat-square)](https://docs.agentos.sh/blog/2026/04/29/longmemeval-m-70-with-topk5)
[![agentos-bench](https://img.shields.io/badge/bench-public-blue?style=flat-square)](https://github.com/framerslab/agentos-bench)
[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?style=flat-square&logo=discord)](https://wilds.ai/discord)

[**Benchmarks**](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md) * [Website](https://agentos.sh) * [Docs](https://docs.agentos.sh) * [npm](https://www.npmjs.com/package/@framers/agentos) * [Discord](https://wilds.ai/discord) * [Blog](https://docs.agentos.sh/blog)

</div>

---

AgentOS is an open-source TypeScript framework for AI agents that **remember, adapt, and write their own tools**.

- **85.6% on [LongMemEval-S](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)** at $0.0090 per correct answer (gpt-4o reader): +1.4 points over Mastra OM gpt-4o (84.23%), 0.4 behind Emergence.ai's 86% closed-source SOTA.
- **70.2% on LongMemEval-M** (1.5M-token haystacks, 500 sessions per question): the only open-source library on the public record above 65% on M with publicly reproducible methodology.
- **Runtime tool forging.** An agent writes a TypeScript function with a Zod schema, an LLM judge approves it, and it runs in a hardened `node:vm` sandbox before joining the catalog for the rest of the session. Multi-agent teams spawn judge-reviewed specialists the same way.
- **Persistent [cognitive memory](https://docs.agentos.sh/features/cognitive-memory)** with 8 neuroscience-backed mechanisms: Ebbinghaus decay, retrieval-induced forgetting, reconsolidation, and source-confidence decay, grounded in published cognitive-science literature.
- **Optional [HEXACO personality](https://docs.agentos.sh/features/hexaco-personality)**, [six multi-agent orchestration strategies](https://docs.agentos.sh/features/multi-agent-collaboration), [streaming guardrails](https://docs.agentos.sh/features/guardrails-architecture), and a [voice pipeline](https://docs.agentos.sh/features/voice-pipeline), all on one dispatch interface across **11 LLM providers** (9 API-key + 2 local CLI; OpenRouter fans out to 200+ models).
- **[100+ first-party extensions](https://www.npmjs.com/package/@framers/agentos-extensions)** and **[88 curated `SKILL.md` skills](https://www.npmjs.com/package/@framers/agentos-skills)** auto-discover at startup; forged tools promote into skills via `SkillExporter`. **Apache-2.0.**

---

<div align="center">

<picture>
  <source srcset="https://raw.githubusercontent.com/framerslab/agentos/master/assets/agentos-forge-demo.webp" type="image/webp" />
  <img src="https://raw.githubusercontent.com/framerslab/agentos/master/assets/agentos-forge-demo.gif"
       alt="Three AgentOS agents with distinct HEXACO personalities collaborate on a code review, forge a new tool at runtime once they hit a gap their static toolkit can't cover, the LLM judge approves the spec, and all three invoke it on the next turn."
       width="900" />
</picture>

<sub>Runtime tool forging + multi-agent collaboration. Reproduce with <code>node <a href="https://github.com/framerslab/agentos/blob/master/examples/emergent-hierarchical-spawning.mjs">examples/emergent-hierarchical-spawning.mjs</a></code>.</sub>

</div>

---

## Install

```bash
npm install @framers/agentos
```

```typescript
import { agent } from '@framers/agentos';

const tutor = agent({
  provider: 'anthropic',                          // resolves to claude-sonnet-4-5-20250929 (provider default)
  // model: 'claude-opus-4-7',                    // pin a specific model to override the default
  instructions: 'You are a patient CS tutor.',
  personality: { openness: 0.9, conscientiousness: 0.95 },
  memory: { types: ['episodic', 'semantic'], working: { enabled: true } },
});

// Provider auto-detected from env when `provider` is omitted. Full default-model
// table for every supported provider: https://docs.agentos.sh/features/llm-providers

const session = tutor.session('student-1');
await session.send('Explain recursion with an analogy.');
await session.send('Can you expand on that?'); // remembers context
```

[Full quickstart](https://docs.agentos.sh/getting-started) * [Examples cookbook](https://docs.agentos.sh/getting-started/examples) * [API reference](https://docs.agentos.sh/api)

---

## Emergent Design

> "So we and our elaborately evolving computers may meet each other halfway."
>
>: Philip K. Dick, *The Android and the Human*, 1972

Three things accumulate across an AgentOS session and compose into behavior:

1. **Memory.** What was said, what was decided, what was retrieved.
2. **Tool surface.** Starts at whatever was registered. Can grow when an agent forges a new function mid-decision and the judge approves it.
3. **Personality** (optional). A HEXACO trait vector that biases retrieval, specialist routing, and decision-making.

Each is configurable and observable; none crosses into "emergent agent" on its own. The composition is the interesting part.

### Runtime Tool Forging

When an agent encounters a sub-task that no available tool covers, it generates a TypeScript function with a Zod-described input and output schema. A separate LLM call evaluates the forged function against the agent's stated intent and either approves or rejects it. Approved functions execute in a hardened `node:vm` sandbox with strict defaults (5-second wall clock, 128 MB heap-delta budget, `eval` / `require` / `process` banned, `fetch` / `fs` / `crypto` allowlist-empty by default). Approved tools join a discoverable index keyed by name and signature; subsequent turns invoke them via `call_forged_tool(name, args)`. First forge costs full LLM tokens; reuse costs tens of tokens. Sandbox internals, isolation tradeoffs (`node:vm` vs queued `isolated-vm` for the hosted multi-tenant tier), and the full safety policy are in the [emergent capabilities docs](https://docs.agentos.sh/features/emergent-capabilities).

The pattern the runtime supports: an agent forges a tool mid-decision, the judge approves it, that turn invokes it, and a few turns later a different specialist agent in the same session invokes the same tool because the index made it findable. Promoted tools can be exported as `SKILL.md` skills via `SkillExporter` and join the auto-discovery surface on the next process start.

### HEXACO Personality (optional)

Personality is opt-in. The runtime behaves identically with or without a trait vector, and most production deployments do not pass one.

```ts
// Personality-neutral (most production agents)
const support = agent({
  provider: 'openai',          // -> gpt-4o (provider default; `gpt-4o-mini` is the cheap-tier fallback)
  instructions: 'Resolve customer tickets.',
  memory: { types: ['episodic', 'semantic'] },
});

// Opt-in HEXACO (when persona consistency across sessions matters)
const coach = agent({
  provider: 'openai',          // -> gpt-4o
  instructions: "Long-running career coach. Hold the user accountable to their stated goals across weekly check-ins; flag drift, push back on excuses, escalate when goals shift.",
  personality: {
    conscientiousness: 0.9,    // won't let goals drift between sessions
    honesty: 0.85,             // honesty-humility: won't tell the user what they want to hear
    emotionality: 0.3,         // stays steady when the user is reactive
  },
  memory: { types: ['episodic', 'semantic'] },
});
```

When a vector is supplied, the kernel weights retrieval, specialist routing, and tool selection by the trait values. Same agent, same prompt, same tools: a high-Openness leader and a high-Conscientiousness leader produce measurably different decision sequences. Personality lives in the kernel, not in the prompt: prompt-only personality dissolves under context pressure while kernel-encoded bias persists. The vector remains editable, inspectable, and removable on consent.

### Soul Files (per-agent identity in markdown)

Identity, voice, hard limits, and HEXACO scores can live in a `SOUL.md` workspace alongside companion files (`STYLE.md`, `IDENTITY.md`, `AGENTS.md`, `memory/`, `examples/`). The runtime parses YAML frontmatter into structured config and injects the markdown body as the first system message: before instructions, skills, or chain-of-thought. Compatible with the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md) and OpenClaw conventions.

```ts
// Workspace path: loads SOUL.md + companion files from the directory
const aria = agent({
  provider: 'anthropic',       // -> claude-sonnet-4-5-20250929 (SOUL.md frontmatter `model:` overrides per-agent)
  soul: '~/.agentos/agents/aria',
});

// Inline content: for tests and ephemeral agents
const ephemeral = agent({
  provider: 'openai',          // -> gpt-4o
  soul: { content: SOUL_MARKDOWN_STRING },
});
```

The HEXACO frontmatter in `SOUL.md` flows into the same `PersonaDriftMechanism` and `PersonaOverlayManager` machinery as the inline `personality:` config above: the two paths produce identical runtime behavior. See [docs/SOUL_FILES.md](./docs/SOUL_FILES.md) for the full workspace spec, including the `memory/` wiki.

`memory/` is a markdown wiki (an `index.md` catalog plus `entities/`, `concepts/`, and `log/` pages) that is the agent's long-term memory: markdown is the source of truth, and the vector/graph index is rebuilt from it. [`souledAgent()`](./docs/getting-started/HIGH_LEVEL_API.md) wires it end to end in one call: the agent reads `index.md` from its prelude, opens pages with the `read_memory_page` tool, and folds new conversation back into pages on consolidation.

```ts
import { souledAgent } from '@framers/agentos';

const aria = await souledAgent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });
```

---

## Memory Benchmarks

`gpt-4o` reader, `gpt-4o-2024-08-06` judge, full N=500 across every row. Cross-provider numbers are excluded from the tables because their public methodology disclosures don't admit reproduction.

### LongMemEval-S (115K tokens, 50 sessions)

| System | Accuracy | $/correct | p50 latency |
|---|---:|---:|---:|
| EmergenceMem Internal | 86.0% | not published | 5,650 ms |
| **AgentOS** (canonical-hybrid + reader-router) | **85.6%** | **$0.0090** | **3,558 ms** |
| Mastra OM gpt-4o (gemini-flash observer) | 84.23% | not published | not published |
| Supermemory gpt-4o | 81.6% | not published | not published |
| EmergenceMem Simple Fast (rerun in agentos-bench) | 80.6% | $0.0586 | 3,703 ms |
| Zep (self / independent reproduction) | 71.2% / 63.8% | not published | not published |

+1.4 points above Mastra OM. EmergenceMem Internal posts 86.0% (0.4 above) but doesn't publish per-case results or a reproducible CLI; among open-source libraries with single-CLI reproduction at `gpt-4o`, 85.6% is the highest publicly reproducible number located. p50 latency 3,558 ms vs EmergenceMem's published median 5,650 ms.

Cross-provider numbers omitted from the table (different reader and/or undisclosed judge): Mastra OM 94.87% (gpt-5-mini + gemini-2.5-flash observer), agentmemory 96.2% (Claude Opus 4.6), MemMachine 93.0% (GPT-5-mini), Hindsight 91.4% (unspecified backbone).

### LongMemEval-M (1.5M tokens, 500 sessions)

M's haystacks exceed every production context window; most vendors only publish on S.

| System | Accuracy | License |
|---|---:|---|
| LongMemEval paper, GPT-4o round Top-10 (paper's best) | 72.0% | open repo |
| AgentBrain | 71.7% | closed-source SaaS |
| LongMemEval paper, GPT-4o session Top-5 | 71.4% | open repo |
| **AgentOS** (sem-embed + reader-router + Top-5) | **70.2%** | **Apache-2.0** |
| LongMemEval paper, GPT-4o round Top-5 | 65.7% | open repo |
| Mem0 v3, Mastra, Hindsight, Zep, EmergenceMem, Supermemory, Letta | not published |: |

At matched Top-5 retrieval, +4.5 above the round-level paper baseline (65.7%) and 1.2 below the session-level (71.4%); the paper's overall strongest GPT-4o result is 72.0% at Top-10. Of open-source libraries with publicly reproducible runs, AgentOS is the only one above 65% on M.

> **[Full leaderboard ->](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)** * **[Run JSONs ->](https://github.com/framerslab/agentos-bench/tree/master/results/runs)** * **[Transparency audit ->](https://agentos.sh/en/blog/memory-benchmark-transparency-audit/)** * **[LongMemEval paper](https://arxiv.org/abs/2410.10813)** (Wu et al., ICLR 2025, Table 3)

Methodology stack: bootstrap 95% CIs at 10k Mulberry32 resamples (seed 42), per-benchmark judge-FPR probes (S 1%, M 2%, LOCOMO 0%), per-case run JSONs, single-CLI reproduction. The [transparency audit](https://agentos.sh/en/blog/memory-benchmark-transparency-audit/) covers what the headline numbers don't: LOCOMO's ~6.4% answer-key error rate, the LongMemEval-S context-window confound, and the Mem0-vs-Zep comparison gaming case study, alongside which vendors disclose which methodology dimensions.

---

## Ecosystem

| Package | Role |
|---|---|
| [`@framers/agentos`](https://www.npmjs.com/package/@framers/agentos) | Core runtime: GMI agents, cognitive memory, multi-agent orchestration, guardrails, voice, 11 LLM providers. Apache 2.0. |
| [`@framers/agentos-extensions`](https://www.npmjs.com/package/@framers/agentos-extensions) | 100+ first-party extensions and templates: channel adapters, tool packs, integrations, guardrail packs. |
| [`@framers/agentos-extensions-registry`](https://www.npmjs.com/package/@framers/agentos-extensions-registry) | Discovery + auto-loader layer for the extensions catalog. Hosts pull the index without pulling every implementation; the runtime resolves and registers packs at startup. |
| [`@framers/agentos-skills`](https://www.npmjs.com/package/@framers/agentos-skills) | 88 curated `SKILL.md` skills covering common tasks. |
| [`@framers/agentos-skills-registry`](https://www.npmjs.com/package/@framers/agentos-skills-registry) | Discovery + auto-loader layer for the skills catalog. Also the surface where promoted forged tools land after `SkillExporter`. |
| [`@framers/agentos-bench`](https://github.com/framerslab/agentos-bench) | Open benchmark harness. Bootstrap 95% CIs at 10k resamples, judge false-positive-rate probes, per-case run JSONs at fixed seed. MIT (the rest of AgentOS is Apache 2.0). |
| [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter) | Cross-platform SQL persistence: SQLite, Postgres, IndexedDB, Capacitor SQLite. |
| [`paracosm`](https://www.npmjs.com/package/paracosm) | AI agent swarm simulation engine that uses AgentOS as its substrate. |
| [`wunderland`](https://www.npmjs.com/package/wunderland) | Sister project (preview): batteries-included CLI plus daemon over the AgentOS extension and skill registries. 28-command CLI, 5-tier security, 8 agent presets, step-up HITL. Apache-2.0. |

**Extensions and skills auto-load at startup.** The runtime walks each registry plus any user-supplied paths, resolves each pack's `createExtensionPack(context)` factory or `SKILL.md` frontmatter, and registers tools, guardrails, channels, and skills without manual wiring. Capability gating and HITL approval gates apply to side-effecting installs. See [extensions architecture](https://docs.agentos.sh/architecture/extension-loading) for the full loading model.

---

## 📄 Technical Whitepaper * Coming Soon

The full architecture and benchmark methodology, written for engineers and researchers who want a citable PDF instead of scrolling docs. Cognitive memory pipeline, classifier-driven dispatch, HEXACO personality modulation, runtime tool forging, full LongMemEval-S/M and LOCOMO benchmark methodology with confidence interval math, judge-FPR probes, per-stage retention metrics, and reproducibility recipes.

| Covers | What's inside |
|---|---|
| **Architecture** | Generalized Mind Instances, IngestRouter / MemoryRouter / ReadRouter, 8 cognitive mechanisms with primary-source citations |
| **Benchmarks** | LongMemEval-S 85.6%, LongMemEval-M 70.2%, vendor landscape, confidence interval methodology, judge FPR probes, full transparency stack |
| **Reproducibility** | Per-case run JSONs at `--seed 42`, single-CLI reproduction, Apache-2.0 bench at [github.com/framerslab/agentos-bench](https://github.com/framerslab/agentos-bench) |

**[Join Discord for the announcement ->](https://wilds.ai/discord)** * **[Read the benchmarks now ->](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)**

---

## Classifier-Driven Memory Pipeline

Most memory libraries retrieve on every query. AgentOS gates memory through three LLM-as-judge classifiers in a single shared pass, so trivial queries skip retrieval entirely and the rest get the right architecture and reader per category.

```
User query
    │
    ▼ Stage 1: QueryClassifier (gpt-5-mini, ~$0.0001/query)
    │    T0=none ─────► answer from context, skip retrieval
    │    T1+=needs memory
    ▼ Stage 2: MemoryRouter      -> canonical-hybrid * OM-v10 * OM-v11
    ▼ Stage 3: ReaderRouter      -> gpt-4o (TR/SSU) * gpt-5-mini (SSA/SSP/KU/MS)
    ▼
Grounded answer
```

Stages 2 and 3 reuse the Stage 1 classification, so the full pipeline costs **one classifier call per query**, not three. **The T0 / no-memory gate is the novel piece**: removing retrieval entirely for greetings and small talk saves the embedding + rerank + reader cost on a substantial fraction of typical agent traffic.

| Primitive | Source | Decision |
|---|---|---|
| `QueryClassifier` | [`@framers/agentos/query-router`](https://docs.agentos.sh/features/query-routing) | T0/none vs T1/simple vs T2/moderate vs T3/complex |
| `MemoryRouter` | [`@framers/agentos/memory-router`](https://docs.agentos.sh/features/memory-router) | canonical-hybrid vs observational-memory-v10 vs v11 |
| `ReaderRouter` | [`@framers/agentos/memory-router`](https://docs.agentos.sh/features/memory-router) | gpt-4o vs gpt-5-mini per category |

[Cognitive Memory docs ->](https://docs.agentos.sh/features/cognitive-memory) * [Cognitive Pipeline ->](https://docs.agentos.sh/features/cognitive-pipeline) * [Memory System Overview ->](https://docs.agentos.sh/features/memory-system-overview)

---

## Why AgentOS

| vs. | AgentOS differentiator |
|---|---|
| **LangChain / LangGraph** | Cognitive memory ([8 neuroscience-backed mechanisms](https://docs.agentos.sh/features/cognitive-memory)), HEXACO personality, runtime tool forging |
| **Vercel AI SDK** | Multi-agent teams (6 strategies), 7 vector backends, [guardrails](https://docs.agentos.sh/features/guardrails-architecture), voice/telephony |
| **CrewAI / Mastra** | Unified orchestration (DAGs + graphs + missions), personality-driven routing, **published reproducible numbers on LongMemEval-S (85.6%) and LongMemEval-M (70.2%) with full methodology disclosure** |

[Full framework comparison ->](https://docs.agentos.sh/blog/2026/02/20/agentos-vs-langgraph-vs-crewai)

---

## Key Features

| Category | Highlights |
|---|---|
| **LLM Providers** | 11 (9 API-key + 2 local CLI): OpenAI, Anthropic, Gemini, Groq, Ollama, OpenRouter, Together, Mistral, xAI, Claude CLI, Gemini CLI. Plus image/video/audio generation providers. |
| **Cognitive Memory** | 8 mechanisms: reconsolidation, retrieval-induced forgetting, involuntary recall, FOK, gist extraction, schema encoding, source decay, emotion regulation |
| **HEXACO Personality** | 6 traits modulate memory, retrieval bias, response style |
| **RAG Pipeline** | 7 vector backends * 4 retrieval strategies * GraphRAG * HyDE * Cohere rerank-v3.5 |
| **Multi-Agent Teams** | 6 coordination strategies * shared memory * inter-agent messaging * HITL gates |
| **Orchestration** | `workflow()` DAGs * `AgentGraph` cycles * `mission()` goal-driven planning * checkpointing |
| **Guardrails** | 5 security tiers * 6 packs (PII, ML classifiers, topicality, code safety, grounding, content policy) |
| **Emergent Capabilities** | Runtime tool forging * 4 self-improvement tools * tiered promotion * skill export |
| **Voice & Telephony** | ElevenLabs, Deepgram, Whisper * Twilio, Telnyx, Plivo |
| **Channels** | 37 platform adapters (Telegram, Discord, Slack, WhatsApp, webchat, ...) |
| **Observability** | OpenTelemetry * usage ledger * cost guard * circuit breaker |

---

## Multi-Agent in 6 Lines

```typescript
import { agency } from '@framers/agentos';

const team = agency({
  strategy: 'graph',
  agents: {
    researcher: { provider: 'anthropic', instructions: 'Find relevant facts.' },                            // -> claude-sonnet-4-5-20250929
    writer:     { provider: 'openai',    instructions: 'Summarize clearly.', dependsOn: ['researcher'] },   // -> gpt-4o
    reviewer:   { provider: 'gemini',    instructions: 'Check accuracy.',    dependsOn: ['writer'] },       // -> gemini-2.5-flash
  },
});

const result = await team.generate('Compare TCP vs UDP for game networking.');
```

Strategies: `sequential` * `parallel` * `debate` * `review-loop` * `hierarchical` * `graph`. With `strategy: 'hierarchical'` + `emergent: { enabled: true }`, the manager LLM gets a `spawn_specialist` tool that mints new sub-agents at runtime when the static roster doesn't cover a sub-task. `agency()` is for single-request multi-agent coordination: for long-running world simulations or per-turn parallel agent loops, build your own orchestration with `agent()` + the lower-level primitives. [Multi-agent docs ->](https://docs.agentos.sh/features/multi-agent) * [Hierarchical + emergent ->](https://docs.agentos.sh/architecture/emergent-agency-system) * [Scope guide ->](https://docs.agentos.sh/orchestration/agency-api#scope-when-to-reach-for-agency)

---

## Grounded Q&A in 8 Lines

`QueryRouter` is the one-call grounded answer pipeline. Point it at markdown directories, ask a question, get back the answer plus the sources it pulled from, the tier path it took, and any fallback strategies it activated. Use it instead of hand-wiring chunker + vector store + classifier + retriever + LLM call + citation collection for every Q&A surface in your app.

```typescript
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  availableTools: ['web_search', 'deep_research'],
  verifyCitations: true,
});

await router.init();

const result = await router.route('how do I configure a guardrail?');
console.log(result.answer);          // grounded answer text
console.log(result.sources);         // citations with title + URI + snippet
console.log(result.classification);  // { tier: 0|1|2|3, strategy, confidence, reasoning }
console.log(result.tiersUsed);       // which tiers actually fired
console.log(result.grounding);       // per-claim verdicts when verifyCitations is on
```

The router classifies each query into a tier (T0 trivial -> T3 deep research), retrieves only as much context as that tier needs, and degrades gracefully to keyword search if no embedding key is configured. 260 platform-knowledge entries (tools, skills, FAQ, API, troubleshooting) are bundled with `@framers/agentos` and merged into your corpus automatically. [Query Router docs ->](https://docs.agentos.sh/features/query-routing)

---

## Per-Claim Citation Verification on Any Agent

For agents you build directly with `agent()` (no router), set `verifyCitations` and every generation comes back with per-claim verdicts attached. No second pass, no manual `verifier.verify(text, sources)` plumbing:

```typescript
import { agent } from '@framers/agentos';

const docsAgent = agent({
  provider: 'openai',
  model: 'gpt-4o',
  verifyCitations: {
    embedFn:  (texts) => embeddingManager.embedBatch(texts),
    retrieve: (query) => retriever.search(query),
  },
});

const result = await docsAgent.generate('How do I configure a guardrail?');
console.log(result.text);
console.log(result.grounding?.overallGrounded);    // single boolean: safe to ship?
for (const claim of result.grounding?.claims ?? []) {
  if (claim.verdict !== 'supported') console.warn(claim);
}
```

The agent calls your `retrieve` hook before generation to fetch sources, runs the model, then decomposes the response into atomic claims and scores each against the sources via cosine similarity (with optional NLI for contradiction detection). Verdicts: `supported`, `weak`, `unverifiable`, `contradicted`. Reach for the low-level [`CitationVerifier`](https://docs.agentos.sh/features/citation-verification) directly only when you own both sides of the generate/retrieve pair yourself.

When you do reach for it directly, `verifier.verify(input, sources)` takes two shapes: raw text (lets the verifier decompose into claims itself) or a pre-decomposed `string[]` of claims (skips internal extraction, scores each item as-is). Use the array shape when you've already split the prose with your own parser or want to verify a curated subset; use the string shape when you have one block of LLM output and want the built-in sentence splitter / configured `extractClaims` LLM decomposer to handle it. `verifier.extractClaims(text)` exposes the same decomposition path the string form uses, so you can inspect / filter the claim list before scoring.

---

## See It In Action

### 🌀 Paracosm: AI Agent Swarm Simulation

Define any scenario as JSON. Run it with AI commanders that have different HEXACO personalities. Same starting conditions, different decisions, divergent civilizations. Built on AgentOS.

```bash
npm install paracosm
```

[Live Demo](https://paracosm.agentos.sh/sim) * [GitHub](https://github.com/framerslab/paracosm) * [npm](https://www.npmjs.com/package/paracosm)

---

## Configure API Keys

Three layers, highest priority first:

```typescript
// 1. Inline on the call (per-tenant, per-test, per-customer)
generateText({ apiKey: 'sk-customer', prompt: '...' });

// 2. Module-level default: set once at boot, no .env needed
import { setDefaultProvider } from '@framers/agentos';
setDefaultProvider({ provider: 'openai', apiKey: process.env.MY_OWN_KEY });

// 2b. Reorder the env-var auto-detect chain instead (when you keep multiple keys)
import { setProviderPriority } from '@framers/agentos';
setProviderPriority(['anthropic', 'openai', 'ollama']);

// 3. Environment variable auto-detect chain (default order)
//    OpenRouter -> OpenAI -> Anthropic -> Gemini -> Groq -> Together -> Mistral
//    -> xAI -> claude CLI -> gemini CLI -> Ollama -> image providers
```

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...

# Comma-separated keys auto-rotate with quota detection
export OPENAI_API_KEY=sk-key1,sk-key2,sk-key3
```

[Full credential resolution + default models per provider ->](https://docs.agentos.sh/architecture/llm-providers)

---

## API Surfaces

- **`agent()`**: lightweight stateful agent. Prompts, sessions, personality, hooks, tools, memory.
- **`agency()`**: multi-agent teams + full runtime. Emergent tooling, guardrails, RAG, voice, channels, HITL.
- **`generateText()` / `streamText()` / `generateObject()` / `generateImage()` / `generateVideo()` / `generateMusic()` / `performOCR()` / `embedText()`**: low-level multi-modal helpers with native tool calling.
- **`workflow()` / `AgentGraph` / `mission()`**: three orchestration authoring APIs over one graph runtime.

Provider fallback is an explicit opt-in via `agent({ fallbackProviders: [...] })` (or `buildFallbackChain()` for programmatic chains). Defaults to off: the runtime never silently retries against a different provider unless you configured a chain.

[Full API reference ->](https://docs.agentos.sh/api) * [High-Level API guide ->](https://docs.agentos.sh/getting-started/high-level-api)

### Tuning generation knobs

Per-LLM-call knobs live on a flat namespace. Override chain runs **per-call → per-agent → provider default**.

| Knob | Where you set it | What it does |
|---|---|---|
| `maxTokens` | `agent({ maxTokens })` / `generate(prompt, { maxTokens })` / `generateText({ maxTokens })` / `generateObject({ maxTokens })` | Caps completion tokens per call. Provider defaults: Anthropic **16000** (was 4096 pre-`0.9.13`; raised so Claude 4 tool-use responses don't truncate mid-JSON), OpenAI 4096, Gemini 8192. |
| `temperature` | Same surfaces | 0-2; lower = deterministic, higher = creative. Opus 4.7 ignores this — extended-thinking models use their own sampler. |
| `maxSteps` | `agent({ maxSteps })` | Caps the inner tool-use loop per `.generate()`. Default `5`. Keep low (3-5) when an outer scheduler also iterates; tool latency multiplies by steps. |
| `controls.maxTotalTokens` | `agent({ controls: { maxTotalTokens } })` | Hard ceiling on input + output combined per turn; full-runtime `agency()` enforces it. |
| `controls.maxDurationMs` | Same | Hard wall-clock cap per turn; surfaces as a thrown error rather than letting the API hang. |
| `fallbackProviders` | `agent({ fallbackProviders })` | Ordered chain of `{ provider, model? }` entries the runtime walks on retryable errors. |
| `provider` / `model` | `agent({ provider, model })` or pass `"provider/model"` to any generate helper | Routing. Slash form auto-detects when prefix matches a known provider id. |

```ts
// Pin defaults at agent construction:
const writer = agent({
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  instructions: 'Write punchy product copy.',
  maxTokens: 2000,
  temperature: 0.7,
});

// Override on a specific call when one response needs more room:
const longform = await writer.generate('Draft a 4-page whitepaper.', {
  maxTokens: 16000,
});
```

Caveat: `generateObject()` auto-derives a sane default for `maxTokens` from the Zod schema shape when omitted — Boolean schemas land ~50 tokens, large array-of-object schemas land ~8k. Explicit `maxTokens` overrides the estimate.

---

## Documentation & Community

- **[Benchmarks](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)**: benchmark tables, 95% confidence intervals, methodology audit
- **[Architecture](https://docs.agentos.sh/architecture/system-architecture)**: system design, layer breakdown
- **[Cognitive Memory](https://docs.agentos.sh/features/cognitive-memory)**: 8 mechanisms with 30+ APA citations
- **[RAG Configuration](https://docs.agentos.sh/features/rag-memory-configuration)**: vector stores, embeddings, sources
- **[Guardrails](https://docs.agentos.sh/features/guardrails-architecture)**: 5 tiers, 6 packs
- **[Voice Pipeline](https://docs.agentos.sh/features/voice-pipeline)**: TTS, STT, telephony
- **[Blog](https://docs.agentos.sh/blog)**: engineering posts, benchmark publications, transparency audits
- **[Discord](https://wilds.ai/discord)** * **[GitHub Issues](https://github.com/framerslab/agentos/issues)** * **[Wilds.ai](https://wilds.ai)** (AI game worlds powered by AgentOS)

---

## Contributing

```bash
git clone https://github.com/framerslab/agentos.git && cd agentos
pnpm install && pnpm build && pnpm test
```

We use [Conventional Commits](https://www.conventionalcommits.org/). Project guides:

| Guide | What |
|---|---|
| [Contributing](https://github.com/framerslab/agentos/blob/master/CONTRIBUTING.md) | Dev setup, PR checklist, commit conventions, contribution licensing |
| [Adding an LLM provider](https://github.com/framerslab/agentos/blob/master/docs/contributing/new-provider.md) | Provider interface, acceptance checklist, vendor-neutrality policy |
| [Maintainers](https://github.com/framerslab/agentos/blob/master/MAINTAINERS.md) | Who reviews and merges changes |
| [Code of Conduct](https://github.com/framerslab/agentos/blob/master/.github/CODE_OF_CONDUCT.md) | Community standards |
| [Security Policy](https://github.com/framerslab/agentos/blob/master/.github/SECURITY.md) | Reporting vulnerabilities privately |
| [Support](https://github.com/framerslab/agentos/blob/master/SUPPORT.md) | Where to get help |
| [Sponsors](https://github.com/framerslab/agentos/blob/master/SPONSORS.md) | Funding and the vendor-neutral placement policy |

---

## Startups & Partnerships

AgentOS is Apache-2.0 and free. The provider list is decided on technical merit and stays neutral, and placement there is never sold. Companies engage through partner startup programs, sponsorship, or a provider integration. See [SPONSORS.md](./SPONSORS.md).

### Programs & partners

| Partner | Type | Provides | Since |
|:-:|:--|:--|:-:|
| [![Deepgram](https://img.shields.io/badge/Deepgram-13EF93?style=for-the-badge&logo=deepgram&logoColor=000000)](https://deepgram.com/startups) | Startup Program | Speech-to-text + text-to-speech credits, go-to-market | 2026 |

### Ways to engage

| Track | What it is | Where |
|:--|:--|:--|
| **Sponsor** | Fund development. Disclosed logo placement + release-notes credit. | [SPONSORS.md](./SPONSORS.md) |
| **Provider integration** | Ship your model or API as a supported provider. Free, on technical merit. | [Provider guide](./docs/contributing/new-provider.md) |

Interested? Email team@frame.dev.

---

## License

[Apache 2.0](./LICENSE)

<div align="center">

<a href="https://agentos.sh">
  <img src="https://raw.githubusercontent.com/framerslab/agentos/master/assets/agentos-primary-transparent-2x.png" alt="AgentOS" height="40" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://frame.dev">
  <img src="https://raw.githubusercontent.com/framerslab/agentos/master/assets/frame-logo-green-no-tagline.svg" alt="Frame.dev" height="40" />
</a>

**Built by [Frame](https://frame.dev) * [Wilds.ai](https://wilds.ai)**

</div>
