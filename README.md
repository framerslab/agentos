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

- **Top open-source memory benchmarks:** [85.6% on LongMemEval-S](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md) at $0.0090/correct (gpt-4o), and 70.2% on LongMemEval-M, the only open-source library above 65% on M with reproducible methodology.
- **Runtime tool forging.** An agent writes a TypeScript function with a Zod schema, an LLM judge approves it, and it runs in a hardened `node:vm` sandbox before joining the catalog for the rest of the session.
- **Persistent [cognitive memory](https://docs.agentos.sh/features/cognitive-memory)** with 8 neuroscience-backed mechanisms: Ebbinghaus decay, retrieval-induced forgetting, reconsolidation, source-confidence decay.
- **Optional [HEXACO personality](https://docs.agentos.sh/features/hexaco-personality)**, [6 orchestration strategies](https://docs.agentos.sh/features/agency-collaboration), [guardrails](https://docs.agentos.sh/features/guardrails-architecture), and [voice](https://docs.agentos.sh/features/voice-pipeline) across **11 LLM providers**; 100+ extensions and 88 skills auto-load at startup.

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
  provider: 'anthropic',                          // resolves to claude-sonnet-4-6 (provider default)
  // model: 'claude-opus-4-8',                    // pin a specific model to override the default
  instructions: 'You are a patient CS tutor.',
  personality: { openness: 0.9, conscientiousness: 0.95 },
  memory: { types: ['episodic', 'semantic'], working: { enabled: true } },
});

// Provider auto-detected from env when `provider` is omitted.

const session = tutor.session('student-1');
await session.send('Explain recursion with an analogy.');
await session.send('Can you expand on that?'); // remembers context
```

[Full quickstart](https://docs.agentos.sh/getting-started) * [Examples cookbook](https://docs.agentos.sh/getting-started/examples) * [API reference](https://docs.agentos.sh/api)

---

## Emergent Design

Three things accumulate across a session and compose into behavior: **memory** (what was said, decided, retrieved), the **tool surface** (which grows when an agent forges a tool the judge approves), and an optional **HEXACO personality** vector that biases retrieval, routing, and decisions. Each is configurable and observable.

**Runtime tool forging.** When no tool covers a sub-task, the agent writes a TypeScript function with a Zod schema; a separate LLM judge approves it; it runs in a hardened `node:vm` sandbox (5s wall clock, no `eval`/`require`/`process`), then joins a discoverable index for the rest of the session. First forge costs full tokens; reuse costs tens. Promoted tools export as `SKILL.md` skills. [Emergent capabilities ->](https://docs.agentos.sh/features/emergent-capabilities)

**HEXACO personality (optional).** Off by default; the runtime behaves identically without it. When supplied, the kernel weights retrieval, specialist routing, and tool selection by trait values, so the same prompt and tools yield measurably different decision sequences. It lives in the kernel, not the prompt, so it persists under context pressure. [HEXACO docs ->](https://docs.agentos.sh/features/hexaco-personality)

**Soul files.** Identity, voice, hard limits, and HEXACO scores can live in a `SOUL.md` workspace. Its `memory/` directory is a markdown wiki (an `index.md` catalog plus `entities/`, `concepts/`, `log/` pages with `[[wikilinks]]`) that *is* the agent's long-term memory: markdown is the source of truth, the vector/graph index is rebuilt from it, and [`souledAgent()`](https://docs.agentos.sh/getting-started/high-level-api) wires it end to end. [Soul Files ->](https://docs.agentos.sh/features/soul-files)

```ts
import { souledAgent } from '@framers/agentos';

const aria = await souledAgent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });
```

---

## Memory Benchmarks

`gpt-4o` reader, `gpt-4o-2024-08-06` judge, full N=500, single-CLI reproduction with bootstrap 95% CIs and per-benchmark judge-FPR probes.

- **LongMemEval-S: 85.6%** at $0.0090/correct, 3,558 ms p50: +1.4 points over Mastra OM gpt-4o (84.23%), 0.4 behind Emergence.ai's closed-source 86%. The highest publicly reproducible open-source number at `gpt-4o`.
- **LongMemEval-M: 70.2%** (1.5M-token haystacks, 500 sessions): the only open-source library above 65% on M with reproducible methodology.

[Full leaderboard ->](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md) * [Transparency audit ->](https://agentos.sh/en/blog/memory-benchmark-transparency-audit/) * [LongMemEval paper](https://arxiv.org/abs/2410.10813) (Wu et al., ICLR 2025)

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
    researcher: { provider: 'anthropic', instructions: 'Find relevant facts.' },                            // -> claude-sonnet-4-6
    writer:     { provider: 'openai',    instructions: 'Summarize clearly.', dependsOn: ['researcher'] },   // -> gpt-4o
    reviewer:   { provider: 'gemini',    instructions: 'Check accuracy.',    dependsOn: ['writer'] },       // -> gemini-2.5-flash
  },
});

const result = await team.generate('Compare TCP vs UDP for game networking.');
```

Strategies: `sequential`, `parallel`, `debate`, `review-loop`, `hierarchical`, `graph`. With `hierarchical` + `emergent: { enabled: true }`, the manager forges new sub-agents at runtime. [Multi-agent docs ->](https://docs.agentos.sh/features/agency-api)

---

## Ecosystem

| Package | Role |
|---|---|
| [`@framers/agentos`](https://www.npmjs.com/package/@framers/agentos) | Core runtime: agents, cognitive memory, orchestration, guardrails, voice, 11 LLM providers. Apache-2.0. |
| [`@framers/agentos-extensions`](https://www.npmjs.com/package/@framers/agentos-extensions) | 100+ first-party extensions: channel adapters, tool packs, integrations, guardrail packs. |
| [`@framers/agentos-extensions-registry`](https://www.npmjs.com/package/@framers/agentos-extensions-registry) | Discovery + auto-loader for the extensions catalog. |
| [`@framers/agentos-skills`](https://www.npmjs.com/package/@framers/agentos-skills) | 88 curated `SKILL.md` skills. |
| [`@framers/agentos-skills-registry`](https://www.npmjs.com/package/@framers/agentos-skills-registry) | Discovery + auto-loader for skills; where promoted forged tools land. |
| [`@framers/agentos-bench`](https://github.com/framerslab/agentos-bench) | Open benchmark harness: bootstrap 95% CIs, judge-FPR probes, per-case run JSONs. MIT. |
| [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter) | Cross-platform SQL persistence: SQLite, Postgres, IndexedDB, Capacitor SQLite. |
| [`paracosm`](https://www.npmjs.com/package/paracosm) | AI agent swarm simulation on AgentOS. [Live demo](https://paracosm.agentos.sh/sim). |
| [`wunderland`](https://www.npmjs.com/package/wunderland) | Batteries-included CLI + daemon over the AgentOS registries (preview). Apache-2.0. |

Extensions and skills auto-load at startup. [Extensions architecture ->](https://docs.agentos.sh/architecture/extension-loading)

---

## Configure API Keys

Three layers, highest priority first: inline `apiKey` on the call, a module-level `setDefaultProvider()` at boot, or environment-variable auto-detection (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the rest, resolved in priority order and reorderable with `setProviderPriority([...])`). Comma-separated keys auto-rotate on quota.

[Full credential resolution + default models per provider ->](https://docs.agentos.sh/architecture/llm-providers)

---

## API Surfaces

- **`agent()`**: lightweight stateful agent. Prompts, sessions, personality, hooks, tools, memory.
- **`agency()`**: multi-agent teams + full runtime. Emergent tooling, guardrails, RAG, voice, channels, HITL.
- **`generateText()` / `streamText()` / `generateObject()` / `generateImage()` / `generateVideo()` / `generateMusic()` / `performOCR()` / `embedText()`**: low-level multi-modal helpers with native tool calling.
- **`workflow()` / `AgentGraph` / `mission()`**: three orchestration authoring APIs over one graph runtime.

Provider fallback is an explicit opt-in via `agent({ fallbackProviders: [...] })`; the runtime never silently retries against a different provider unless you configure a chain.

[Full API reference ->](https://docs.agentos.sh/api) * [High-Level API guide ->](https://docs.agentos.sh/getting-started/high-level-api)

---

## Documentation & Community

- **[Benchmarks](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md)**: benchmark tables, 95% confidence intervals, methodology audit
- **[Architecture](https://docs.agentos.sh/architecture/system-architecture)**: system design, layer breakdown
- **[Cognitive Memory](https://docs.agentos.sh/features/cognitive-memory)**: 8 mechanisms with 30+ APA citations
- **[RAG Configuration](https://docs.agentos.sh/features/rag-memory)**: vector stores, embeddings, sources
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

AgentOS is Apache-2.0 and free. We integrate any quality provider on technical merit, and partners and sponsors are featured in the README and docs, labeled as such. Companies engage through partner startup programs, sponsorship, or a provider integration. See [SPONSORS.md](./SPONSORS.md).

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
