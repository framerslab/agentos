---
title: "HEXACO Personality"
sidebar_position: 1.5
description: "How HEXACO trait vectors shape encoding, working-memory capacity, retrieval bias, prompt formatting, observer/reflector behavior, and runtime self-modification across the AgentOS memory system. Six trait dimensions, opt-in, character-driven simulation ready."
keywords: [hexaco personality llm, ai agent personality, agent trait modeling, persona overlay, character ai consistency, big five vs hexaco, ashton lee 2007, agentos persona, trait-modulated retrieval, roleplay agent]
---

# HEXACO Personality

> Six trait dimensions, each in the range [0, 1], that bias every memory and reasoning surface in AgentOS. The same input encodes differently, the same context retrieves differently, the same response generates differently depending on who is doing the remembering.

Personality is **opt-in**. The runtime behaves identically with or without a trait vector, and most production deployments do not pass one. Use it when persona consistency across sessions matters: roleplay agents, character-driven simulations, multi-specialist teams that need behavioral differentiation, or research probes where you want to vary the encoder rather than the input.

![HEXACO trait radar showing three sample personas](/img/diagrams/hexaco-radar.svg)

![Personality vector propagating through five system surfaces](/img/diagrams/hexaco-propagation.svg)

![Encoding-weight ramps for the two HEXACO formula families](/img/diagrams/hexaco-encoding-weights.svg)

---

## Why HEXACO

The HEXACO model (Ashton & Lee, 2007) is a six-factor taxonomy of personality structure derived from cross-cultural lexical studies. Compared to the Big Five, HEXACO splits Honesty-Humility out as its own dimension, which empirically captures variance the Big Five conflates into Agreeableness. For an agent runtime, that split matters: an agent that is highly cooperative (high Agreeableness) but strategically self-serving (low Honesty) behaves differently from one that is both cooperative and sincere. The runtime models them independently because they produce different memory and conflict-resolution behaviors.

The six dimensions:

| Trait | Range | Captures |
|---|---|---|
| **Honesty-Humility** | 0-1 | Sincerity, fairness, modesty. Low values = strategically diplomatic; high = transparent and direct. |
| **Emotionality** | 0-1 | Emotional reactivity, empathy, anxiety. Low = matter-of-fact; high = empathetic and tone-aware. |
| **eXtraversion** | 0-1 | Sociability, energy, assertiveness. Low = reflective; high = engaged and proactive. |
| **Agreeableness** | 0-1 | Patience, tolerance, cooperation. Low = challenge-oriented; high = harmony-seeking. |
| **Conscientiousness** | 0-1 | Discipline, thoroughness, reliability. Low = flexible/improvisational; high = structured/systematic. |
| **Openness to experience** | 0-1 | Curiosity, creativity, willingness to explore. Low = conventional/practical; high = exploratory. |

Each value defaults to neutral (0.5). Values between 0.35 and 0.65 are treated as "moderate" and produce no explicit behavioral directives — the runtime only emits trait-specific instructions when a value crosses 0.65 or 0.35 in either direction. This avoids over-constraining the model on mid-range values.

The radar at the top of this page shows three example trait vectors. Trait *combinations* matter more than individual extremes — the same `openness: 0.9` reads differently when paired with high conscientiousness (rigorous explorer) vs low conscientiousness (creative provocateur).

---

## Quickstart

```ts
import { agent } from '@framers/agentos';

const coach = agent({
  provider: 'anthropic',
  instructions: 'You are a personal coach helping users build daily habits.',
  personality: {
    openness: 0.85,           // creative, exploratory framing
    conscientiousness: 0.80,  // structured, follow-through-oriented
    emotionality: 0.65,       // tone-aware without being clinical
    agreeableness: 0.55,      // moderate, willing to push back
    extraversion: 0.50,       // neutral
    honesty: 0.75,            // transparent, no spin
  },
  memory: {
    types: ['episodic', 'semantic'],
    working: { enabled: true },
  },
});

const session = coach.session('user-1');
await session.send('Help me build a morning routine.');
```

That single `personality` object propagates through five system surfaces simultaneously. Each is documented below with its source.

---

## How traits propagate

The propagation diagram at the top of this page shows the five surfaces a HEXACO vector touches. Each is detailed below.

### 1. System prompt directives

`buildPersonalityDescription(traits)` in [`agent.ts`](https://github.com/framersai/agentos/blob/master/src/api/agent.ts) emits a `## Personality & Communication Style` section appended to the agent's system prompt. Each trait at > 0.65 or < 0.35 produces a specific instruction. Moderate values (0.35-0.65) are omitted.

| Trait > 0.65 | Trait < 0.35 |
|---|---|
| **Honesty:** "Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly." | **Honesty:** "Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages." |
| **Emotionality:** "Respond with emotional awareness and empathy. Acknowledge feelings. Express concern when appropriate." | **Emotionality:** "Maintain emotional composure. Be matter-of-fact and solution-oriented." |
| **Extraversion:** "Be energetic and engaging. Use vivid language. Take initiative. Offer suggestions proactively." | **Extraversion:** "Be measured and reflective. Listen more than you speak. Prefer depth over breadth." |
| **Agreeableness:** "Prioritize harmony and cooperation. Validate the other perspective before offering alternatives." | **Agreeableness:** "Be direct and challenge-oriented. Question assumptions. Push back when something seems wrong." |
| **Conscientiousness:** "Be thorough and systematic. Structure responses clearly. Prefer precision over speed." | **Conscientiousness:** "Be flexible and adaptive. Prioritize the big picture. Tolerate ambiguity and improvise." |
| **Openness:** "Explore creative angles and unconventional ideas. Draw unexpected connections." | **Openness:** "Stick to proven approaches and established knowledge. Be practical and concrete." |

Source: [`packages/agentos/src/api/agent.ts:386`](https://github.com/framersai/agentos/blob/master/src/api/agent.ts#L386).

### 2. Memory encoding strength

Traits derive six attention weights that scale how strongly an incoming trace is encoded.

```ts
// packages/agentos/src/memory/core/encoding/EncodingModel.ts
export function computeEncodingWeights(traits: HexacoTraits): EncodingWeights {
  const o = clamp01(traits.openness);
  const c = clamp01(traits.conscientiousness);
  const e = clamp01(traits.emotionality);
  const x = clamp01(traits.extraversion);
  const a = clamp01(traits.agreeableness);
  const h = clamp01(traits.honesty);

  return {
    noveltyAttention:     0.3 + o * 0.7,  // openness   → novel content
    proceduralAttention:  0.3 + c * 0.7,  // conscient. → structure, plans
    emotionalSensitivity: 0.2 + e * 0.8,  // emotion.   → emotional content
    socialAttention:      0.2 + x * 0.8,  // extravers. → social dynamics
    cooperativeAttention: 0.2 + a * 0.8,  // agreeab.   → cooperation cues
    ethicalAttention:     0.2 + h * 0.8,  // honesty    → ethical content
  };
}
```

Each weight scales how a detected content feature contributes to encoding strength. The encoding-weight ramps diagram at the top of this page shows the two formula families' baselines and slopes.

`computeAttentionMultiplier()` blends them with detected features (novelty, procedure, emotion, social, cooperation, ethical, contradiction, topic-relevance) into a final 0-1 multiplier:

```
strength = base × arousalBoost × emotionalBoost × attentionMultiplier × congruenceBoost × flashbulbBoost
```

The composite strength is clamped to [0, 1] and feeds the Ebbinghaus stability calculation — stronger encodings produce more stable traces, which decay more slowly.

**Practical effect:** an agent with `emotionality: 0.85` encodes emotionally charged moments roughly 4x more strongly than an agent with `emotionality: 0.15` on the same input. Over thousands of interactions, the high-emotionality agent's memory is dominated by emotionally significant traces; the low-emotionality agent's memory is dominated by procedural and factual traces.

Source: [`packages/agentos/src/memory/core/encoding/EncodingModel.ts:38`](https://github.com/framersai/agentos/blob/master/src/memory/core/encoding/EncodingModel.ts#L38).

### 3. Working memory capacity

Baddeley's classic finding (1974) is that working memory holds 7 ± 2 active items. Personality modulates the exact count within that range.

```ts
// packages/agentos/src/memory/core/working/CognitiveWorkingMemory.ts
function computeCapacity(base: number, traits: HexacoTraits): number {
  const o = clamp01(traits.openness);
  const c = clamp01(traits.conscientiousness);
  let capacity = base;                     // default 7
  if (o > 0.6) capacity += 1;              // broader attention span
  if (c > 0.6) capacity -= 1;              // deeper focus per slot
  return Math.max(5, Math.min(9, capacity));
}
```

| Profile | Capacity | Behavioral effect |
|---|---|---|
| openness > 0.6, conscientiousness ≤ 0.6 | 8 slots | Broader simultaneous attention, more associative leaps |
| openness ≤ 0.6, conscientiousness > 0.6 | 6 slots | Deeper focus per item, less context-switching |
| Both > 0.6 | 7 slots (cancel out) | Default Miller's number |
| Both ≤ 0.6 | 7 slots | Default Miller's number |

Source: [`packages/agentos/src/memory/core/working/CognitiveWorkingMemory.ts:54`](https://github.com/framersai/agentos/blob/master/src/memory/core/working/CognitiveWorkingMemory.ts#L54).

### 4. Memory prompt formatting style

When the memory system assembles retrieved traces into the LLM prompt, it picks one of three formatting styles based on the dominant trait among Conscientiousness, Openness, and Emotionality:

```ts
// packages/agentos/src/memory/core/prompt/MemoryPromptAssembler.ts
function selectFormattingStyle(traits: HexacoTraits): FormattingStyle {
  const c = clamp01(traits.conscientiousness);
  const o = clamp01(traits.openness);
  const e = clamp01(traits.emotionality);

  if (c >= o && c >= e) return 'structured';
  if (o >= c && o >= e) return 'narrative';
  return 'emotional';
}
```

| Style | Trait | Memory references read like |
|---|---|---|
| `structured` | Conscientiousness dominant | Bulleted, categorized, clearly delimited sections |
| `narrative` | Openness dominant | Flowing prose, associative, draws connections across traces |
| `emotional` | Emotionality dominant | Empathetic, mood-aware, foregrounds tone and feeling |

A preamble matching the chosen style is prepended to the memory section, teaching the LLM how to reference traces in its response without announcing them as raw recall.

Source: [`packages/agentos/src/memory/core/prompt/MemoryPromptAssembler.ts:49`](https://github.com/framersai/agentos/blob/master/src/memory/core/prompt/MemoryPromptAssembler.ts#L49).

### 5. Observer and Reflector bias

The background observation pipeline (running when accumulated tokens cross a threshold) and the consolidation reflector (running periodically over accumulated notes) are both personality-biased.

**Observer** ([`MemoryObserver.ts:64`](https://github.com/framersai/agentos/blob/master/src/memory/pipeline/observation/MemoryObserver.ts#L64)) — adds emphasis lines for each trait > 0.6:

| Trait > 0.6 | Observer emphasis |
|---|---|
| Emotionality | "Pay special attention to emotional shifts, tone changes, and sentiment transitions." |
| Conscientiousness | "Note any commitments, deadlines, action items, or structured plans." |
| Openness | "Capture creative tangents, novel ideas, and exploratory topics." |
| Agreeableness | "Track user preferences, rapport cues, and communication style patterns." |
| Honesty | "Flag any corrections, retractions, or contradictions to prior statements." |

Two agents observing the same conversation will extract different note sets.

**Reflector** ([`MemoryReflector.ts:72`](https://github.com/framersai/agentos/blob/master/src/memory/pipeline/observation/MemoryReflector.ts#L72)) — picks a conflict-resolution strategy and a memory-writing style:

```ts
const conflictStrategy = clamp(traits.honesty) > 0.6
  ? 'prefer newer information, supersede old'
  : clamp(traits.agreeableness) > 0.6
  ? 'keep both versions, note discrepancy'
  : 'prefer higher confidence';

const memoryStyle = clamp(traits.conscientiousness) > 0.6
  ? 'structured, well-organized traces'
  : clamp(traits.openness) > 0.6
  ? 'rich, associative traces with connections'
  : 'concise, factual traces';
```

A high-honesty reflector will update old beliefs when new contradicting evidence arrives. A high-agreeableness reflector will keep both versions and note the inconsistency rather than picking a winner. The default falls back to confidence-based resolution.

---

## Runtime self-modification

Personality is not frozen at agent construction. Two mechanisms let traits evolve during operation.

### `adapt_personality` tool

When `emergent.allowPersonalityAdaptation: true` is set on the agent config, the runtime exposes an `adapt_personality` tool the agent can call mid-decision.

```ts
const agent = createAgent({
  provider: 'openai',
  personality: { openness: 0.5, conscientiousness: 0.5 /* ... */ },
  emergent: {
    allowPersonalityAdaptation: true,
    sessionBudget: {
      maxAbsoluteDeltaPerTrait: 0.20,  // total drift per session capped
      maxMutationsPerSession: 5,
    },
  },
});
```

The tool accepts:

```ts
interface AdaptPersonalityInput {
  trait: 'honesty' | 'emotionality' | 'extraversion' |
         'agreeableness' | 'conscientiousness' | 'openness';
  delta: number;        // signed; clamped per session budget
  reasoning: string;    // mandatory audit trail
}
```

Constraints enforced:
- Only the six valid HEXACO trait names accepted.
- `reasoning` is mandatory on every mutation.
- Per-session absolute-delta budget per trait.
- Final values clamped to [0, 1].
- Every mutation persisted to a `PersonalityMutationStore` (SQLite, JSON, or in-memory implementations available).

This is how a roleplay agent's persona drifts toward what its interactions actually call for, rather than staying frozen at a static config.

Source: [`packages/agentos/src/emergent/AdaptPersonalityTool.ts`](https://github.com/framersai/agentos/blob/master/src/emergent/AdaptPersonalityTool.ts).

### Persona Drift mechanism

`PersonaDriftMechanism` is one of the optional cognitive mechanisms (off by default). When enabled, it runs heuristic analysis on accumulated episodic memories every N consolidation cycles and proposes bounded trait mutations based on emotional patterns and relationship-delta signals.

```ts
const DEFAULT_PERSONA_DRIFT_CONFIG = {
  enabled: false,
  analysisInterval: 5,        // every 5 consolidation cycles
  minTracesForAnalysis: 10,   // require 10+ episodic traces
  maxDeltaPerCycle: 0.05,     // bounded mutation magnitude
  emotionalWeighting: true,   // weight high-arousal memories more
};
```

This is heuristic-only (no LLM calls) and is the right choice when you want long-running agents to slowly adapt their disposition based on what they actually experience, without the cost or unpredictability of LLM-driven self-evaluation.

Source: [`packages/agentos/src/memory/mechanisms/PersonaDriftMechanism.ts`](https://github.com/framersai/agentos/blob/master/src/memory/mechanisms/PersonaDriftMechanism.ts).

---

## Configuration reference

### Agent-level

```ts
import { agent, type AgentOptions } from '@framers/agentos';

const opts: AgentOptions = {
  provider: 'anthropic',
  personality: {
    honesty?: number;          // 0-1, defaults to 0.5
    emotionality?: number;
    extraversion?: number;
    agreeableness?: number;
    conscientiousness?: number;
    openness?: number;
  },
  // ...
};
```

All fields optional. Omitted traits default to 0.5 (neutral) at every consumer site (encoding, capacity calc, formatter selection).

### Memory subsystem

If you bypass the high-level `agent()` factory and configure `CognitiveMemoryManager` directly:

```ts
import { CognitiveMemoryManager } from '@framers/agentos/memory';

await memory.initialize({
  agentId: 'researcher-1',
  traits: {
    openness: 0.9,
    conscientiousness: 0.7,
  },
  moodProvider: () => ({ valence: 0, arousal: 0.3, dominance: 0 }),
  // ... other config
});
```

Source: [`CognitiveMemoryConfig`](https://github.com/framersai/agentos/blob/master/src/memory/core/config.ts) in `packages/agentos/src/memory/core/config.ts`.

---

## Choosing trait values

Three patterns:

**1. Persona archetypes.** Pick a named persona and derive trait values from a HEXACO-IPIP-style mapping. Useful for character-driven agents.

```ts
const characters = {
  meticulousAnalyst: {
    conscientiousness: 0.90, honesty: 0.85, openness: 0.50,
    emotionality: 0.30, extraversion: 0.40, agreeableness: 0.55,
  },
  empatheticListener: {
    emotionality: 0.85, agreeableness: 0.85, honesty: 0.75,
    openness: 0.65, conscientiousness: 0.60, extraversion: 0.55,
  },
  creativeProvocateur: {
    openness: 0.95, agreeableness: 0.30, honesty: 0.65,
    extraversion: 0.75, emotionality: 0.50, conscientiousness: 0.35,
  },
};
```

**2. Role-driven.** Set 2-3 traits intentionally and leave the rest at defaults. The factor structure of HEXACO means trait *combinations* matter more than individual extremes for behavioral differentiation.

**3. User-modeled.** If an agent is meant to mirror or complement a specific user, derive traits from a HEXACO-60 or HEXACO-100 self-report instrument. The model's psychometric grounding (Ashton & Lee, 2007) means real users' self-report data maps cleanly to runtime config.

---

## What HEXACO does not do

To be precise about scope:

- **Does not bias retrieval ranking directly.** The 6-signal retrieval scorer (similarity, strength, recency, emotional congruence, graph activation, importance) does not include a personality term. Personality affects retrieval *indirectly* through what was encoded strongly enough to be retrievable.
- **Does not modify provider/model selection.** Personality lives at the runtime layer above the LLM call.
- **Does not affect tool-call permission.** Tool gating uses the security tier and permissions system, not traits.
- **Does not affect cost-routing.** Reader-router decisions are query-driven, not personality-driven.

Personality is a memory-and-style modulator, not a policy enforcement mechanism.

---

## Cognitive science foundations

| Source | Application |
|---|---|
| Ashton & Lee, 2007 | HEXACO six-factor structure. Trait taxonomy and the Honesty-Humility split. ([SAGE Journals](https://journals.sagepub.com/doi/10.1177/1088868306294907)) |
| Baddeley & Hitch, 1974 | Working memory model with slot-based capacity. Source for Miller's 7 ± 2 and the openness/conscientiousness slot modulation. |
| Brown & Kulik, 1977 | Flashbulb memories. Source for high-emotionality agents producing more vivid, persistent traces. |
| Bower, 1981 | Mood-congruent encoding. Source for the congruence boost in encoding strength. |
| Yerkes & Dodson, 1908 | Inverted-U arousal curve. Combines with personality to determine encoding quality. |

Full citations are in the [Cognitive Memory page](./cognitive-memory.md#references).

---

## Source files

| Concern | File |
|---|---|
| Type definition | [`src/memory/core/config.ts`](https://github.com/framersai/agentos/blob/master/src/memory/core/config.ts) |
| Public API | [`src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts), [`src/api/agent.ts`](https://github.com/framersai/agentos/blob/master/src/api/agent.ts) |
| Encoding weights | [`src/memory/core/encoding/EncodingModel.ts`](https://github.com/framersai/agentos/blob/master/src/memory/core/encoding/EncodingModel.ts) |
| Working memory capacity | [`src/memory/core/working/CognitiveWorkingMemory.ts`](https://github.com/framersai/agentos/blob/master/src/memory/core/working/CognitiveWorkingMemory.ts) |
| Prompt formatting | [`src/memory/core/prompt/MemoryPromptAssembler.ts`](https://github.com/framersai/agentos/blob/master/src/memory/core/prompt/MemoryPromptAssembler.ts) |
| Observer bias | [`src/memory/pipeline/observation/MemoryObserver.ts`](https://github.com/framersai/agentos/blob/master/src/memory/pipeline/observation/MemoryObserver.ts) |
| Reflector bias | [`src/memory/pipeline/observation/MemoryReflector.ts`](https://github.com/framersai/agentos/blob/master/src/memory/pipeline/observation/MemoryReflector.ts) |
| `adapt_personality` tool | [`src/emergent/AdaptPersonalityTool.ts`](https://github.com/framersai/agentos/blob/master/src/emergent/AdaptPersonalityTool.ts) |
| Mutation persistence | [`src/emergent/PersonalityMutationStore.ts`](https://github.com/framersai/agentos/blob/master/src/emergent/PersonalityMutationStore.ts) |
| Persona drift mechanism | [`src/memory/mechanisms/PersonaDriftMechanism.ts`](https://github.com/framersai/agentos/blob/master/src/memory/mechanisms/PersonaDriftMechanism.ts) |

---

## See also

- [Cognitive Memory](./cognitive-memory.md) — The full encoding/decay/retrieval architecture HEXACO modulates.
- [Cognitive Mechanisms](./cognitive-mechanisms.md) — The eight (plus persona drift) optional neuroscience-grounded mechanisms layered on top of the substrate.
- [Working Memory](./working-memory.md) — Slot-based attention buffer.
- [Emergent Capabilities](../emergent-capabilities.md) — Self-modification gates including `adapt_personality`.
