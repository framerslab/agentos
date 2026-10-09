---
title: "HEXACO Personality"
sidebar_position: 1.5
description: "How HEXACO trait vectors shape encoding, working-memory capacity, retrieval bias, prompt formatting, observer/reflector behavior, and runtime self-modification across the AgentOS memory system. Six trait dimensions, opt-in, character-driven simulation ready."
keywords: [hexaco personality llm, ai agent personality, agent trait modeling, persona overlay, character ai consistency, big five vs hexaco, ashton lee 2007, agentos persona, trait-modulated retrieval, roleplay agent]
---

# HEXACO Personality

> Six trait dimensions, each in the range [0, 1]. They shape an agent's system prompt and, where a cognitive memory manager runs with them, how the agent encodes, holds, formats and reflects on memories.

Personality is **opt-in**: a trait left out counts as 0.5 everywhere it is read, and a vector of 0.5s adds no prompt directive. Use it when persona consistency across sessions matters: roleplay agents, character-driven simulations, multi-specialist teams that need behavioral differentiation, or research probes where you want to vary the encoder rather than the input.

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
    emotionality: 0.65,       // at the 0.65 line: no directive
    agreeableness: 0.55,      // moderate
    extraversion: 0.50,       // neutral
    honesty: 0.75,            // transparent, no spin
  },
});

const session = coach.session('user-1');
await session.send('Help me build a morning routine.');
```

Through `agent()`, the traits reach the model as the system prompt section of surface 1 below. Surfaces 2 to 5 belong to cognitive memory: they apply where a `CognitiveMemoryManager` runs with these traits, as on a GMI with memory on ([GMIs from agent()](../GMI.md#gmis-from-agent)) or in a manager you build ([Memory subsystem](#memory-subsystem)).

---

## How traits propagate

The propagation diagram at the top of this page shows the five surfaces. Each is detailed below.

### 1. System prompt directives

`buildPersonalityDescription(traits)` in [`agent.ts`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) emits a `## Personality & Communication Style` section in the agent's system prompt. Each trait above 0.65 or below 0.35 produces one instruction; values from 0.35 to 0.65 produce none.

| Trait > 0.65 | Trait < 0.35 |
|---|---|
| **Honesty:** "Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly." | **Honesty:** "Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages." |
| **Emotionality:** "Respond with emotional awareness and empathy. Acknowledge feelings in the conversation. Express concern when appropriate." | **Emotionality:** "Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic." |
| **Extraversion:** "Be energetic and engaging. Use vivid language. Take initiative in the conversation. Offer suggestions proactively." | **Extraversion:** "Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth." |
| **Agreeableness:** "Prioritize harmony and cooperation. Validate the other perspective before offering alternatives. Be supportive and encouraging." | **Agreeableness:** "Be direct and challenge-oriented. Question assumptions. Prioritize accuracy over comfort. Push back when something seems wrong." |
| **Conscientiousness:** "Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed." | **Conscientiousness:** "Be flexible and adaptive. Prioritize the big picture over details. Respond quickly. Tolerate ambiguity and improvise." |
| **Openness:** "Explore creative angles and unconventional ideas. Draw unexpected connections. Question established approaches." | **Openness:** "Stick to proven approaches and established knowledge. Be practical and concrete. Favor reliability over novelty." |

Source: [`src/api/agent.ts:553`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts#L553).

### 2. Memory encoding strength

Traits derive six attention weights that scale how strongly an incoming trace is encoded.

```ts
// src/cognition/memory/core/encoding/EncodingModel.ts
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

**Practical effect:** emotionality enters the strength through `emotionalSensitivity` three times (the emotional boost, the emotion-feature attention bonus and the mood-congruence boost). On the same emotionally charged input (full intensity, congruent mood), `emotionality: 0.85` gives about 1.6 times the strength of `emotionality: 0.15`, before the cap at 1.0.

Source: [`src/cognition/memory/core/encoding/EncodingModel.ts:38`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts#L38).

### 3. Working memory capacity

Baddeley's classic finding (1974) is that working memory holds 7 ± 2 active items. Personality modulates the exact count within that range.

```ts
// src/cognition/memory/core/working/CognitiveWorkingMemory.ts
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

Source: [`src/cognition/memory/core/working/CognitiveWorkingMemory.ts:54`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/working/CognitiveWorkingMemory.ts#L54).

### 4. Memory prompt formatting style

When the memory system assembles retrieved traces into the LLM prompt, it picks one of three formatting styles based on the dominant trait among Conscientiousness, Openness, and Emotionality:

```ts
// src/cognition/memory/core/prompt/MemoryPromptAssembler.ts
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

Source: [`src/cognition/memory/core/prompt/MemoryPromptAssembler.ts:49`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryPromptAssembler.ts#L49).

### 5. Observer and Reflector bias

The observer (which runs when the accumulated conversation crosses its token threshold, 30,000 by default) and the reflector (which runs when the accumulated notes cross theirs, 40,000 by default) both put personality instructions into their prompts.

**Observer** ([`MemoryObserver.ts:64`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts#L64)) — adds emphasis lines for each trait > 0.6:

| Trait > 0.6 | Observer emphasis |
|---|---|
| Emotionality | "Pay special attention to emotional shifts, tone changes, and sentiment transitions." |
| Conscientiousness | "Note any commitments, deadlines, action items, or structured plans." |
| Openness | "Capture creative tangents, novel ideas, and exploratory topics." |
| Agreeableness | "Track user preferences, rapport cues, and communication style patterns." |
| Honesty | "Flag any corrections, retractions, or contradictions to prior statements." |

Two agents observing the same conversation will extract different note sets.

**Reflector** ([`MemoryReflector.ts:77`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts#L77)) tells its model how to settle contradictions and how to write traces, checked in this order:

| Condition | Contradictions | Condition | Trace style |
|---|---|---|---|
| honesty > 0.6 | prefer the newer information and flag the old memory for supersession | conscientiousness > 0.6 | structured, well-organized |
| agreeableness > 0.6 | keep both versions and note the discrepancy | openness > 0.6 | rich, associative, with connections |
| otherwise | keep the version with higher confidence | otherwise | concise, factual |

---

## Runtime self-modification

Two mechanisms address trait change during operation; only the first changes a trait.

### `adapt_personality` tool

On the full runtime, `AgentOS.create({ emergent: true, emergentConfig: { selfImprovement: { enabled: true } } })` registers the self-improvement tools, `adapt_personality` among them. The model calls it to change one trait of the GMI that runs the tool.

```ts
interface AdaptPersonalityInput {
  trait: string;      // one of the six trait names
  delta: number;      // signed change
  reasoning: string;  // required, non-empty
}
```

- An unknown trait name or an empty `reasoning` returns an error and changes nothing.
- The total change per trait per session is capped at `selfImprovement.personality.maxDeltaPerSession` (default 0.15); a larger delta is clamped to what remains.
- The new value is clamped to [0, 1] and applied with `GMI.setPersonalityTrait()`.
- A [`PersonalityMutationStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/PersonalityMutationStore.ts) records the change only when the runtime has a storage adapter and `personality.persistWithDecay` is on (the default); stored mutations are not reloaded into later GMIs.

`agent()` registers no such tool; its traits stay as given.

Source: [`src/cognition/emergent/AdaptPersonalityTool.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts).

### Persona Drift mechanism

`PersonaDriftMechanism` is an optional cognitive mechanism (off by default). When enabled, it analyzes accumulated episodic memories during consolidation, without an LLM call, and computes bounded trait-change proposals from emotional patterns and relationship signals. The consolidation pipeline discards those proposals, so no trait changes, and `analysisInterval` is not read: the analysis runs on every consolidation.

```ts
const DEFAULT_PERSONA_DRIFT_CONFIG = {
  enabled: false,
  analysisInterval: 5,        // declared, not read: analysis runs on every consolidation
  minTracesForAnalysis: 10,   // require 10+ episodic traces
  maxDeltaPerCycle: 0.05,     // bounded mutation magnitude
  emotionalWeighting: true,   // weight high-arousal memories more
};
```

Source: [`src/cognition/memory/mechanisms/PersonaDriftMechanism.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/PersonaDriftMechanism.ts).

For the rest of the runtime adaptation surface — mood, inferred user skill, task complexity, working-memory imprints, and the metaprompt loop that drives them between turns — see [Adaptive Prompt Intelligence](../ADAPTIVE_PROMPT_INTELLIGENCE.md).

---

## Configuration reference

### Agent-level

```ts
// AgentOptions['personality']
type Personality = {
  honesty?: number;            // 0-1
  emotionality?: number;
  extraversion?: number;
  agreeableness?: number;
  conscientiousness?: number;
  openness?: number;
};
```

All fields are optional. An omitted trait counts as 0.5 wherever it is read (prompt directives, encoding weights, capacity, formatter selection).

### Memory subsystem

If you bypass the high-level `agent()` factory and configure [`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) directly:

```ts
import { CognitiveMemoryManager } from '@framers/agentos/memory';

const memory = new CognitiveMemoryManager();
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

Source: [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts) in `src/cognition/memory/core/config.ts`.

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

- **Does not enter the retrieval score.** The 6-signal retrieval scorer (similarity, strength, recency, emotional congruence, graph activation, importance) has no personality term. Personality reaches retrieval through what was encoded strongly, and through the cognitive mechanisms, whose parameters the traits scale and some of which run at retrieval.
- **Does not modify provider/model selection.** Personality lives at the runtime layer above the LLM call.
- **Does not affect tool-call permission.** Tool gating uses the permission system, not traits.
- **Does not affect cost-routing.** Reader-router decisions are query-driven, not personality-driven.

Personality is a memory-and-style modulator, not a policy enforcement mechanism. The one routing use is the agent graph's personality edge, which picks a branch by comparing a trait value with a threshold ([Agent Graph](../architecture/AGENT_GRAPH.md)).

---

## Cognitive science foundations

| Source | Application |
|---|---|
| Ashton & Lee, 2007 | HEXACO six-factor structure. Trait taxonomy and the Honesty-Humility split. ([SAGE Journals](https://journals.sagepub.com/doi/10.1177/1088868306294907)) |
| Baddeley & Hitch, 1974 | Working memory model with slot-based capacity. Source for Miller's 7 ± 2 and the openness/conscientiousness slot modulation. |
| Brown & Kulik, 1977 | Flashbulb memories. Source for high-emotionality agents producing more vivid, persistent traces. |
| Bower, 1981 | Mood-congruent encoding. Source for the congruence boost in encoding strength. |
| Yerkes & Dodson, 1908 | Inverted-U arousal curve. Combines with personality to determine encoding quality. |

Full citations are in the [Cognitive Memory page](./COGNITIVE_MEMORY.md#references).

---

## Source files

| Concern | File |
|---|---|
| Type definition | [`src/cognition/memory/core/config.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts) |
| Public API | [`src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts), [`src/api/agent.ts`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) |
| Encoding weights | [`src/cognition/memory/core/encoding/EncodingModel.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts) |
| Working memory capacity | [`src/cognition/memory/core/working/CognitiveWorkingMemory.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/working/CognitiveWorkingMemory.ts) |
| Prompt formatting | [`src/cognition/memory/core/prompt/MemoryPromptAssembler.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryPromptAssembler.ts) |
| Observer bias | [`src/cognition/memory/pipeline/observation/MemoryObserver.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) |
| Reflector bias | [`src/cognition/memory/pipeline/observation/MemoryReflector.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts) |
| `adapt_personality` tool | [`src/cognition/emergent/AdaptPersonalityTool.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts) |
| Mutation persistence | [`src/cognition/emergent/PersonalityMutationStore.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/PersonalityMutationStore.ts) |
| Persona drift mechanism | [`src/cognition/memory/mechanisms/PersonaDriftMechanism.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/PersonaDriftMechanism.ts) |

---

## See also

- [Cognitive Memory](./COGNITIVE_MEMORY.md) — The full encoding/decay/retrieval architecture HEXACO modulates.
- [Cognitive Memory — Mechanism Implementation Reference](./COGNITIVE_MEMORY.md#mechanism-implementation-reference) — The eight (plus persona drift) optional neuroscience-grounded mechanisms layered on top of the substrate.
- [Working Memory](./WORKING_MEMORY.md) — Slot-based attention buffer.
- [Emergent Capabilities](../architecture/EMERGENT_CAPABILITIES.md) — Self-modification gates including `adapt_personality`.
