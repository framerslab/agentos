---
title: 'Creating Custom Guardrails'
sidebar_position: 8
---

# Creating Custom Guardrails

This guide walks you through everything you need to create, package, test, and deploy a custom guardrail for AgentOS. By the end you will understand the full lifecycle -- from implementing the [`IGuardrailService`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) interface to publishing a self-contained extension pack.

## Overview

Guardrails intercept content at two points in the AgentOS pipeline:

1. **Input** -- before user messages enter the orchestration pipeline.
2. **Output** -- on the stream `processRequest()` returns, before its chunks reach the client.

```
User Input --> [Input Guardrails] --> Orchestration --> [Output Guardrails] --> Client
```

### When to create a custom guardrail

The extensions registry has six guardrail packs (PII Redaction, ML Classifiers, Topicality, Code Safety, Grounding Guard, Content Policy Rewriter). Create a custom guardrail when:

- You need **domain-specific policy enforcement** (e.g., financial compliance, medical disclaimers).
- You want to enforce **custom word lists, regex patterns, or proprietary classifiers**.
- You need to **integrate with external moderation APIs** (perspective API, custom ML endpoints).
- You want **cost or length ceilings** tailored to your product.

If an existing pack already covers your need, prefer configuring it over writing a new one.

### The contract at a glance

Every guardrail implements the [`IGuardrailService`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) interface. Both methods are optional -- implement only what you need.

```typescript
interface IGuardrailService {
  // Optional configuration controlling streaming behavior and execution phase.
  config?: GuardrailConfig;

  // Evaluate user input BEFORE it enters the orchestration pipeline.
  // Return null to allow, or a GuardrailEvaluationResult to act on it.
  evaluateInput?(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null>;

  // Evaluate agent output BEFORE it is streamed to the client.
  // Return null to allow, or a GuardrailEvaluationResult to act on it.
  evaluateOutput?(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

---

## The IGuardrailService Interface

### GuardrailConfig

The optional `config` object controls **when** and **how** your guardrail is called.

```typescript
interface GuardrailConfig {
  // When true, evaluateOutput is also called for each TEXT_DELTA chunk
  // during streaming. Either way it is called for every chunk that carries
  // isFinal: true (the FINAL_RESPONSE, an ERROR). Enable this for real-time
  // PII redaction or immediate blocking.
  evaluateStreamingChunks?: boolean; // default: false

  // Rate-limits how many streaming evaluations happen per request.
  // After this limit, remaining chunks pass through unevaluated.
  // Only applies when evaluateStreamingChunks is true.
  maxStreamingEvaluations?: number; // default: undefined (no limit)

  // When true, this guardrail runs in Phase 1 (sequential).
  // It sees and can modify text produced by prior sanitizers.
  // When false, it runs in Phase 2 (parallel).
  // Phase 2 guardrails that return SANITIZE are downgraded to FLAG.
  canSanitize?: boolean; // default: false

  // Maximum time (ms) to wait for this guardrail's evaluation.
  // On timeout the evaluation is abandoned and a warning is logged; the
  // guardrail is skipped (fail-open) unless failClosed is true.
  //
  // SAFETY WARNING: Do NOT set timeoutMs on a safety-critical guardrail
  // (e.g., CSAM detection, compliance-mandatory filters) without failClosed,
  // because fail-open on timeout means content passes unchecked.
  timeoutMs?: number; // default: undefined (wait indefinitely)

  // When true, an evaluation that throws or times out yields a BLOCK
  // (reasonCode 'GUARDRAIL_ERROR') instead of skipping this guardrail.
  failClosed?: boolean; // default: false
}
```

### evaluateInput(payload)

Called **once per request** before orchestration begins.

```typescript
interface GuardrailInputPayload {
  // Conversational context for policy decisions.
  context: GuardrailContext;

  // The user's input. The most commonly inspected field is input.textInput.
  input: AgentOSInput;
}

interface GuardrailContext {
  userId: string; // Unique user identifier
  sessionId: string; // Current session
  personaId?: string; // Active persona/agent identity
  conversationId?: string; // Conversation thread
  mode?: string; // Operating mode (e.g., 'debug', 'production')
  metadata?: Record<string, unknown>; // Arbitrary context for your policy logic
}
```

### evaluateOutput(payload)

Called for chunks of the turn's output stream, the stream that `processRequest()` passes through the output guardrails. Which chunks depends on `config.evaluateStreamingChunks`:

- **`false` (default)** -- each chunk that carries `isFinal: true`: the `FINAL_RESPONSE`, and an `ERROR` the turn yields.
- **`true`** -- those, and each `TEXT_DELTA` chunk during streaming, up to `maxStreamingEvaluations` per stream. The dispatcher counts these evaluations by the guardrail object's `id` property: streaming sanitizers (`canSanitize: true`) without an `id` share one count, so give each of them an `id`.

Other chunks (`TOOL_CALL_REQUEST`, `METADATA_UPDATE`, `SYSTEM_PROGRESS` and the rest that carry `isFinal: false`) are never passed to `evaluateOutput`. Two `ERROR` chunks never reach it either: the one `processRequest()` yields when an exception reaches its own `catch` (errors inside the turn arrive on the turn's stream and are evaluated), and the one an input guardrail's `BLOCK` produces. The streams that `handleToolResult()`, `handleToolResults()` and `resumeExternalToolRequest()` return do not pass through output guardrails.

```typescript
interface GuardrailOutputPayload {
  // Same conversational context as evaluateInput.
  context: GuardrailContext;

  // The response chunk to evaluate. This is a union type --
  // see "Understanding the Chunk Lifecycle" below.
  chunk: AgentOSResponse;

  // RAG source chunks retrieved for this request.
  // Available for grounding verification (e.g., hallucination detection).
  // Undefined when no RAG retrieval was performed.
  ragSources?: RagRetrievedChunk[];
}
```

### Return values

Return `null` to **allow** content through without action. Otherwise, return a [`GuardrailEvaluationResult`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts):

```typescript
interface GuardrailEvaluationResult {
  // The action AgentOS should take.
  action: GuardrailAction;

  // Human-readable reason (may be shown to users or logged).
  reason?: string;

  // Machine-readable code for analytics and automated handling.
  reasonCode?: string;

  // Arbitrary metadata persisted in response chunk metadata.
  metadata?: Record<string, unknown>;

  // Detailed debugging info (not shown to users).
  details?: unknown;

  // Replacement text when action is SANITIZE.
  // For input: replaces textInput before orchestration.
  // For output: replaces textDelta (streaming) or finalResponseText (final).
  modifiedText?: string | null;
}
```

---

## GuardrailAction Deep Dive

| Action       | Enum Value   | Effect                                                                                                                                                                                    |
| ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ALLOW**    | `'allow'`    | Pass content unchanged. Use when all checks pass.                                                                                                                                         |
| **FLAG**     | `'flag'`     | Pass content through but record metadata for audit/analytics. Content reaches the user; the evaluation is logged for review.                                                              |
| **SANITIZE** | `'sanitize'` | Replace content with the value in `modifiedText`. Use for PII redaction, profanity masking, or content rewriting. Requires `canSanitize: true` in config to work in Phase 1.              |
| **BLOCK**    | `'block'`    | Reject/terminate the interaction. For input evaluation, the request is never processed. For output evaluation during streaming, the stream is terminated immediately with an error chunk. |

### SANITIZE rules

- If `canSanitize: true` is set in your config, your guardrail runs in **Phase 1 (sequential)** and your `modifiedText` is applied before downstream guardrails see the content.
- If your guardrail is in **Phase 2** (no `canSanitize` or `canSanitize: false`) and it returns SANITIZE, the action is **automatically downgraded to FLAG** with a warning logged. This prevents non-deterministic concurrent modifications.

---

## Understanding the Chunk Lifecycle

The `chunk` field is typed as the union of all AgentOS response types, but `evaluateOutput` receives only `TEXT_DELTA` chunks (with `evaluateStreamingChunks: true`) and chunks that carry `isFinal: true`. The sections below describe the chunks of a `processRequest()` stream and say which ones reach your guardrail.

### TEXT_DELTA

Streaming text chunks emitted as the LLM generates tokens.

```typescript
// TEXT_DELTA chunks are only sent to your guardrail if
// config.evaluateStreamingChunks is true.
{
  type: 'text_delta',        // AgentOSResponseChunkType.TEXT_DELTA
  streamId: 'stream-abc',    // Unique stream identifier
  textDelta: 'Hello, ',      // The incremental text content
  isFinal: false,            // Always false for mid-stream deltas
  // ... other base fields (gmiInstanceId, personaId, timestamp, metadata)
}
```

### FINAL_RESPONSE

The complete, assembled response emitted at the end of a turn.

```typescript
// FINAL_RESPONSE is always sent to your guardrail (regardless of
// evaluateStreamingChunks setting).
{
  type: 'final_response',           // AgentOSResponseChunkType.FINAL_RESPONSE
  streamId: 'stream-abc',
  finalResponseText: 'Hello, world! How can I help you today?',
  isFinal: true,                    // Always true for final responses
  ragSources: [...],                // RAG chunks (if retrieval was performed)
  usage: { totalTokens: 42 },       // Cost aggregator
  // ... other fields (audioOutput, imageOutput, reasoningTrace, etc.)
}
```

### TOOL_CALL_REQUEST

Emitted when the model requests a tool call. It carries `isFinal: false`, so `evaluateOutput` never receives it: an output guardrail cannot approve or deny a tool call.

```typescript
{
  type: 'tool_call_request',   // AgentOSResponseChunkType.TOOL_CALL_REQUEST
  streamId: 'stream-abc',
  executionMode: 'external',
  requiresExternalToolResult: true,
  toolCalls: [
    {
      id: 'call_001',
      name: 'web_search',
      arguments: '{"query": "latest news"}'
    }
  ],
  rationale: 'User asked about current events.',
  isFinal: false,
}
```

If `executionMode` is `'internal'`, the chunk is informational only and the
runtime will execute the tool without requiring `handleToolResult(...)`.
Host code can gate that path with `isActionableToolCallRequestChunk(chunk)`
from `@framers/agentos` instead of open-coding both field checks.
For `'external'` chunks, hosts should resume through `handleToolResult(...)`
or `handleToolResults(...)` if the same pause emitted multiple actionable tool calls.
AgentOS also persists actionable external pauses into the conversation metadata,
so a reconnecting or restarted host can redisplay the pending tool request and
resume it with `resumeExternalToolRequest(...)`.
If those pending tool calls are AgentOS-registered tools, prefer
`resumeExternalToolRequestWithRegisteredTools(...)` to rebuild the correct
resume-time tool execution context automatically.
If the continued turn needs organization-scoped memory, the host must
re-supply trusted `organizationId` in the resume options because org context is
not persisted in conversation metadata.

### TOOL_RESULT_EMISSION

The result of an external tool call, emitted when the host returns it (`handleToolResult()`, `handleToolResults()` or a resumed request). The results of tools the runtime runs itself do not reach this stream: the GMI reports them as `TOOL_RESULT` chunks on its own stream, which `processRequest()` does not forward. `evaluateOutput` never receives this chunk: it arrives on the stream that continues the turn, which does not pass through output guardrails.

```typescript
{
  type: 'tool_result_emission',  // AgentOSResponseChunkType.TOOL_RESULT_EMISSION
  streamId: 'stream-abc',
  toolCallId: 'call_001',
  toolName: 'web_search',
  toolResult: { ... },
  isSuccess: true,
  errorMessage: undefined,         // the host's error message when isSuccess is false
  isFinal: false,
}
```

### Other chunk types

| Type               | Reaches `evaluateOutput`                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYSTEM_PROGRESS`  | No (`isFinal: false`). Progress updates.                                                                                                                            |
| `UI_COMMAND`       | No (`isFinal: false`). Frontend rendering instructions.                                                                                                             |
| `ERROR`            | Yes (`isFinal: true`) when the turn yields it. Not evaluated: the `ERROR` a guardrail's own BLOCK produces, and the `ERROR` that `processRequest()` yields when an exception reaches its own `catch`. |
| `METADATA_UPDATE`  | No (`isFinal: false`). Lifecycle and task-outcome metadata, and the turn's RAG sources, which the dispatcher passes to later evaluations as `ragSources`.           |
| `WORKFLOW_UPDATE`  | No (`isFinal: false`). Workflow progress.                                                                                                                           |
| `AGENCY_UPDATE`    | Only the update that carries `isFinal: true`, once every seat of the agency has completed or failed.                                                                |
| `PROVENANCE_EVENT` | Defined in `AgentOSResponseChunkType`; the runtime does not emit it.                                                                                                |

### The isFinal flag

Every chunk has an `isFinal: boolean` field. The flag describes its own chunk; `isFinal: false` does not mean another chunk follows.

- **`isFinal: false`** -- every `TEXT_DELTA` of a GMI turn carries it, and so does every `TOOL_CALL_REQUEST`. When the request is actionable (`executionMode: 'external'` and `requiresExternalToolResult: true`), `processRequest()` returns right after it: the turn waits for the host's tool results, and the rest of it comes from `handleToolResult()`, `handleToolResults()` or `resumeExternalToolRequest()`.
- **`isFinal: true`** -- `FINAL_RESPONSE` and `ERROR` chunks carry it, and so does an `AGENCY_UPDATE` once every seat of the agency has completed or failed. A GMI turn that fails on a `processRequest()` stream yields its `ERROR` and then the turn's `FINAL_RESPONSE`, which carries the error, so an `ERROR` is not always the stream's last chunk.

`evaluateOutput` receives every chunk with `isFinal: true` on the turn's output stream, whatever `evaluateStreamingChunks` is set to. If your guardrail buffers streaming text, use `isFinal: true` as the signal to **flush your buffer** and perform a final evaluation. A turn that stops for an external tool ends its `processRequest()` stream with that `TOOL_CALL_REQUEST`, which has no `isFinal: true`, and output guardrails do not run on the streams that `handleToolResult()`, `handleToolResults()` and `resumeExternalToolRequest()` return. Text your guardrail buffered before the tool request gets no final evaluation from the runtime.

---

## Two-Phase Parallel Execution

When multiple guardrails are registered, the [`ParallelGuardrailDispatcher`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/ParallelGuardrailDispatcher.ts) runs them in two phases:

```
                   Registered Guardrails
                          |
              +-----------+-----------+
              |                       |
        canSanitize: true       canSanitize: false/omitted
              |                       |
         Phase 1                 Phase 2
      (Sequential)             (Parallel)
              |                       |
     Each sees prior's        Promise.allSettled
     modified text            on Phase 1 output
              |                       |
     BLOCK short-circuits     SANITIZE --> FLAG
     the entire pipeline      (downgraded)
              |                       |
              +-----------+-----------+
                          |
                   Worst-Wins Aggregation
              BLOCK (3) > FLAG (2) > ALLOW (0)
```

### Phase 1: Sequential sanitizers

Guardrails with `canSanitize: true` run **one at a time in registration order**. Each sanitizer receives the cumulative output of all preceding sanitizers:

1. PII Redaction sanitizer receives the original text.
2. Profanity filter sanitizer receives PII-redacted text.
3. Custom rewriter sanitizer receives PII-redacted + profanity-filtered text.

A **BLOCK** in Phase 1 short-circuits immediately -- Phase 2 never runs.

### Phase 2: Parallel classifiers

All remaining guardrails (those without `canSanitize` or with `canSanitize: false`) run **concurrently via `Promise.allSettled`** on the fully-sanitized text from Phase 1.

If a Phase 2 guardrail returns **SANITIZE**, the action is **downgraded to FLAG** with a warning logged, because concurrent sanitization would produce non-deterministic results.

### Worst-wins aggregation

After both phases complete, the dispatcher picks the single worst action:

- **BLOCK** (severity 3) takes priority over everything.
- **FLAG** (severity 2) takes priority over ALLOW.
- **ALLOW** (severity 0) is the default when no guardrail triggers.

### Priority and stacking

The `priority` field on an [`ExtensionDescriptor`](https://github.com/framerslab/agentos/blob/master/src/extensions/types.ts) controls **stacking** (same `id` descriptors), not execution order. A higher-priority descriptor with the same `id` supersedes a lower-priority one. Registration order determines execution order within Phase 1 and Phase 2.

---

## Step-by-Step: Creating a Simple Guardrail

Let's create a profanity filter that blocks prohibited words in both input and output.

```typescript
import type {
  IGuardrailService,
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
} from '@framers/agentos';
import { GuardrailAction, AgentOSResponseChunkType } from '@framers/agentos';

/**
 * A simple profanity filter that blocks messages containing prohibited words.
 *
 * This guardrail operates in final-only mode (no streaming evaluation) and
 * does not modify content -- it either allows or blocks. It runs in Phase 2
 * (parallel) because canSanitize is not set.
 */
class ProfanityFilterGuardrail implements IGuardrailService {
  // No special config needed -- defaults to final-only, Phase 2 (parallel).
  // Omitting config entirely is equivalent to:
  //   config = { evaluateStreamingChunks: false, canSanitize: false };

  /**
   * The list of prohibited words. In production you would load this from
   * a database, config file, or external API.
   */
  private readonly blocklist: string[] = ['badword1', 'badword2', 'offensive_term'];

  /**
   * Check if text contains any prohibited words.
   * Uses case-insensitive word-boundary matching to avoid false positives
   * on substrings (e.g., "classic" should not match "ass").
   */
  private containsProfanity(text: string): string | null {
    // Normalize to lowercase for case-insensitive matching.
    const lower = text.toLowerCase();

    for (const word of this.blocklist) {
      // Build a regex with word boundaries so "classic" doesn't match "ass".
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      if (regex.test(lower)) {
        return word; // Return the first matched word for the reason message.
      }
    }

    return null; // No profanity found.
  }

  /**
   * Evaluate user input before orchestration.
   * Blocks the request entirely if profanity is detected.
   */
  async evaluateInput({ input }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    // Guard: skip if there is no text to evaluate.
    if (!input.textInput) {
      return null;
    }

    const matched = this.containsProfanity(input.textInput);

    if (matched) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Your message contains language that violates our usage policy.',
        reasonCode: 'PROFANITY_INPUT_BLOCKED',
        metadata: {
          // Include the matched word for audit logs (not shown to user).
          matchedTerm: matched,
        },
      };
    }

    // No issues found -- allow the input through.
    return null;
  }

  /**
   * Evaluate agent output before it reaches the client.
   * Blocks the response if profanity is detected in the final text.
   *
   * Because evaluateStreamingChunks is false (default), this method is
   * called only for chunks that carry isFinal: true (the FINAL_RESPONSE,
   * an ERROR).
   */
  async evaluateOutput({
    chunk,
  }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // Only evaluate the final assembled response.
    if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) {
      return null;
    }

    const text = chunk.finalResponseText;

    // Guard: skip if the final response is empty.
    if (!text) {
      return null;
    }

    const matched = this.containsProfanity(text);

    if (matched) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'The response was blocked due to a content policy violation.',
        reasonCode: 'PROFANITY_OUTPUT_BLOCKED',
        metadata: { matchedTerm: matched },
      };
    }

    return null;
  }
}
```

---

## Step-by-Step: Creating a Streaming Guardrail

Streaming guardrails evaluate `TEXT_DELTA` chunks in real time. The main challenge is that a single text delta may contain only a fragment of a pattern you want to detect. You need to **buffer** the streaming text and evaluate at sentence boundaries or on flush.

```typescript
import type {
  IGuardrailService,
  GuardrailConfig,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
} from '@framers/agentos';
import { GuardrailAction, AgentOSResponseChunkType } from '@framers/agentos';

/**
 * Per-stream buffer state for accumulating text deltas.
 * Each concurrent stream gets its own buffer so guardrail state
 * does not leak between parallel conversations.
 */
interface StreamBuffer {
  /** Accumulated text that has not yet been evaluated. */
  text: string;

  /** Number of evaluations performed for this stream (for rate limiting). */
  evaluations: number;

  /** Epoch ms of last chunk received (for stale cleanup). */
  lastSeenAt: number;
}

/**
 * Streaming content policy guardrail that accumulates text and
 * evaluates at sentence boundaries.
 *
 * When a prohibited pattern spans multiple TEXT_DELTA chunks, buffering
 * ensures we still detect it. On isFinal we flush the remaining buffer.
 *
 * This guardrail does NOT set canSanitize, so it runs in Phase 2 (parallel).
 * If you need to modify text mid-stream, set canSanitize: true.
 */
class StreamingContentPolicyGuardrail implements IGuardrailService {
  /**
   * Enable streaming evaluation so we see every TEXT_DELTA chunk.
   * Rate-limit to 100 evaluations per stream to control cost.
   */
  config: GuardrailConfig = {
    evaluateStreamingChunks: true,
    maxStreamingEvaluations: 100,
  };

  /**
   * Per-stream buffer map. Keyed by streamId so concurrent streams
   * each get isolated state.
   */
  private buffers = new Map<string, StreamBuffer>();

  /**
   * Patterns we want to block. These may span multiple chunks,
   * which is why we buffer.
   */
  private readonly prohibitedPatterns = [
    /instructions\s+for\s+making\s+a\s+bomb/i,
    /how\s+to\s+hack\s+into/i,
    /bypass\s+security\s+system/i,
  ];

  /** Sentence-boundary regex for flushing the buffer. */
  private readonly sentenceBoundary = /[.!?]\s|\n/;

  /** Maximum age (ms) before a stale stream buffer is cleaned up. */
  private readonly staleThresholdMs = 60_000; // 1 minute

  /**
   * Evaluate output chunks in real time.
   *
   * For TEXT_DELTA chunks: accumulate into a per-stream buffer and
   * check for prohibited patterns at sentence boundaries.
   *
   * For isFinal chunks: flush the remaining buffer and do a final check.
   */
  async evaluateOutput({
    chunk,
  }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    // We only care about TEXT_DELTA and FINAL_RESPONSE chunks.
    if (
      chunk.type !== AgentOSResponseChunkType.TEXT_DELTA &&
      chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE
    ) {
      return null;
    }

    const streamId = chunk.streamId;

    // ---------------------------------------------------------------
    // isFinal: flush the buffer and clean up the stream state.
    // ---------------------------------------------------------------
    if (chunk.isFinal) {
      const buffer = this.buffers.get(streamId);

      // Determine the text to evaluate on the final flush.
      const finalText =
        chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE
          ? (chunk.finalResponseText ?? '')
          : (buffer?.text ?? '') + ((chunk as any).textDelta ?? '');

      // Clean up the stream buffer -- we are done with this stream.
      this.buffers.delete(streamId);

      // Periodically clean up stale buffers from abandoned streams.
      this.cleanupStaleBuffers();

      return this.checkPatterns(finalText);
    }

    // ---------------------------------------------------------------
    // TEXT_DELTA (non-final): accumulate into the stream buffer.
    // ---------------------------------------------------------------
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA && chunk.textDelta) {
      // Get or create the buffer for this stream.
      let buffer = this.buffers.get(streamId);
      if (!buffer) {
        buffer = { text: '', evaluations: 0, lastSeenAt: Date.now() };
        this.buffers.set(streamId, buffer);
      }

      // Append the new delta to the buffer.
      buffer.text += chunk.textDelta;
      buffer.lastSeenAt = Date.now();

      // Only evaluate at sentence boundaries to reduce overhead.
      // If no sentence boundary is found yet, wait for more text.
      if (this.sentenceBoundary.test(buffer.text)) {
        buffer.evaluations++;

        // Evaluate the entire accumulated buffer.
        const result = this.checkPatterns(buffer.text);

        if (result) {
          // Prohibited content found -- clean up and block.
          this.buffers.delete(streamId);
          return result;
        }

        // Trim already-evaluated text up to the last sentence boundary.
        // Keep the trailing fragment for the next evaluation.
        const lastBoundary = Math.max(
          buffer.text.lastIndexOf('. '),
          buffer.text.lastIndexOf('? '),
          buffer.text.lastIndexOf('! '),
          buffer.text.lastIndexOf('\n')
        );
        if (lastBoundary > 0) {
          buffer.text = buffer.text.slice(lastBoundary + 1);
        }
      }
    }

    // No issues detected in this chunk.
    return null;
  }

  /**
   * Check accumulated text against all prohibited patterns.
   * Returns a BLOCK result if a match is found, or null otherwise.
   */
  private checkPatterns(text: string): GuardrailEvaluationResult | null {
    for (const pattern of this.prohibitedPatterns) {
      if (pattern.test(text)) {
        return {
          action: GuardrailAction.BLOCK,
          reason: 'Response contains content that violates our usage policy.',
          reasonCode: 'STREAMING_CONTENT_POLICY_VIOLATION',
          metadata: {
            pattern: pattern.source,
            detectedAt: new Date().toISOString(),
          },
        };
      }
    }
    return null;
  }

  /**
   * Remove buffers for streams that have not received a chunk in over
   * staleThresholdMs. This prevents memory leaks from abandoned streams
   * (e.g., network disconnects or client-side cancellations).
   */
  private cleanupStaleBuffers(): void {
    const now = Date.now();
    for (const [id, buf] of this.buffers) {
      if (now - buf.lastSeenAt > this.staleThresholdMs) {
        this.buffers.delete(id);
      }
    }
  }
}
```

### Key patterns in streaming guardrails

1. **Buffer per stream** -- use `Map<streamId, StreamBuffer>` so concurrent streams do not interfere with each other.
2. **Evaluate at sentence boundaries** -- reduces evaluation overhead without missing multi-chunk patterns.
3. **Flush on `isFinal`** -- always evaluate the remaining buffer when the stream ends.
4. **Stale cleanup** -- delete buffers for streams that stopped sending chunks to avoid memory leaks.
5. **Rate limiting** -- set `maxStreamingEvaluations` to cap how many evaluations a single stream triggers.

---

## Packaging as an Extension Pack

To distribute your guardrail as a reusable extension, package it as an **ExtensionPack** under the curated registry.

### 1. Directory structure

Create a new directory under the extensions registry:

```
packages/agentos-extensions/registry/curated/safety/my-guardrail/
  manifest.json
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts              # createExtensionPack() factory
    MyGuardrail.ts        # IGuardrailService implementation
    types.ts              # Pack-specific option types
  test/
    MyGuardrail.spec.ts   # Unit tests
```

### 2. package.json

Declare `@framers/agentos` as a **peer dependency** so your pack works with any compatible AgentOS version.

```json
{
  "name": "@framers/agentos-ext-my-guardrail",
  "version": "0.1.0",
  "description": "My custom guardrail for AgentOS",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist", "src", "manifest.json"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "peerDependencies": {
    "@framers/agentos": "^0.1.0"
  },
  "devDependencies": {
    "@framers/agentos": "workspace:*",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  },
  "license": "MIT"
}
```

### 3. tsconfig.json

Use `paths` to map `@framers/agentos` to the monorepo source during development.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "paths": {
      "@framers/agentos": ["../../../../../agentos/dist/index.d.ts"],
      "@framers/agentos/*": ["../../../../../agentos/dist/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### 4. vitest.config.ts

Resolve the `@framers/agentos` alias for both CI and monorepo layouts.

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

// CI layout: agentos cloned into packages/agentos/ inside this repo.
const ciPath = path.resolve(__dirname, '../../../../packages/agentos/src');
// Monorepo layout: agentos is a sibling at packages/agentos/.
const monoPath = path.resolve(__dirname, '../../../../../agentos/src');

// Use whichever path actually exists on disk.
const agentosPath = fs.existsSync(ciPath) ? ciPath : fs.existsSync(monoPath) ? monoPath : null;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 10000,
  },
  resolve: agentosPath
    ? {
        alias: {
          '@framers/agentos': agentosPath,
        },
      }
    : {},
});
```

### 5. manifest.json

Declare the pack metadata for the extension registry.

```json
{
  "name": "@framers/agentos-ext-my-guardrail",
  "version": "0.1.0",
  "description": "My custom guardrail for AgentOS",
  "author": "Your Name",
  "license": "MIT",
  "category": "safety",
  "tags": ["guardrail", "content-filter", "safety"],
  "entryPoint": "./dist/index.js"
}
```

### 6. src/index.ts -- the createExtensionPack() factory

This is the main entry point. It follows the same pattern as the built-in PII Redaction pack.

```typescript
import type { ISharedServiceRegistry } from '@framers/agentos';
import { SharedServiceRegistry } from '@framers/agentos';
import type {
  ExtensionPack,
  ExtensionPackContext,
  ExtensionDescriptor,
  ExtensionLifecycleContext,
} from '@framers/agentos';
// EXTENSION_KIND_GUARDRAIL is the well-known kind string for guardrail descriptors.
import { EXTENSION_KIND_GUARDRAIL } from '@framers/agentos';
import type { MyGuardrailOptions } from './types';
import { MyGuardrail } from './MyGuardrail';

// Re-export types for consumers.
export * from './types';

/**
 * Create an ExtensionPack that bundles the custom guardrail.
 *
 * @param options - Optional pack configuration. All fields have defaults.
 * @returns A fully-configured ExtensionPack ready for registration.
 */
export function createMyGuardrailPack(options?: MyGuardrailOptions): ExtensionPack {
  const opts: MyGuardrailOptions = options ?? {};

  // Mutable state that onActivate can upgrade with the extension manager's
  // shared registry and secret resolver.
  const state = {
    // Start with a standalone registry; onActivate replaces it with the
    // agent-wide shared registry so heavyweight resources are shared.
    services: new SharedServiceRegistry() as ISharedServiceRegistry,
    getSecret: undefined as ((id: string) => string | undefined) | undefined,
  };

  // Build the guardrail instance. This function is called once at creation
  // time and again during onActivate to upgrade to shared resources.
  let guardrail: MyGuardrail;

  function buildComponents(): void {
    guardrail = new MyGuardrail(state.services, opts, state.getSecret);
  }

  // Initial build for direct programmatic use (before activation).
  buildComponents();

  return {
    // Canonical pack name used in manifests and logs.
    name: 'my-guardrail',
    version: '1.0.0',

    // Descriptors getter returns the current guardrail instance wrapped
    // in the ExtensionDescriptor shape. Uses a getter so descriptors
    // always reflect the latest (potentially rebuilt) component.
    get descriptors(): ExtensionDescriptor[] {
      return [
        {
          id: 'my-guardrail',
          kind: EXTENSION_KIND_GUARDRAIL, // 'guardrail'
          priority: 0,
          payload: guardrail,
        },
      ];
    },

    /**
     * Lifecycle hook called when the extension manager activates this pack.
     * Upgrades to the agent-wide shared service registry so heavyweight
     * resources (ML models, NLP libraries) are shared across extensions.
     */
    onActivate: (context: ExtensionLifecycleContext): void => {
      if (context.services) {
        state.services = context.services;
      }
      if (context.getSecret) {
        state.getSecret = context.getSecret;
      }
      // Rebuild with the upgraded shared registry.
      buildComponents();
    },

    /**
     * Lifecycle hook called when the pack is deactivated.
     * Release any resources allocated by the guardrail.
     */
    onDeactivate: async (): Promise<void> => {
      // Release services registered by this pack. If other packs share
      // the same service IDs, they will be unaffected (reference-counted).
      await state.services.releaseAll();
    },
  };
}

/**
 * Manifest factory bridge. Conforms to the convention expected by the
 * extension loader when resolving packs from manifests.
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  return createMyGuardrailPack(context.options as MyGuardrailOptions);
}
```

### 7. Register in pnpm-workspace.yaml and registry.json

Add your new package to `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'packages/agentos-extensions/registry/curated/safety/my-guardrail'
```

And add an entry to `packages/agentos-extensions/registry.json`:

```json
{
  "my-guardrail": {
    "path": "registry/curated/safety/my-guardrail",
    "category": "safety",
    "description": "My custom guardrail"
  }
}
```

---

## Using ISharedServiceRegistry

The [`ISharedServiceRegistry`](https://github.com/framerslab/agentos/blob/master/src/extensions/ISharedServiceRegistry.ts) is a singleton registry for **lazy-loading heavyweight resources** like ML models, NLP libraries, or large data files. It ensures that if multiple extensions need the same resource, only one instance is created.

```typescript
import type { ISharedServiceRegistry } from '@framers/agentos';

class MyGuardrail implements IGuardrailService {
  constructor(
    private readonly services: ISharedServiceRegistry,
    private readonly options: MyGuardrailOptions
  ) {}

  async evaluateInput({ input }: GuardrailInputPayload) {
    // getOrCreate returns the cached instance if it already exists,
    // or calls the factory function once to create it.
    // The service ID is a unique string -- use the same ID across
    // extensions to share the same instance.
    const classifier = await this.services.getOrCreate(
      'toxicity-classifier-v2', // Service ID (shared across extensions)
      async () => {
        // This factory runs ONCE, the first time any extension requests
        // this service ID. Subsequent calls return the cached instance.
        const { ToxicityClassifier } = await import('my-ml-library');
        const model = new ToxicityClassifier();
        await model.loadWeights(); // ~98MB one-time load
        return model;
      },
      {
        // dispose is called when services.release('toxicity-classifier-v2')
        // or services.releaseAll() is invoked. Clean up GPU memory, file
        // handles, etc.
        dispose: async (instance) => {
          await (instance as any).unload();
        },
        // Tags are for diagnostics/tooling -- optional but recommended.
        tags: ['ml', 'toxicity', 'gpu'],
      }
    );

    // Use the shared classifier instance.
    const score = await classifier.classify(input.textInput ?? '');

    if (score > 0.9) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Input classified as toxic.',
        reasonCode: 'TOXICITY_BLOCKED',
        metadata: { score },
      };
    }

    return null;
  }
}
```

### Key points

- **`getOrCreate(serviceId, factory, options)`** -- the factory only runs once per `serviceId`. All callers receive the same instance.
- **Cross-extension sharing** -- if the PII redaction pack and your custom guardrail both call `getOrCreate('ner-model', ...)` with the same `serviceId`, they share one model instance.
- **`dispose`** -- called when `release(serviceId)` or `releaseAll()` is invoked. Use it to free GPU memory, close connections, etc.
- **Use for anything >1MB** -- if your resource is large (ML weights, dictionaries), always go through the registry instead of holding it in a class field.

---

## Accessing RAG Sources

When AgentOS performs RAG (Retrieval-Augmented Generation), the retrieved source chunks are passed to output guardrails via `payload.ragSources`.

```typescript
async evaluateOutput(
  { chunk, ragSources }: GuardrailOutputPayload,
): Promise<GuardrailEvaluationResult | null> {
  // ragSources is only available when RAG retrieval was performed.
  // It is undefined for non-RAG conversations.
  if (!ragSources || ragSources.length === 0) {
    return null;
  }

  // Only evaluate the final assembled response for grounding.
  if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) {
    return null;
  }

  const responseText = chunk.finalResponseText ?? '';

  // Example: check that the response references at least one source.
  // A real implementation would use NLI cross-encoders or LLM-as-judge
  // (see the built-in Grounding Guard extension for a production example).
  const sourceTexts = ragSources.map((s) => s.content);
  const mentionsSource = sourceTexts.some((src) =>
    responseText.toLowerCase().includes(src.toLowerCase().slice(0, 50))
  );

  if (!mentionsSource) {
    return {
      action: GuardrailAction.FLAG,
      reason: 'Response may not be grounded in retrieved sources.',
      reasonCode: 'GROUNDING_WARNING',
      metadata: {
        sourceCount: ragSources.length,
        responseLength: responseText.length,
      },
    };
  }

  return null;
}
```

### When ragSources is available

- `ragSources` comes with every evaluation after the turn's retrieval: the GMI's sources reach the stream as a `METADATA_UPDATE` before the first `TEXT_DELTA`, and the `FINAL_RESPONSE` carries them too.
- It is `undefined` when the turn retrieved no sources.
- Each [`RagRetrievedChunk`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/IRetrievalAugmentor.ts) contains `content`, `relevanceScore`, `metadata`, and source identifiers (`originalDocumentId`, `dataSourceId`, `source`).

---

## Testing Your Guardrail

### Constructing mock payloads

```typescript
import { describe, it, expect } from 'vitest';
import { GuardrailAction, AgentOSResponseChunkType } from '@framers/agentos';
import type {
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailContext,
} from '@framers/agentos';
import type { AgentOSInput } from '@framers/agentos';
import { MyGuardrail } from '../src/MyGuardrail';

// Reusable mock context for all tests.
const mockContext: GuardrailContext = {
  userId: 'test-user',
  sessionId: 'test-session',
  personaId: 'test-persona',
  conversationId: 'test-conversation',
  mode: 'test',
};

// Helper: create a mock AgentOSInput with the given text.
function mockInput(text: string): AgentOSInput {
  return {
    textInput: text,
    sessionId: 'test-session',
    userId: 'test-user',
  } as AgentOSInput;
}

// Helper: create a mock GuardrailInputPayload.
function mockInputPayload(text: string): GuardrailInputPayload {
  return {
    context: mockContext,
    input: mockInput(text),
  };
}

// Helper: create a mock TEXT_DELTA chunk for streaming evaluation.
function mockTextDelta(text: string, streamId = 'stream-1'): GuardrailOutputPayload {
  return {
    context: mockContext,
    chunk: {
      type: AgentOSResponseChunkType.TEXT_DELTA,
      streamId,
      gmiInstanceId: 'gmi-1',
      personaId: 'test-persona',
      isFinal: false,
      timestamp: new Date().toISOString(),
      textDelta: text,
    },
  };
}

// Helper: create a mock FINAL_RESPONSE chunk.
function mockFinalResponse(text: string, streamId = 'stream-1'): GuardrailOutputPayload {
  return {
    context: mockContext,
    chunk: {
      type: AgentOSResponseChunkType.FINAL_RESPONSE,
      streamId,
      gmiInstanceId: 'gmi-1',
      personaId: 'test-persona',
      isFinal: true,
      timestamp: new Date().toISOString(),
      finalResponseText: text,
    },
  };
}
```

### Unit testing evaluateInput

```typescript
describe('MyGuardrail.evaluateInput', () => {
  it('should allow clean input', async () => {
    // Arrange: create the guardrail with a mock shared service registry.
    const guardrail = new MyGuardrail(mockServiceRegistry, {});

    // Act: evaluate clean text.
    const result = await guardrail.evaluateInput!(mockInputPayload('Hello, how are you?'));

    // Assert: null means "allow".
    expect(result).toBeNull();
  });

  it('should block prohibited content', async () => {
    const guardrail = new MyGuardrail(mockServiceRegistry, {});

    const result = await guardrail.evaluateInput!(mockInputPayload('This contains badword1 in it'));

    // Assert: BLOCK action with a reason code.
    expect(result).not.toBeNull();
    expect(result!.action).toBe(GuardrailAction.BLOCK);
    expect(result!.reasonCode).toBe('PROFANITY_INPUT_BLOCKED');
  });
});
```

### Unit testing evaluateOutput with TEXT_DELTA and FINAL_RESPONSE

```typescript
describe('MyGuardrail.evaluateOutput', () => {
  it('should allow clean final response', async () => {
    const guardrail = new MyGuardrail(mockServiceRegistry, {});

    const result = await guardrail.evaluateOutput!(mockFinalResponse('Here is a helpful answer.'));

    expect(result).toBeNull();
  });

  it('should block prohibited content in final response', async () => {
    const guardrail = new MyGuardrail(mockServiceRegistry, {});

    const result = await guardrail.evaluateOutput!(mockFinalResponse('The answer is badword1.'));

    expect(result).not.toBeNull();
    expect(result!.action).toBe(GuardrailAction.BLOCK);
  });
});
```

### Mocking ISharedServiceRegistry

```typescript
import type { ISharedServiceRegistry } from '@framers/agentos';

/**
 * A minimal mock of ISharedServiceRegistry for testing.
 * Stores services in a simple Map and supports getOrCreate, has,
 * release, and releaseAll.
 */
const mockServiceRegistry: ISharedServiceRegistry = {
  // In-memory store for test services.
  _store: new Map<string, unknown>(),

  async getOrCreate<T>(serviceId: string, factory: () => Promise<T> | T): Promise<T> {
    if (this._store.has(serviceId)) {
      return this._store.get(serviceId) as T;
    }
    const instance = await factory();
    this._store.set(serviceId, instance);
    return instance;
  },

  has(serviceId: string): boolean {
    return this._store.has(serviceId);
  },

  async release(serviceId: string): Promise<void> {
    this._store.delete(serviceId);
  },

  async releaseAll(): Promise<void> {
    this._store.clear();
  },
} as any;
```

### Integration testing via ParallelGuardrailDispatcher

To test how your guardrail behaves within the full two-phase pipeline:

```typescript
import { ParallelGuardrailDispatcher } from '@framers/agentos/safety/guardrails';

describe('Integration: ParallelGuardrailDispatcher + MyGuardrail', () => {
  it('should block input through the dispatcher', async () => {
    // Register your guardrail alongside others.
    const services = [new MyGuardrail(mockServiceRegistry, {})];

    // Run through the full two-phase dispatch.
    const outcome = await ParallelGuardrailDispatcher.evaluateInput(
      services,
      mockInput('This contains badword1'),
      mockContext
    );

    // The dispatcher's worst-wins aggregation should pick up the BLOCK.
    expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
  });
});
```

### Reference test files

- `tests/core/guardrails/ParallelGuardrailDispatcher.spec.ts` -- comprehensive dispatcher tests.
- `tests/core/guardrails.integration.spec.ts` -- integration tests for the full guardrail pipeline.

---

## Best Practices

1. **Start with final-only evaluation.** Enable `evaluateStreamingChunks` only when you need real-time filtering (PII redaction, cost ceilings). Final-only is simpler, cheaper, and has lower latency impact.

2. **Use rate limiting for streaming.** Set `maxStreamingEvaluations` to control how many TEXT_DELTA evaluations occur per stream. This is especially important for guardrails that call external APIs or ML models.

3. **Use specific reasonCodes for analytics.** Codes like `'PII_SSN_REDACTED'`, `'TOXICITY_HIGH'`, or `'COST_CEILING_EXCEEDED'` are far more useful than generic codes. These are machine-readable and can drive dashboards.

4. **Fail-open on errors, unless the guardrail is safety-critical.** The dispatcher skips a guardrail that throws, with a logged warning, unless its config sets `failClosed: true`, which turns the throw into a BLOCK. A safety-critical guardrail sets `failClosed` and lets its errors propagate; any other guardrail wraps its evaluation logic in try/catch and returns `null` on unexpected errors:

   ```typescript
   async evaluateInput(payload) {
     try {
       // ... your logic
     } catch (error) {
       console.warn('[MyGuardrail] Unexpected error, failing open:', error);
       return null; // Allow content through rather than crashing the pipeline.
     }
   }
   ```

5. **Do NOT set timeoutMs on safety-critical guardrails without `failClosed: true`.** Fail-open on timeout means content passes unchecked. Without `failClosed`, use timeoutMs only on guardrails where a missed evaluation is acceptable (e.g., quality flags, analytics).

6. **Keep guardrails focused.** One concern per guardrail. A PII guardrail should not also check for toxicity. This makes them independently testable, configurable, and composable.

7. **Set canSanitize only when you actually modify text.** If your guardrail only blocks or flags, leave `canSanitize` as `false` (the default) so it runs in the faster Phase 2 parallel path.

8. **Use ISharedServiceRegistry for anything >1MB.** ML models, NLP libraries, large dictionaries -- always go through the shared registry so multiple extensions can share the same instance.

9. **Clean up stream buffers.** If you maintain per-stream state for streaming guardrails, always delete the buffer on `isFinal` and implement a stale-cleanup mechanism for abandoned streams and for turns that stop for an external tool, whose `processRequest()` stream carries no `isFinal: true` chunk.

10. **Test with partial patterns.** When testing streaming guardrails, send patterns split across multiple TEXT_DELTA chunks to verify your buffer logic detects them correctly.

---

## Reference

### API documentation

- [IGuardrailService](/docs/api) -- the full guardrail contract.
- [GuardrailConfig](/docs/api) -- streaming, sanitization, and timeout configuration.
- [GuardrailEvaluationResult](/docs/api) -- the result shape returned by evaluations.
- [GuardrailAction](/docs/api) -- the four action types (ALLOW, FLAG, SANITIZE, BLOCK).
- [AgentOSResponseChunkType](/docs/api) -- all chunk types your guardrail may encounter.
- [ISharedServiceRegistry](/docs/api) -- lazy-loading shared service registry.
- [ExtensionPack / ExtensionDescriptor](/docs/api) -- extension packaging types.

### Built-in guardrail packs (reference implementations)

- [PII Redaction](/docs/extensions/built-in/pii-redaction) -- four-tier PII detection with sentence-boundary buffering.
- [ML Content Classifiers](/docs/extensions/built-in/ml-classifiers) -- ONNX-based toxicity, prompt injection, and jailbreak detection.
- [Topicality](/docs/extensions/built-in/topicality) -- embedding-based topic enforcement with drift tracking.
- [Code Safety](/docs/extensions/built-in/code-safety) -- OWASP Top 10 code vulnerability scanning.
- [Grounding Guard](/docs/extensions/built-in/grounding-guard) -- NLI cross-encoder + LLM-as-judge hallucination detection.

### Related documentation

- [Guardrails Overview](/docs/features/guardrails) -- conceptual overview and configuration reference.
- [Extension Architecture](/docs/extensions/extension-architecture) -- how extensions are loaded, activated, and composed.
- [How Extensions Work](/docs/extensions/how-extensions-work) -- the extension runtime lifecycle.
- [Safety Primitives](/docs/features/safety-primitives) -- broader safety architecture.
