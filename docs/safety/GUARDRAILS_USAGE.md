# Guardrails Usage Guide

:::tip See also
For creating custom guardrails, see [Creating Custom Guardrails](./CREATING_GUARDRAILS.md). For the underlying safety primitives, see [Safety Primitives](./SAFETY_PRIMITIVES.md).
:::

Guardrails are safety mechanisms that intercept and evaluate content before it enters or exits the AgentOS pipeline. They enable content filtering, PII redaction, policy enforcement, and mid-stream decision overrides.

## Overview

Guardrails intercept content at two points:

1. **Input Guardrails** - Evaluate user messages before orchestration
2. **Output Guardrails** - Evaluate agent responses before streaming to client

```
User Input → [Input Guardrails] → Orchestration → [Output Guardrails] → Client
```

When multiple guardrails are active, AgentOS uses a **two-phase dispatcher**:

1. **Phase 1 (sequential sanitizers)** - Guardrails with `config.canSanitize === true` run in registration order so each sanitizer sees the cumulative sanitized text
2. **Phase 2 (parallel classifiers)** - All remaining guardrails run concurrently via `Promise.allSettled`, with worst-action aggregation (`BLOCK > FLAG > ALLOW`)

This keeps redaction deterministic while still allowing heavyweight classifiers and grounding checks to run in parallel.

## Built-in Guardrail Packs

The extensions registry has six guardrail packs, each a standalone package:

| Pack | Package | What It Does |
|------|---------|-------------|
| **PII Redaction** | `@framers/agentos-ext-pii-redaction` | Four-tier PII detection (regex patterns from `openredaction`, an NLP prefilter, an NER model, an LLM judge) on input and output; a Phase 1 sanitizer. Tools: `pii_scan`, `pii_redact` |
| **ML Classifiers** | `@framers/agentos-ext-ml-classifiers` | Toxicity, prompt injection, NSFW and threat classification (ONNX models, with LLM and keyword fallbacks). Tool: `classify_content` |
| **Topicality** | `@framers/agentos-ext-topicality` | Embedding-based topic enforcement on user input, with LLM and keyword fallbacks; output passes unevaluated. Tool: `check_topic` |
| **Code Safety** | `@framers/agentos-ext-code-safety` | OWASP Top 10 code scanning (25 regex rules). Tool: `scan_code` |
| **Grounding Guard** | `@framers/agentos-ext-grounding-guard` | RAG-grounded hallucination detection via NLI. Tool: `check_grounding` |
| **Content Policy Rewriter** | `@framers/agentos-ext-content-policy-rewriter` | Opt-in content policy: a keyword pre-filter on streamed text and an LLM judge on the final response that blocks or rewrites it |

## Quick Start

```typescript
import { AgentOS, AgentOSResponseChunkType } from '@framers/agentos';
import { createTestAgentOSConfig } from '@framers/agentos';
import {
  IGuardrailService,
  GuardrailAction,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type GuardrailEvaluationResult,
} from '@framers/agentos/safety/guardrails';

// Simple content filter
class ContentFilter implements IGuardrailService {
  async evaluateInput({ input }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    if (input.textInput?.toLowerCase().includes('prohibited')) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Content violates usage policy',
        reasonCode: 'CONTENT_POLICY_001',
      };
    }
    return null; // Allow
  }
}

// Initialize with guardrail
const agent = new AgentOS();
const base = await createTestAgentOSConfig();
await agent.initialize({
  ...base,
  guardrailService: new ContentFilter(), // Optional config-scoped guardrail
});
```

## Guardrail Actions

| Action | Effect |
|--------|--------|
| `ALLOW` | Pass content unchanged |
| `FLAG` | Pass content, record metadata for audit |
| `SANITIZE` | Replace content with modified version |
| `BLOCK` | Reject/terminate the interaction |

## Mid-Stream Decision Override ("Changing Mind")

Guardrails can evaluate streaming chunks in real-time and "change their mind" about allowing content. The examples below import `AgentOSResponseChunkType` from `@framers/agentos` (as the Quick Start does): chunk types are lowercase strings such as `'text_delta'`, so compare against the enum. This enables:

- Stopping generation when cost ceiling is exceeded
- Blocking harmful content as it's being generated
- Redacting sensitive information mid-stream

### Example 1: Cost Ceiling Guardrail

Stop generation when the response exceeds a token budget:

```typescript
class CostCeilingGuardrail implements IGuardrailService {
  // Enable streaming evaluation
  config = {
    evaluateStreamingChunks: true,
    maxStreamingEvaluations: 100  // Rate limit
  };

  private tokenCount = 0;
  private readonly maxTokens = 1000;

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Only evaluate text chunks
    if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA || !chunk.textDelta) {
      return null;
    }

    // Estimate tokens (rough: 1 token ≈ 4 chars)
    this.tokenCount += Math.ceil(chunk.textDelta.length / 4);

    if (this.tokenCount > this.maxTokens) {
      // "Change mind" - stop generating mid-stream
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Response exceeded token budget. Please refine your request.',
        reasonCode: 'COST_CEILING_EXCEEDED',
        metadata: { tokensUsed: this.tokenCount, limit: this.maxTokens },
      };
    }

    return null;
  }
}
```

### Example 2: Real-Time PII Redaction

The `@framers/agentos-ext-pii-redaction` pack detects PII in four tiers (regex patterns from the `openredaction` library, an NLP prefilter, a BERT NER model, an LLM judge): emails, phone numbers, SSNs, payment cards, IP addresses, IBANs, passports, driver's licenses, other government IDs, dates of birth, API and AWS keys, crypto addresses, medical terms, and person, organization and location names. See the [PII Redaction extension docs](/docs/extensions/built-in/pii-redaction) for full configuration reference.

```typescript
import { createPiiRedactionGuardrail } from '@framers/agentos-ext-pii-redaction';

const piiPack = createPiiRedactionGuardrail({
  confidenceThreshold: 0.5,
  redactionStyle: 'placeholder',  // also: 'mask', 'hash', 'category-tag'
  enableNerModel: true,            // BERT NER for person/org/location names
  llmJudge: {                      // optional: resolve ambiguous cases
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
});

const agent = new AgentOS();
await agent.initialize({
  ...config,
  extensionManifest: { packs: [{ factory: () => piiPack }] },
});
```

The extension provides two agent-callable tools (`pii_scan` and `pii_redact`) and a streaming guardrail that automatically redacts PII from input and output. It sets `canSanitize: true` so it runs in Phase 1 (sequential) of the parallel dispatcher.

#### Custom regex-only PII guardrail

If you only need simple regex patterns (no NER, no LLM), you can write a lightweight custom guardrail instead. This demonstrates the [`IGuardrailService`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) interface with `SANITIZE` action:

```typescript
class SimpleRegexPiiGuardrail implements IGuardrailService {
  config = {
    evaluateStreamingChunks: true,
    canSanitize: true,  // Phase 1: runs before parallel classifiers
  };

  private readonly patterns = [
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN REDACTED]' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL REDACTED]' },
    { regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[CARD REDACTED]' },
  ];

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA || !chunk.textDelta) return null;

    let text = chunk.textDelta;
    let modified = false;

    for (const { regex, replacement } of this.patterns) {
      const newText = text.replace(regex, replacement);
      if (newText !== text) { text = newText; modified = true; }
    }

    if (modified) {
      return { action: GuardrailAction.SANITIZE, modifiedText: text, reasonCode: 'PII_REDACTED' };
    }
    return null;
  }
}
```

> **Note:** For production use, the `@framers/agentos-ext-pii-redaction` extension is strongly recommended over custom regex. It catches names, organizations, locations, and 50+ country-specific ID formats that regex alone misses.

### Example 3: Content Policy Mid-Stream

Block harmful content as it's being generated:

```typescript
class ContentPolicyGuardrail implements IGuardrailService {
  config = { evaluateStreamingChunks: true };

  private readonly prohibitedPatterns = [
    /how to make.*bomb/i,
    /instructions for.*weapon/i,
    // ... more patterns
  ];

  private accumulatedText = '';

  async evaluateOutput({ chunk }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA && chunk.textDelta) {
      this.accumulatedText += chunk.textDelta;

      for (const pattern of this.prohibitedPatterns) {
        if (pattern.test(this.accumulatedText)) {
          return {
            action: GuardrailAction.BLOCK,
            reason: 'Response contains content that violates our usage policy.',
            reasonCode: 'CONTENT_POLICY_VIOLATION',
          };
        }
      }
    }

    return null;
  }
}
```

## Cross-Agent Guardrails

Cross-agent guardrails let one agent (supervisor) monitor and intervene in other agents' outputs. AgentOS attaches them to no stream on its own: neither `processRequest()` nor `agency()` reads them. The host wraps an agent's output stream with `wrapWithCrossAgentGuardrails(guardrails, { sourceAgentId, observerAgentId, agencyId }, guardrailContext, stream, { streamId })` from `@framers/agentos/safety/guardrails`. Each guardrail that observes the source agent (`observeAgentIds`, every agent when empty) evaluates every chunk in turn, a non-final `TEXT_DELTA` only with `evaluateStreamingChunks: true`; a `BLOCK` ends the stream with an error chunk, and a guardrail without `canInterruptOthers: true` has its `BLOCK` and `SANITIZE` downgraded to `FLAG`. This is useful for:

- Supervisor patterns in multi-agent systems
- Quality gates across an agency
- Organization-wide policy enforcement

### Supervisor Pattern

```typescript
import {
  ICrossAgentGuardrailService,
  GuardrailAction,
  type CrossAgentOutputPayload,
  type GuardrailEvaluationResult,
} from '@framers/agentos/safety/guardrails';

class SupervisorGuardrail implements ICrossAgentGuardrailService {
  // Observe specific worker agents (empty = all agents)
  observeAgentIds = ['worker-analyst', 'worker-writer'];

  // Allow this guardrail to block/modify other agents' streams
  canInterruptOthers = true;

  // Evaluate streaming chunks in real-time
  config = { evaluateStreamingChunks: true };

  async evaluateCrossAgentOutput({
    sourceAgentId,
    chunk,
    context,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Check for confidential information leakage
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA && chunk.textDelta?.includes('CONFIDENTIAL')) {
      return {
        action: GuardrailAction.BLOCK,
        reason: `Agent ${sourceAgentId} attempted to expose confidential information`,
        reasonCode: 'CROSS_AGENT_CONFIDENTIAL_LEAK',
        metadata: {
          blockedAgent: sourceAgentId,
          supervisor: 'supervisor-agent'
        },
      };
    }

    return null;
  }
}
```

### Quality Gate Guardrail

```typescript
class QualityGateGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = []; // Observe all agents
  canInterruptOthers = true;

  async evaluateCrossAgentOutput({
    sourceAgentId,
    chunk,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Only evaluate final responses
    if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) {
      return null;
    }

    const response = chunk.finalResponseText;

    // Check response quality
    if (response && response.length < 50) {
      return {
        action: GuardrailAction.FLAG,
        reason: 'Response may be too brief',
        reasonCode: 'QUALITY_WARNING',
        metadata: {
          responseLength: response.length,
          agent: sourceAgentId
        },
      };
    }

    return null;
  }
}
```

## Configuration Options

### GuardrailConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `evaluateStreamingChunks` | `boolean` | `false` | Evaluate TEXT_DELTA chunks (real-time) vs only FINAL_RESPONSE |
| `maxStreamingEvaluations` | `number` | `undefined` | Rate limit streaming evaluations per guarded stream (the turn's stream and each continuation stream count on their own) |
| `canSanitize` | `boolean` | `false` | Run this guardrail in Phase 1 so SANITIZE results chain deterministically |
| `timeoutMs` | `number` | `undefined` | Per-guardrail timeout. On timeout/error the dispatcher fails open for that guardrail, unless `failClosed` is set or the guard is required |
| `failClosed` | `boolean` | `false` | A throw or a timeout blocks instead of passing. Forced on for a required guard |

### Output Payload Extras

[`GuardrailOutputPayload`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) includes `ragSources?: RagRetrievedChunk[]` for output-time grounding checks. This field is populated when the response was generated with RAG retrieval, and is what the grounding guard uses to compare claims against retrieved evidence.

### Performance Considerations

| Mode | Latency | Cost | Use Case |
|------|---------|------|----------|
| **Final-only** (default) | +1-500ms once | Low | Policy checks needing full context |
| **Streaming** | +1-500ms per chunk | High | Real-time PII redaction, immediate blocking |

## Required Guards, Hold Mode and Replacement Replies

A product whose safety rules are code names the guards it cannot run without, and the runtime holds them to it:

```typescript
const agentos = await AgentOS.create({
  extensionManifest: { packs: [{ factory: () => createPhraseListPack(neverDo) }, { factory: () => createPhraseListPack(selfHarm) }] },
  requiredGuardrails: [
    { id: 'never-do', stages: ['output'], timeoutMs: 8_000 },
    { id: 'self-harm', stages: ['input', 'output'], timeoutMs: 8_000 },
  ],
});
```

- **Boot.** `initialize()` throws `SYS_CONFIGURATION_ERROR` (with `missing` and `missingStage` in its details) when a required id has no active guard, the guard is disabled by an override, or it does not implement a required stage.
- **Every request.** `processRequest()`, `handleToolResults()` and `resumeExternalToolRequest()` check again and answer one error chunk, `SYS_GUARDRAIL_REQUIRED_MISSING`, while a required guard is missing. Nothing reaches a provider.
- **Posture.** A required guard runs under its id, fail-closed (a throw, a timeout past `timeoutMs`, or an answer whose action is not a `GuardrailAction` blocks, as `GUARDRAIL_ERROR` or `GUARDRAIL_MALFORMED`), whatever its own `config` says.
- **Hold mode.** A guard required on `output`, or `guardrailOutputMode: 'hold'`, holds every `TEXT_DELTA` until the final guards have judged the whole reply. Allowed or flagged, the deltas go out before the final chunk; blocked or sanitized, they are dropped. An actionable tool call closes the window: the text so far is judged as a final reply before the tool call goes out. The same guards run on the continuation after an external tool result.
- **Replacement replies.** A `BLOCK` whose evaluation carries a non-empty `replacementText` reaches the caller as a `FINAL_RESPONSE` holding that text in both text fields, with `metadata.guardrail.output[0].action === 'block'` and the guard's `reasonCode`, in place of an error chunk. A block without one (or with an empty string) yields the error chunk.
- **The stored reply.** With conversational persistence on, a reply a guard blocked with a replacement or sanitized is rewritten in the conversation's history (and one blocked without a replacement is emptied) before the final chunk leaves, so the history holds what the person saw: the stored message is matched by the text the guards judged, never by position, on a turn and on a tool continuation alike. The message's `metadata.modificationInfo` records the guard's reason code. A block on a streamed delta judges no whole reply and rewrites nothing; hold mode is where nothing streams before the final verdict. With `appendOnlyPersistence` on the conversation manager the stored row keeps the first text and the rewrite stays in memory; the runtime logs a warning when that happens, and a product that must not keep a replaced reply does not run an append-only store. A sanitized final chunk's `updatedConversationContext` reads the rewrite too.
- **Declared stages.** A guard that has both methods but runs on one stage declares it in `IGuardrailService.stages` (the phrase-list guard does, from its `stages` option); a required guard is held to the stages it declares, and a stage it does not declare is reported as missing instead of passing on the method's existence.
- **The text before a tool call.** In hold mode the text held before an actionable tool call is judged as a reply of its own: a block replaces it and the tool call does not go out; a sanitize rewrites what streams. That verdict is not reported through `onVerdict`, since nothing is stored at that point; the turn's final chunk, which carries the whole text, is judged and recorded on its own.
- **Every verdict names its guard.** `metadata.guardrailId` is set on each evaluation when the guard has an `id`; a block's error chunk carries it in `details.metadata`.

### `PhraseListGuardrail`

A guard over a reviewed list of phrases. Each entry blocks on a match, or asks a judge whether the match, read in the text, crosses the rule. Text is normalised before matching (NFKC, case, zero-width characters and combining marks removed, Cyrillic and Greek look-alikes mapped to Latin, curly quotes straightened), so a lookalike letter or an invisible joiner does not get past the list.

```typescript
import { PhraseListGuardrail, StaticPhraseListSource, createLlmPhraseJudge, createPhraseListPack } from '@framers/agentos';

const neverDo = await PhraseListGuardrail.create({
  id: 'never-do',
  stages: ['output'],
  source: new StaticPhraseListSource({
    version: '2026-10-08', reviewedAt: '2026-10-08', reviewedBy: 'counsel',
    entries: [
      { phrase: 'you will pass', match: 'word', onMatch: 'block', ruleId: 'outcome_promise' },
      { phrase: 'index fund', match: 'word', onMatch: 'judge', ruleId: 'money' },
    ],
  }),
  judge: createLlmPhraseJudge({ provider: 'openai', model: 'gpt-6-luna', criteria: 'Investment, tax or legal advice.', apiKey, fallbackProviders: [] }),
  replacementFor: (ruleId) => TEMPLATES[ruleId],
});
```

`PhraseListGuardrail.create` refuses an empty list, a list that does not load, and judge entries without a judge; `reload()` swaps the list in whole and keeps the last good one when the new one fails. The judge fails closed: a throw, an answer without `block` and `confidence`, or a confidence under `judgeThreshold` (default 0.7) blocks. `createLlmPhraseJudge` takes `fallbackProviders: []` by default, so the judge reaches only the provider it was given.

### Hard limits in the persona

`IPersonaDefinition.hardLimits` (and `hardLimits:` in a SOUL file's front matter, when the file is loaded as a persona) renders as the last block of the system prompt of every GMI turn for that persona, under the heading "Hard limits", after everything the turn added and after every fragment of the persona's own prompt whatever priority it carries. The guards hold the same rules in code; the block tells the model.

A GMI built by `agent({ runtime: 'gmi' })` or `gmi()` has no such block. Its persona comes from [`personaFromAgentOptions()`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/gmiPersona.ts), which sets no `hardLimits`, and the front matter of a `soul` file is not applied on that path ([GMIs from agent()](../GMI.md#gmis-from-agent)).

## Using Multiple Guardrails

Multiple guardrails are dispatched in two phases: sanitizers first, then parallel classifiers:

```typescript
import { createPiiRedactionGuardrail } from '@framers/agentos-ext-pii-redaction';
import { createMLClassifierGuardrail } from '@framers/agentos-ext-ml-classifiers';
import { createTopicalityGuardrail } from '@framers/agentos-ext-topicality';
import { createCodeSafetyGuardrail } from '@framers/agentos-ext-code-safety';
import { createGroundingGuardrail } from '@framers/agentos-ext-grounding-guard';

const piiPack = createPiiRedactionGuardrail({
  redactionStyle: 'placeholder',
  confidenceThreshold: 0.5,
});

const mlPack = createMLClassifierGuardrail({
  categories: ['toxic', 'injection'],
});

const topicalityPack = createTopicalityGuardrail({
  allowedTopics: ['customer support', 'billing', 'product features'],
  blockedTopics: ['politics', 'violence', 'gambling'],
});

const codeSafetyPack = createCodeSafetyGuardrail();

const groundingPack = createGroundingGuardrail({
  contradictionAction: 'flag',
});

await agent.initialize({
  ...config,
  extensionManifest: {
    packs: [
      { factory: () => piiPack },
      { factory: () => mlPack },
      { factory: () => topicalityPack },
      { factory: () => codeSafetyPack },
      { factory: () => groundingPack },
    ],
  },
});
```

**Evaluation Order:**
1. Phase 1 sanitizers run first in registration order
2. If any sanitizer returns `BLOCK`, processing stops immediately
3. Sanitized text from Phase 1 becomes the input to all Phase 2 guardrails
4. Phase 2 guardrails run concurrently, and the worst action wins
5. `SANITIZE` returned from Phase 2 is downgraded to `FLAG` to preserve deterministic output

## API Reference

### IGuardrailService

```typescript
interface IGuardrailService {
  id?: string;               // Names the guard in verdicts and in requiredGuardrails
  config?: GuardrailConfig;
  evaluateInput?(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null>;
  evaluateOutput?(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

### ICrossAgentGuardrailService

```typescript
interface ICrossAgentGuardrailService extends IGuardrailService {
  observeAgentIds?: string[];      // Agents to observe (empty = all)
  canInterruptOthers?: boolean;    // Can BLOCK/SANITIZE other agents
  evaluateCrossAgentOutput?(payload: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

### GuardrailAction

```typescript
enum GuardrailAction {
  ALLOW = 'allow',      // Pass unchanged
  FLAG = 'flag',        // Pass, record metadata
  SANITIZE = 'sanitize', // Replace content
  BLOCK = 'block',      // Reject/terminate
}
```

### GuardrailEvaluationResult

```typescript
interface GuardrailEvaluationResult {
  action: GuardrailAction;
  reason?: string;           // User-facing message
  reasonCode?: string;       // Machine-readable code
  metadata?: Record<string, unknown>;
  details?: unknown;         // Debugging detail, not shown to users
  modifiedText?: string | null;  // For SANITIZE action
  replacementText?: string;  // With BLOCK on output, a non-empty string is the reply sent in place of the error chunk
}
```

### Shared Heavyweight Services

Extension packs that need expensive resources (NER models, ONNX classifiers, embedding functions, NLI pipelines) should load them through `ExtensionLifecycleContext.services`, which is an [`ISharedServiceRegistry`](https://github.com/framerslab/agentos/blob/master/src/extensions/ISharedServiceRegistry.ts). The extension manager provides a shared registry instance so one agent can reuse the same heavyweight dependency across multiple packs instead of loading it once per guardrail.

## Best Practices

1. **Start with final-only evaluation** - Enable streaming only when real-time filtering is required
2. **Use rate limiting** - Set `maxStreamingEvaluations` to control costs
3. **Be specific with reason codes** - Use consistent, machine-readable codes for analytics
4. **Log FLAG actions** - Use FLAG for monitoring without blocking user experience
5. **Test edge cases** - Test with partial PII, edge cases in streaming chunks
6. **Consider latency** - Each streaming evaluation adds latency to user experience

## Folder-Level Permissions

AgentOS has no folder-permission layer: its guardrails see the user's input and the response chunks, not tool arguments. [Wunderland](https://github.com/jddunn/wunderland), the agent CLI built on AgentOS, adds one. Its [`SafeGuardrails`](https://github.com/jddunn/wunderland/blob/master/src/security/SafeGuardrails.ts) class checks a tool call's file paths, and the paths it reads out of `rm`, `cp`, `mv`, `cat`, `touch`, `mkdir`, `rmdir`, `chmod` and `chown` commands, against glob rules with separate read and write flags before the tool runs. It writes each violation to `~/.wunderland/security/violations.log` and can notify webhooks or an email address of high and critical ones. An agent's `security.folderPermissions` in its `agent.config.json` sets the rules; see Wunderland's [guardrails documentation](https://github.com/jddunn/wunderland/blob/master/docs/features/GUARDRAILS.md).

## Related Documentation

- [Architecture Overview](../architecture/ARCHITECTURE.md)
- [Human-in-the-Loop](./HUMAN_IN_THE_LOOP.md)
- [Agent Communication](../architecture/AGENT_COMMUNICATION.md)
- [Safety Primitives](./SAFETY_PRIMITIVES.md)
