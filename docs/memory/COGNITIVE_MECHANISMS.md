---
title: Cognitive Mechanisms
description: How AgentOS implements reconsolidation, retrieval-induced forgetting, temporal gist, schema encoding, source-confidence decay, and emotion regulation
keywords:
  - cognitive mechanisms
  - memory reconsolidation
  - retrieval induced forgetting
  - temporal gist
  - schema encoding
  - emotion regulation
  - source confidence decay
  - feeling of knowing
  - hexaco modulation
  - perspective encoding
---

# Cognitive Mechanisms — Package Implementation Guide

> *"Memory is not a passive recorder, but an active constructor."* — Daniel Schacter

This page is the wiring map for the cognitive mechanisms that turn AgentOS memory from a vector store into something that behaves more like remembering. Each mechanism is a pure function with one job — drift a trace toward current mood, suppress its competitors after a retrieval, compress verbatim text into gist, weight a source-of-truth confidence. The engine bolts them onto three hook points (access, retrieval, consolidation) on the `MemoryStore` and `MemoryPromptAssembler`. Everything else is bookkeeping.

If you want the theory and citations, read [Cognitive Memory](./COGNITIVE_MEMORY.md) first. This file tells you which `.ts` to open when something's off.

## File Structure

```
packages/agentos/src/memory/mechanisms/
├── types.ts                          # CognitiveMechanismsConfig + shared types
├── defaults.ts                       # DEFAULT_MECHANISMS_CONFIG + resolveConfig()
├── CognitiveMechanismsEngine.ts      # Lifecycle hook orchestrator
├── retrieval/
│   ├── Reconsolidation.ts            # Emotional drift on access
│   ├── RetrievalInducedForgetting.ts # Competitor suppression
│   ├── InvoluntaryRecall.ts          # Random memory surfacing
│   └── MetacognitiveFOK.ts           # Feeling-of-knowing scoring
├── consolidation/
│   ├── TemporalGist.ts               # Verbatim→gist compression
│   ├── SchemaEncoding.ts             # Schema-congruent detection
│   ├── SourceConfidenceDecay.ts      # Source-type decay multipliers
│   └── EmotionRegulation.ts          # Reappraisal & suppression
├── __tests__/
│   ├── types.test.ts                 # Config shapes, defaults
│   ├── retrieval.test.ts             # 4 retrieval mechanisms
│   ├── consolidation.test.ts         # 4 consolidation mechanisms
│   └── engine.test.ts                # Engine lifecycle hooks
└── index.ts                          # Barrel exports
```

## Hook Points

| Existing File | Method | Hook | When |
|---|---|---|---|
| `store/MemoryStore.ts` | `recordAccess()` | `engine.onAccess(trace, mood)` | After spaced repetition update |
| `store/MemoryStore.ts` | `query()` | `engine.onRetrieval(scored, candidates, cutoff, entities)` | After scoring, before return |
| `prompt/MemoryPromptAssembler.ts` | `assembleMemoryContext()` | `engine.onPromptAssembly(allTraces, retrievedIds)` | Before final return |
| `CognitiveMemoryManager.ts` | `initialize()` | Engine construction | Dynamic import when config present |

The consolidation hook (`engine.onConsolidation()`) is available on the engine but wiring into `ConsolidationLoop.run()` is deferred to when the loop is instantiated with a mechanisms-aware config.

## Mechanism API Summary

### Retrieval-Time (synchronous)

```typescript
// Reconsolidation: mutates trace.emotionalContext in place
applyReconsolidation(trace: MemoryTrace, currentMood: PADState, config): void

// RIF: mutates competitor.stability in place
applyRetrievalInducedForgetting(retrieved, competitors, config): { suppressedIds: string[] }

// Involuntary Recall: pure selection, no mutation
selectInvoluntaryMemory(allTraces, alreadyRetrievedIds, config): MemoryTrace | null

// FOK: pure detection, no mutation
detectFeelingOfKnowing(scoredCandidates, retrievalCutoff, config, queryEntities): MetacognitiveSignal[]
```

### Consolidation-Time (async for LLM gist extraction)

```typescript
// Temporal Gist: mutates trace.content, trace.encodingStrength, trace.structuredData
applyTemporalGist(traces, config, llmFn?): Promise<number>

// Schema Encoding: mutates trace.encodingStrength, trace.structuredData
applySchemaEncoding(trace, traceEmbedding, clusterCentroids, config): SchemaEncodingResult

// Source Confidence Decay: mutates trace.stability, trace.structuredData
applySourceConfidenceDecay(traces, config): number

// Emotion Regulation: mutates trace.emotionalContext, trace.encodingStrength, trace.structuredData
applyEmotionRegulation(traces, config): number
```

## HEXACO Personality Modulation

The `CognitiveMechanismsEngine` constructor accepts optional `HexacoTraits`. When provided, mechanism parameters are scaled by personality dimensions before any hooks fire:

```typescript
// In CognitiveMemoryManager.initialize():
this.mechanismsEngine = new CognitiveMechanismsEngine(config.cognitiveMechanisms, config.traits);
```

Modulation is applied once at construction time via `applyPersonalityModulation()`. Each trait maps to a specific mechanism parameter via empirically-grounded scaling formulas documented in `CognitiveMechanismsEngine.ts`.

## Guard Conditions

All mechanisms share common guard patterns:

- **Flashbulb immunity:** Traces with `encodingStrength >= 0.9` are skipped by reconsolidation, RIF, temporal gist, and emotion regulation
- **Dead trace protection:** RIF skips traces with `encodingStrength < 0.1`
- **Inactive skip:** All consolidation mechanisms skip `isActive === false` traces
- **Disabled bypass:** Every mechanism returns immediately when `config.enabled === false`

## Rehydration

Gisted/archived content can be inflated on demand via `CognitiveMemoryManager.rehydrate(traceId)`. Content does not decay while archived; age-based retention applies instead. The archive is backed by `IMemoryArchive` (default: `SqlStorageMemoryArchive`), which uses the same `StorageAdapter` contract as `Brain`. When sharing the brain's adapter, archive tables (`archived_traces`, `archive_access_log`) live in the same database.

The `rehydrate_memory` LLM tool is opt-in via `MemoryToolsExtension({ includeRehydrate: true })`.

## Perspective Encoding

Events witnessed by multiple agents are rewritten through each witness's HEXACO personality, current mood, and relationships before encoding. A suspicious character notices threats; an emotional character remembers feelings; a conscientious character tracks commitments. The objective event is archived (via `IMemoryArchive`); each witness gets their own first-person trace.

Perspective-encoded traces have their reconsolidation `driftRate` halved. They already shifted from objective truth at encoding time, so full retrieval-time drift would compound distortion. The `maxDriftPerTrace` cap (0.4) still bounds total drift.

Gating: only `important`-tier witnesses with `event.importance >= 0.3` and entity overlap get LLM rewrites. Others fall back to objective encoding. Cost: ~$0.025/session on Haiku 4.5 for 5 NPCs.

## Metadata Storage

Mechanism metadata is stored in `trace.structuredData.mechanismMetadata` (type `MechanismMetadata`), avoiding changes to the core `MemoryTrace` interface. The metadata is persisted in the vector store's metadata JSON column.

## Testing

Each mechanism is a pure function testable in isolation:

```bash
# All mechanism tests
npx vitest run src/memory/mechanisms/

# Individual mechanism groups
npx vitest run src/memory/mechanisms/__tests__/retrieval.test.ts
npx vitest run src/memory/mechanisms/__tests__/consolidation.test.ts
npx vitest run src/memory/mechanisms/__tests__/engine.test.ts
npx vitest run src/memory/mechanisms/__tests__/types.test.ts
```

For more on the cognitive science foundations, see [docs/memory/cognitive-mechanisms.md](../../../docs/memory/cognitive-mechanisms.md).
