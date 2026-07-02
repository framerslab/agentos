# @framers/agentos Documentation

<p align="center">
  <a href="https://agentos.sh"><img src="../assets/agentos-primary-transparent-2x.png" alt="AgentOS" height="80" /></a>
</p>

<p align="center">
  <strong>Modular orchestration runtime for adaptive AI systems</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@framers/agentos"><img src="https://img.shields.io/npm/v/@framers/agentos?logo=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/framerslab/agentos"><img src="https://img.shields.io/github/stars/framerslab/agentos?style=social" alt="GitHub stars"></a>
  <a href="https://agentos.sh"><img src="https://img.shields.io/badge/docs-agentos.sh-00d4ff" alt="Documentation"></a>
</p>

---

## Documentation Index

### Getting Started

- [**Getting Started Guide**](./getting-started/GETTING_STARTED.md) — Install, env setup, and 3 levels (1 line → 3 lines → 5 lines)
- [**README**](../README.md) — Installation and quick start
- [**High-Level API**](./getting-started/HIGH_LEVEL_API.md) — `generateText()`, `streamText()`, `generateImage()`, `generateVideo()`, `analyzeVideo()`, `generateMusic()`, `generateSFX()`, `performOCR()`, `agent()`, and `agency()`
- [**Examples Cookbook**](./getting-started/EXAMPLES.md) — 12 complete runnable examples, including QueryRouter host hooks and finalized agency streaming
- [**CHANGELOG**](../CHANGELOG.md) — Version history and release notes

### Architecture & Core Concepts

- [**Architecture Overview**](./architecture/ARCHITECTURE.md) — Complete system architecture and design principles

### Features & Capabilities

#### Planning & Orchestration

- [**Orchestration Guide**](./orchestration/ORCHESTRATION.md) — Graphs, workflows, missions, voice nodes, checkpointing, YAML authoring
- [**Unified Orchestration Layer**](./orchestration/UNIFIED_ORCHESTRATION.md) — One runtime, three authoring APIs ([`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts), `workflow()`, `mission()`)
- [**AgentGraph**](./architecture/AGENT_GRAPH.md) — Full graph builder with typed nodes, conditional edges, and subgraphs
- [**workflow() DSL**](./orchestration/WORKFLOW_DSL.md) — Deterministic DAG pipelines with branching and parallel joins
- [**mission() API**](./orchestration/MISSION_API.md) — Goal-first orchestration driven by the PlanningEngine
- [**Checkpointing**](./orchestration/CHECKPOINTING.md) — Resume, fork, replay, and memory consistency semantics
- [**Planning Engine**](./orchestration/PLANNING_ENGINE.md) — Multi-step task planning and execution
- [**Human-in-the-Loop**](./safety/HUMAN_IN_THE_LOOP.md) — Approval workflows and human oversight
- [**Agent Communication**](./architecture/AGENT_COMMUNICATION.md) — Inter-agent messaging and coordination

#### Safety & Security

- [**Guardrails System**](./safety/GUARDRAILS_USAGE.md) — Two-phase guardrail dispatch, built-in packs (PII, ML classifiers, topicality, code safety, grounding), and folder-level filesystem permissions
- [**Safety Primitives**](./safety/SAFETY_PRIMITIVES.md) — Circuit breakers, cost guards, stuck detection, and tool execution guards

#### Memory & Storage

- [**Cognitive Memory**](./memory/COGNITIVE_MEMORY.md) — Personality-modulated memory with Ebbinghaus decay, Baddeley's working memory, spreading activation, HEXACO-driven encoding, and the consolidation loop
- [**RAG Memory Configuration**](./memory/RAG_MEMORY_CONFIGURATION.md) — Vector storage and retrieval setup
- [**SQL Storage Quickstart**](./getting-started/SQL_STORAGE_QUICKSTART.md) — Database integration guide
- [**Client-Side Storage**](./memory/CLIENT_SIDE_STORAGE.md) — Browser-based persistence
- [**Immutable Agents**](./safety/IMMUTABLE_AGENTS.md) — Sealing lifecycle, toolset pinning, secret rotation, and soft-forget
- [**Provenance Guide**](./safety/PROVENANCE.md) — HashChain, ChainVerifier, BundleExporter, proof levels, external anchors
- [**Provenance & Immutability**](./safety/PROVENANCE_IMMUTABILITY.md) — Sealed storage policy, signed ledger, and anchoring

#### AI & LLM

- [**Structured Output**](./orchestration/STRUCTURED_OUTPUT.md) — JSON schema validation and structured generation
- [**Streaming Semantics**](./architecture/STREAMING_SEMANTICS.md) — Raw live chunks vs finalized approved output across `textStream`, `fullStream`, `text`, and `finalTextStream`
- [**Evaluation Guide**](./observability/EVALUATION.md) — Test cases, graders, LLM-as-judge, A/B testing, experiment tracking
- [**Evaluation Framework**](./observability/EVALUATION_FRAMEWORK.md) — Testing, scoring, and quality assurance
- [**Query Router**](./QUERY_ROUTER.md) — Tiered query classification, retrieval routing, keyword fallback, and grounded answer generation
- [**Image Generation Guide**](./features/IMAGE_GENERATION.md) — Provider-agnostic image generation across cloud and local backends
- [**Capability Discovery Guide**](./extensions/DISCOVERY.md) — Three-tier semantic discovery, CAPABILITY.yaml, meta-tool
- [**Capability Discovery**](./extensions/CAPABILITY_DISCOVERY.md) — Full architecture reference
- [**Cost Optimization**](./safety/COST_OPTIMIZATION.md) — Token usage and API cost management

#### Extensions & Customization

- [**RFC Extension Standards**](./extensions/RFC_EXTENSION_STANDARDS.md) — Extension development guidelines
- [**Recursive Self-Building Agents**](./architecture/RECURSIVE_SELF_BUILDING_AGENTS.md) — Advanced agent patterns
- [**Skills (SKILL.md)**](./extensions/SKILLS.md) — Prompt modules loaded from directories/registries

#### Channels & Social

- [**Channels Guide**](./features/CHANNELS.md) — Multi-channel adapters with setup for Discord, Slack, Telegram, Twitter, and WhatsApp
- [**Social Posting Guide**](./features/SOCIAL_POSTING.md) — SocialPostManager, content adaptation, scheduling, analytics

### Platform & Infrastructure

- [**Platform Support**](./architecture/PLATFORM_SUPPORT.md) — Supported environments and requirements
- [**Observability (OpenTelemetry)**](./observability/OBSERVABILITY.md) — Tracing, metrics, and log correlation/export (opt-in)
- [**Logging (Pino + OpenTelemetry)**](./observability/LOGGING.md) — Structured logs, trace correlation, and OTEL LogRecord export (opt-in)

### Ecosystem

- [**Ecosystem**](./architecture/ECOSYSTEM.md) — Related packages, extensions, and resources
- [**Releasing**](./getting-started/RELEASING.md) — Automated release process

### API Reference

- [**TypeDoc API**](./api/index.html) — Auto-generated API documentation

---

## Quick Links

| Resource    | Link                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| Website     | [agentos.sh](https://agentos.sh)                                       |
| GitHub      | [framerslab/agentos](https://github.com/framerslab/agentos)              |
| npm         | [@framers/agentos](https://www.npmjs.com/package/@framers/agentos)     |
| Issues      | [GitHub Issues](https://github.com/framerslab/agentos/issues)           |
| Discussions | [GitHub Discussions](https://github.com/framerslab/agentos/discussions) |

---

## How to Use This Documentation

1. **New to AgentOS?** Start with the [README](../README.md) for installation and basic usage
2. **Understanding the system?** Read the [Architecture Overview](./architecture/ARCHITECTURE.md)
3. **Building features?** Check the relevant feature guide (Planning, HITL, Guardrails, etc.)
4. **API details?** Browse the [TypeDoc API Reference](./api/index.html)
5. **Troubleshooting?** See [Platform Support](./architecture/PLATFORM_SUPPORT.md)

---

<p align="center">
  <sub>Built by <a href="https://frame.dev">Frame.dev</a> · <a href="https://github.com/framerslab">@framerslab</a></sub>
</p>
