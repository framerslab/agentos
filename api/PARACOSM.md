---
title: "Paracosm: Agent Swarm Simulation for Structured World Modeling with LLMs"
sidebar_position: 1
description: "Paracosm — open-source TypeScript agent-swarm simulation engine on AgentOS. JSON-defined worlds, HEXACO-typed leaders, deterministic kernel, divergent futures from one seed. Reproducible, forkable, replayable. Mars Genesis reference scenario ships in the box."
keywords: [paracosm, agent swarm simulation, structured world model, llm world model, hexaco simulation, deterministic kernel, digital twin, counterfactual simulation, mars genesis, multi-agent simulation, agentos]
---

:::tip Full API reference lives at [paracosm.agentos.sh/docs](https://paracosm.agentos.sh/docs)
This page is the AgentOS-side overview. For the complete paracosm API reference, scenario authoring guide, and dashboard docs, go to **[paracosm.agentos.sh/docs](https://paracosm.agentos.sh/docs)**.
:::

Paracosm is an **open-source structured world-model engine for LLM agent swarms**, built on AgentOS. Type a scenario in natural language; Paracosm compiles it into a typed world; runs multiple AI decision-makers through the same deterministic kernel; lets you replay, fork, and compare how the futures diverge.

**Same world. Same crises. Different agents. Different future.**

Start from a prompt, brief, URL, or scenario JSON draft; compile or ground it into a typed [`ScenarioPackage`](https://github.com/framerslab/paracosm/blob/master/src/engine/types.ts); pick leaders with different [HEXACO](/features/cognitive-memory) personality profiles; and watch their swarms — leader plus five specialist departments plus ~100 personality-typed cells — diverge into measurably different trajectories from an identical seed. The reference scenario ships as Mars Genesis: a 100-colonist Mars settlement running from 2035 to 2083 across six turns.

![Two world-model paths: native/visual outputs pixels; structured/LLM-based outputs typed JSON state](/img/diagrams/paracosm-world-model-split.svg)

![Per-turn 9-stage flow with LLM and deterministic lanes](/img/diagrams/paracosm-turn-flow.svg)

![Same Mars Genesis seed, Visionary vs Engineer leader, divergent trajectories and metrics](/img/diagrams/paracosm-divergence.svg)

## Two world-model paths: the visual one and the structured one

The world-model literature ([Xing 2025](https://arxiv.org/abs/2507.05169), [ACM CSUR 2025 survey](https://dl.acm.org/doi/full/10.1145/3746449), [Yang et al 2026](https://openreview.net/forum?id=XmYCERErcD)) has converged on a clean split between two ways AI systems represent how a slice of reality changes over time:

**1. Native / visual world models.** Output is pixels or spatial latents the system generates from scratch. The model learns a compressed predictive representation of the physical world directly from video, sensor data, or simulator output, and rolls it forward by predicting the next frame or scene. Sora, Genie 3, and World Labs Marble are the visual cohort; LeCun's JEPA / AMI Labs work is the predictive-representation cohort. Output you can watch on a screen. Cost is in compute, training data, and the model never having a typed handle on "what just happened."

**2. Structured / LLM-based world models.** Output is typed JSON state plus structured deltas. The model — usually an LLM — reasons about a scenario contract (departments, agents, events, metrics) and emits the next state symbolically. Yang et al 2026 evaluates this class on policy verification, action proposal, and policy planning. Output you can query, fork, replay, and feed into another agent's tool. Cost is in prompt cycles, schema validation, and the model never having a way to "see" the world.

Pixels are what humans watch. State is what agents reason inside.

**Paracosm is in the second class — and is among the first open-source production-grade implementations of it.** It is a prompt/document/URL-grounded, JSON-contract-backed state space + deterministic seeded kernel + LLM-driven events and specialist analyses + HEXACO-personality leaders directing a swarm of ~100 personality-typed cells + universal Zod-validated run artifact spanning turn-loop civilization simulations, batch-trajectory digital twins, and batch-point forecasts.

It is **not** a visual / native world model (Sora, Genie 3, World Labs Marble), **not** a JEPA-style predictive-representation model, **not** a multi-agent task orchestration framework (LangGraph, AutoGen, CrewAI, OpenAI Agents SDK), **not** a bottom-up emergent-crowd simulator (OASIS, MiroFish), and **not** a generative-agents library (Stanford Generative Agents, Google DeepMind Concordia). It is a structured world model: typed contract first, LLM second, deterministic kernel underneath.

JSON is the canonical contract, not the product boundary. `compileScenario()` takes a scenario JSON draft plus optional `seedText` or `seedUrl` grounding. The Quickstart wrapper takes one prompt or document, asks an LLM to propose the same scenario contract, validates it, then compiles and runs it.

The full structured-world-model framing is in the [Structured World Models for AI Agents](https://agentos.sh/blog/paracosm-2026-overview) blog post. Full taxonomy mapping lives at [docs/positioning/world-model-mapping.md](https://github.com/framerslab/paracosm/blob/master/docs/positioning/world-model-mapping.md).

**[Live demo](https://paracosm.agentos.sh/sim)** · **[paracosm docs](https://paracosm.agentos.sh/docs)** · **[GitHub](https://github.com/framerslab/paracosm)** · **[npm](https://www.npmjs.com/package/paracosm)** · **[Positioning map](https://github.com/framerslab/paracosm/blob/master/docs/positioning/world-model-mapping.md)** · **[Case study blog post](https://agentos.sh/blog/inside-mars-genesis-ai-colony-simulation)**

## Quick Start

```bash
npm install paracosm
```

```typescript
import { WorldModel, marsScenario } from 'paracosm';

const aria = {
  name: 'Aria Chen',
  archetype: 'The Visionary',
  unit: 'Colony Alpha',
  hexaco: {
    openness: 0.95, conscientiousness: 0.35, extraversion: 0.85,
    agreeableness: 0.55, emotionality: 0.30, honestyHumility: 0.65,
  },
  instructions: '',
};

const result = await WorldModel.fromScenario(marsScenario).simulate({
  actor: aria,
  keyPersonnel: [],
  maxTurns: 6,
  seed: 950,
  onEvent: e => console.log(e.type, e.data?.title),
});

console.log(result.finalState?.metrics.population);
console.log(result.forgedTools?.length ?? 0);
```

Or run the hosted demo at [paracosm.agentos.sh/sim](https://paracosm.agentos.sh/sim) with zero setup. The demo caps turns, population, and model tier so public access stays affordable; paste your own OpenAI or Anthropic key into Settings to unlock full scope.

## The universal result contract

Every `WorldModel.simulate()` call returns a Zod-validated [`RunArtifact`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts) exported from the `paracosm/schema` subpath. One shape covers three simulation modes, discriminated on `metadata.mode`:

- `turn-loop`: civilization sims (paracosm's built-in mode). Populates `trajectory.timepoints[]` and `decisions[]` with per-turn specialist notes.
- `batch-trajectory`: digital-twin simulations. Labeled timepoints over a horizon, populated by external LangGraph-style executors.
- `batch-point`: one-shot forecasts. Overview and risk flags only, no trajectory.

```typescript
import { RunArtifactSchema, type RunArtifact } from 'paracosm/schema';
import { WorldModel } from 'paracosm';

const artifact: RunArtifact = await WorldModel.fromScenario(scenario).simulate({
  actor: leader,
  keyPersonnel: [],
  ...opts,
});
const parsed = RunArtifactSchema.parse(artifact); // optional runtime validation

switch (artifact.metadata.mode) {
  case 'turn-loop':
  case 'batch-trajectory':
  case 'batch-point':
}

artifact.trajectory?.timepoints?.forEach((tp) => {
  console.log(tp.label, tp.score?.value, tp.narrative);
});
```

The schema exposes 13 content primitives ([`RunMetadata`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`WorldSnapshot`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`SwarmAgent`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`SwarmSnapshot`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`Score`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`HighlightMetric`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`Timepoint`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`TrajectoryPoint`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`Trajectory`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`Citation`](https://github.com/framerslab/paracosm/blob/master/src/runtime/contracts.ts), [`SpecialistDetail`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`SpecialistNote`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`RiskFlag`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`Decision`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts)) plus operational types ([`Cost`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts), [`ProviderError`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/errors/ProviderError.ts)). Every primitive carries an optional `scenarioExtensions?: Record<string, unknown>` escape hatch for domain-specific fields that must not pollute the universal shape.

Non-TypeScript consumers generate equivalent types from JSON Schema: `npm run export:json-schema` emits `schema/run-artifact.schema.json` and `schema/stream-event.schema.json`. Python projects use `datamodel-codegen`; any ecosystem with a JSON-Schema code generator adopts cleanly.

### Subjects and interventions

For simulations built around a single subject (a person, character, organism, vessel) under a counterfactual intervention, `paracosm/schema` exposes [`SubjectConfig`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts) and [`InterventionConfig`](https://github.com/framerslab/paracosm/blob/master/src/engine/schema/types.ts) as first-class input primitives. Pass them through [`RunOptions`](https://github.com/framerslab/paracosm/blob/master/src/api/types.ts) and they carry through to `RunArtifact.subject` and `RunArtifact.intervention` for downstream consumers:

```typescript
import { SubjectConfigSchema, InterventionConfigSchema } from 'paracosm/schema';

const subject = SubjectConfigSchema.parse({
  id: 'user-42',
  name: 'Alice',
  profile: { age: 34, diet: 'mediterranean' },
  signals: [{ label: 'HRV', value: 48.2, unit: 'ms', recordedAt: '2026-04-21T08:00:00Z' }],
  markers: [{ id: 'rs4680', category: 'genome', value: 'AA' }],
});

const intervention = InterventionConfigSchema.parse({
  id: 'intv-1',
  name: 'Creatine + Sleep Hygiene',
  description: '5g daily + 11pm bedtime.',
  duration: { value: 12, unit: 'weeks' },
  adherenceProfile: { expected: 0.7 },
});

const artifact = await WorldModel.fromScenario(scenario).intervene({
  actor: leader,
  subject,
  intervention,
});
```

Turn-loop mode stashes both verbatim without semantic consumption; external batch-trajectory executors populate them from their own flow.

### Inspecting the agent swarm

Every turn-loop run produces a swarm: ~100 named agents with departments, roles, family edges, mood, and short-term memory. Read it from `RunArtifact.finalSwarm`, or import focused helpers from the dedicated `paracosm/swarm` subpath:

```typescript
import {
  getSwarm,
  swarmByDepartment,
  swarmFamilyTree,
  moodHistogram,
  departmentHeadcount,
  aliveCount,
  deathCount,
} from 'paracosm/swarm';
import type { SwarmAgent, SwarmSnapshot } from 'paracosm/schema';

const swarm = getSwarm(artifact);
if (swarm) {
  console.log(`T${swarm.turn} · ${aliveCount(swarm)} alive · ${deathCount(swarm)} dead`);
  console.log(moodHistogram(swarm));        // { focused: 12, anxious: 5, ... }
  console.log(departmentHeadcount(swarm));  // { engineering: 18, agriculture: 22, ... }

  for (const [dept, agents] of Object.entries(swarmByDepartment(artifact))) {
    console.log(dept, agents.length);
  }

  const family = swarmFamilyTree(artifact);  // parent agentId -> [child agentIds]
}
```

Or hit the lightweight HTTP endpoint when you only need the roster, not the full artifact:

```bash
curl https://paracosm.agentos.sh/api/v1/runs/$RUN_ID/swarm
```

The dashboard's living-swarm grid streams the same shape every turn via the SSE `systems_snapshot` event, so visualization, analytics, and replay all share one swarm contract.

## What it does

Paracosm runs two leaders through the same scenario in parallel and makes their divergence measurable. Each turn has nine stages (the per-turn flow diagram at the top of this page shows the two lanes), alternating between LLM reasoning (HEXACO-prompted, divergent) and a deterministic kernel (seeded, replayable):

| Stage | Kind | Responsibility |
|-------|------|----------------|
| Event Director | LLM | Observes state, generates events |
| Kernel advance | det. | Aging, births, deaths, resource deltas |
| Department analysis | LLM | Each dept may forge or reuse a tool |
| Commander decision | LLM | Reads all reports, picks an option |
| Outcome | det. | Seeded RNG + option risk probability |
| Effects | det. | Colony deltas via the EffectRegistry |
| Agent reactions | LLM | Every alive agent reacts in parallel |
| Memory | det. | Short-term consolidates, stances drift |
| Personality drift | det. | HEXACO traits shift under three forces |

Two runs on the same seed produce identical deterministic stages. The LLM stages diverge because every prompt carries the leader's HEXACO profile and the accumulated state it shaped. The asymmetry is the entire point, and the divergence diagram at the top of this page shows it on Mars Genesis: the same seed under a Visionary vs Engineer leader produces different final-state metrics.

## How HEXACO drives decisions

Paracosm uses the [HEXACO model](/features/cognitive-memory) (Ashton & Lee, 2007) across all six axes, with both poles producing concrete behavioral cues in the commander's decision-style block and the department analysis prompts:

- **Openness.** High: favor novel, untested approaches. Low: trust proven protocols.
- **Conscientiousness.** High: demand evidence and contingency plans. Low: move fast, accept ambiguity.
- **Extraversion.** High: lead from the front with public comms. Low: work through technical channels.
- **Agreeableness.** High: seek consensus with departments and Earth. Low: override consensus when you see a better path.
- **Emotionality.** High: weigh human cost heavily. Low: accept casualties for strategic gain.
- **Honesty-Humility.** High: report failures transparently. Low: leverage information asymmetries.

Trait thresholds are 0.7 (high) and 0.3 (low); cues only fire when a trait is meaningfully expressed. Visible in action at [departments.ts:90](https://github.com/framerslab/paracosm/blob/master/src/runtime/departments.ts#L90) and [commander-setup.ts:30](https://github.com/framerslab/paracosm/blob/master/src/runtime/commander-setup.ts#L30).

## Emergent tool forging + reuse

Department agents forge computational tools at runtime using AgentOS's [`EmergentCapabilityEngine`](/features/emergent-capabilities). The `forge_tool` meta-tool builds, tests, and judge-reviews a new tool; the `call_forged_tool` meta-tool lets a later turn invoke that already-approved tool on new inputs without re-forging.

Personality drives the ratio. High-Openness leaders bias exploratory and forge more novel tools. High-Conscientiousness leaders bias conservative and reuse whenever an existing tool fits. On the same seed, the Visionary ends a six-turn run with a wider toolbox; the Engineer ends with a narrower toolbox but higher reuse count. The blog post walks through this as a case study: [Inside Mars Genesis](https://agentos.sh/blog/inside-mars-genesis-ai-colony-simulation).

Cost follows. Reuse via `call_forged_tool` costs essentially nothing; every fresh forge costs a judge LLM call plus sandbox execution. The reuse economy is the single biggest lever on total run cost.

## Scenario authoring

Any domain works. Mars colonies, submarine habitats, space stations, medieval kingdoms. The engine is domain-agnostic; the compiled scenario contract defines what gets simulated.

```json
{
  "id": "mars-genesis",
  "labels": { "name": "Mars Genesis", "populationNoun": "colonists", "settlementNoun": "colony", "timeUnitNoun": "year", "timeUnitNounPlural": "years" },
  "setup": { "defaultTurns": 6, "defaultSeed": 950, "defaultStartTime": 2035 },
  "departments": [
    { "id": "medical", "label": "Medical", "role": "Chief Medical Officer", "instructions": "..." },
    { "id": "engineering", "label": "Engineering", "role": "Chief Engineer", "instructions": "..." }
  ],
  "metrics": [
    { "id": "population", "format": "number" },
    { "id": "morale", "format": "percent" }
  ]
}
```

`compileScenario()` turns a scenario JSON draft plus optional `seedText` / `seedUrl` grounding into a runnable [`ScenarioPackage`](https://github.com/framerslab/paracosm/blob/master/src/engine/types.ts) by generating TypeScript hook functions via LLM calls. Compilation costs about $0.10 per scenario and caches to disk. See [`compileScenario`](/paracosm/paracosm/compiler/functions/compileScenario) for the full hook contract.

## Cost safety

The hosted demo uses three layered guards so public access stays affordable:

1. **Demo caps** when `PARACOSM_HOSTED_DEMO=true`: 6 turns (configurable), 30 colonists, 3 active departments, cheapest model tier. Settings UI locks the capped inputs and unlocks the moment a user pastes their own API key.
2. **Per-IP rate limit**: one simulation per IP per day for demo-mode requests, JSON-persisted across restarts.
3. **Abort gates**: when all SSE clients disconnect for longer than 1.5 seconds, an AbortController fires and the runtime checks it before every LLM call in the turn. At most one in-flight call completes after a tab closes.

Users who want more runs paste their own OpenAI or Anthropic key. The dashboard's cost modal breaks down per-stage spend (director, commander, dept-by-name, judge, reactions) so the reuse economy's impact on total cost is visible.

## API surface

```typescript
import type { ScenarioPackage, Agent, HexacoProfile } from 'paracosm';
import type { ActorConfig } from 'paracosm';
import {
  WorldModel,
  run,
  runMany,
  marsScenario,
  lunarScenario,
} from 'paracosm';
import { SimulationKernel, SeededRng } from 'paracosm/core';
import { compileScenario } from 'paracosm/compiler';
import {
  RunArtifactSchema,
  StreamEventSchema,
  SubjectConfigSchema,
  InterventionConfigSchema,
  type RunArtifact,
  type StreamEvent,
  type SubjectConfig,
  type InterventionConfig,
} from 'paracosm/schema';
```

Full type reference is auto-generated from source at [/paracosm](/paracosm). The core types:

- [`ScenarioPackage`](/paracosm/paracosm/interfaces/ScenarioPackage): domain-agnostic scenario bundle
- [`ActorConfig`](https://github.com/framerslab/paracosm/blob/master/src/cli/types.ts): commander identity plus HEXACO profile (or pluggable `traitProfile`); imported from `paracosm`
- [`HexacoProfile`](/paracosm/paracosm/core/interfaces/HexacoProfile): six-axis personality vector
- [`SimulationKernel`](/paracosm/paracosm/core/classes/SimulationKernel): deterministic state machine
- `WorldModel.simulate`: single-actor turn loop, returns `Promise<RunArtifact>`
- `run` / `runMany`: prompt, URL, or precompiled scenario quickstarts from the root export
- [`compileScenario`](/paracosm/paracosm/compiler/functions/compileScenario): turns a scenario draft plus optional source grounding into a runnable [`ScenarioPackage`](https://github.com/framerslab/paracosm/blob/master/src/engine/types.ts)

## HTTP + SSE server

The dashboard server exposes a small HTTP API for driving sims from any client:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/setup` | Start a new simulation with leaders, turns, seed |
| `GET` | `/events` | SSE stream of simulation events |
| `POST` | `/clear` | Clear simulation state and chat agent pool |
| `POST` | `/chat` | Chat with a colonist agent |
| `GET` | `/results` | Full simulation results including verdict |
| `GET` | `/rate-limit` | Check rate limit status |
| `POST` | `/compile` | Compile a custom scenario draft with optional `seedText` / `seedUrl` grounding |
| `GET` | `/admin-config` | Hosted-demo flags + effective caps |

`/events` replays a buffered event history on reconnect (persisted to disk so restarts do not evaporate completed runs), closes with a `replay_done` marker so clients can distinguish historical from live events.

The SSE stream emits a 17-variant [`StreamEvent`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/types.ts) discriminated union (defined in `paracosm/schema`), every event carrying a universal `e.data.summary` one-liner so consumers can render cleanly without narrowing on per-event fields:

```
turn_start, event_start, specialist_start, specialist_done, forge_attempt,
decision_pending, decision_made, outcome, personality_drift, agent_reactions,
bulletin, turn_done, promotion, systems_snapshot, provider_error,
validation_fallback, sim_aborted
```

Narrow via `e.type` for per-event intellisense on `e.data`. Validate the envelope at runtime with `StreamEventSchema.parse(evt)` when ingesting untrusted streams.

## Related

- [Emergent Capabilities](/features/emergent-capabilities): the forge + judge machinery underlying `forge_tool`
- [HEXACO Personality](/features/cognitive-memory): trait model, mutation system, persona overlays
- [Cognitive Memory](/features/cognitive-memory): the memory pipeline colonists use as chat agents
- [Inside Mars Genesis (blog)](https://agentos.sh/blog/inside-mars-genesis-ai-colony-simulation): full case study with the two-leader-one-seed comparison
- [Paracosm 2026 Overview (blog)](https://agentos.sh/blog/paracosm-2026-overview): structured-world-model framing
