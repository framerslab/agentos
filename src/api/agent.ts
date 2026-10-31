/**
 * @file agent.ts
 * Lightweight stateful agent factory for the AgentOS high-level API.
 *
 * Wraps {@link generateText} and {@link streamText} with per-session conversation
 * history, optional HEXACO-inspired personality shaping, and a named-agent system
 * prompt builder.  Guardrail identifiers are accepted and stored in config but
 * are not actively enforced in this lightweight layer — use the full AgentOS
 * runtime (`AgentOSOrchestrator`) or `agency()` for guardrail enforcement.
 *
 * With `runtime: 'gmi'` the agent is built by {@link gmi} instead: every session
 * is served by a Generalized Mind Instance (docs/GMI.md, "GMIs from agent()").
 */
import type { ZodType, z } from 'zod';
import {
  generateText,
  extractTextFromContent,
  type FallbackProviderEntry,
  type GenerateTextOptions,
  type GenerateTextResult,
  type GenerationHookContext,
  type GenerationHookResult,
  type Message,
  type MessageContent,
  type ToolCallHookInfo,
} from './generateText.js';
import { buildResponseFormatForProvider } from './runtime/responseFormatForProvider.js';
import { buildSchemaInstructionText, extractJson } from './runtime/structuredReply.js';
import { createLogger } from '../core/logging/loggerFactory.js';
import { resolveModelOption } from './model.js';
import { credentialsGoWith, modelNamesAnotherProvider } from './runtime/credentialOwner.js';
import { lowerZodToJsonSchema } from '../orchestration/compiler/SchemaLowering.js';
import { ObjectGenerationError } from './generateObject.js';
import { streamText, type StreamTextResult } from './streamText.js';
import type { SeatInternals } from './runtime/pool/seating.js';
import { isCallMask } from './runtime/pool/redact.js';
import { maskStreamMembers } from './runtime/pool/maskedOutput.js';
import type { HostLLMPolicy } from './runtime/hostPolicy.js';
import type { IModelRouter } from '../core/llm/routing/IModelRouter.js';
import type { SkillEntry } from '../cognition/skills/types.js';
import { loadSoulSync, parseSoul } from '../cognition/substrate/personas/SoulLoader.js';
import { renderPersonalitySection } from '../cognition/substrate/personas/personalityPrompt.js';
import type { LearningConfig, LoopManifest } from '../cognition/learning/types.js';
import type { AgencyLaunchOptions } from './runtime/agencyLaunch/types.js';
import { runCitationVerification } from './runtime/citationVerification.js';
import type {
  AgentOSUsageAggregate,
  AgentOSUsageLedgerOptions,
} from './runtime/usageLedger.js';
import {
  createEmptyUsageAggregate,
  accumulateUsage,
  mergeAggregates,
} from './runtime/usageAccumulator.js';
import { warnOnDeferredLightweightAgentCapabilities } from './runtime/lightweightAgentDiagnostics.js';
import type { BaseAgentConfig } from './types.js';
import {
  exportAgentConfig,
  exportAgentConfigJSON,
  type AgentExportConfig,
  type ExportAgentConfigOptions,
} from './agentExportCore.js';
import { applyMemoryProvider, type MemoryProviderHookOptions } from './runtime/memoryProviderHooks.js';
import { asSpendBudget, type SpendBudget, type SpendBudgetOptions } from './runtime/spendBudget.js';
import {
  SessionHistoryBuffer,
  SESSION_HISTORY_DEFAULTS,
  type HistoryEvent,
  type SessionHistoryConfig,
} from './sessionHistory.js';
import type { SessionTranscriptMessage } from './sessionTranscript.js';
import type { CognitionConfig, CognitionProfile } from './runtime/gmiCognition.js';
// gmi.ts imports this module back (through gmiPersona.ts); each side calls the other only inside functions.
import { gmi } from './gmi.js';
import type { VoiceSessionFactory, StartVoiceSession, ManagedVoiceSession } from '../io/voice-platform/VoiceSessionFactory.js';
import type { VoiceAgent } from '../io/voice-platform/contracts/index.js';

/**
 * Provider hook interface consumed by `agent()` for memory integration.
 *
 * When provided on the agent config, `getContext` is called before each
 * LLM generation to inject retrieved memory into the system prompt, and
 * `observe` is called after each turn to encode the exchange for future
 * recall. Both hooks are optional — implementations may choose to provide
 * read-only or write-only memory behavior.
 *
 * Auto-wires on every agent call path as of AgentOS 0.2.0: direct
 * `agent.stream()` / `.generate()` and `agent.session().send()` / `.stream()`
 * all invoke the hooks when the provider is present.
 */
export interface AgentMemoryProvider {
  /**
   * Retrieve a memory context block to prepend to the system prompt.
   *
   * @param text - The user input for the current turn.
   * @param opts - Retrieval options. `tokenBudget` caps the memory block size.
   * @returns An object whose `contextText` (when present) is injected as a
   *   system message before the LLM call. Returning `null` or an object
   *   without `contextText` skips injection.
   */
  getContext?: (
    text: string,
    opts?: { tokenBudget?: number },
  ) => Promise<{ contextText?: string } | null>;

  /**
   * Record an observation of a turn exchange.
   *
   * Invoked twice per turn (`role: 'user'` with the input, then
   * `role: 'assistant'` with the reply) as fire-and-forget. Rejections
   * are swallowed so memory-backend errors do not break generation.
   *
   * @param role - Whether the content came from the user or assistant.
   * @param text - Plain text content of the turn.
   */
  observe?: (
    role: 'user' | 'assistant',
    text: string,
  ) => Promise<void>;
}

/**
 * Configuration options for the {@link agent} factory function.
 *
 * Extends `BaseAgentConfig` with backward-compatible convenience fields.
 * All `BaseAgentConfig` fields are accepted. Without `runtime: 'gmi'`, the
 * lightweight agent does not apply the ones the `agent` column of the
 * capability contract defers (rag, discovery, guardrails, security,
 * permissions, emergent, voice, etc.), and one warning at construction names
 * those that are set. No surface applies `security` or `permissions`.
 */
export interface AgentOptions extends BaseAgentConfig {
  /**
   * Top-level usage ledger shorthand. When present, forwarded to
   * `observability.usageLedger` internally.
   */
  usageLedger?: AgentOSUsageLedgerOptions;
  /**
   * Chain-of-thought reasoning instruction.
   * - `false` — disable CoT injection.
   * - `true` (default for agents) — inject the default CoT instruction when tools are present.
   * - `string` — inject a custom CoT instruction when tools are present.
   */
  chainOfThought?: boolean | string;
  /**
   * Ordered list of fallback providers to try when the primary provider
   * fails with a retryable error (HTTP 402/429/5xx, network errors).
   *
   * **Defaults to auto-built chain** when omitted — fallback is on by
   * default. Pass `[]` for strict single-provider mode, or supply a
   * custom array to control the chain. Applied to every `generate()`,
   * `stream()`, and `session.send()` / `session.stream()` call made
   * through this agent.
   *
   * @see {@link GenerateTextOptions.fallbackProviders}
   */
  fallbackProviders?: FallbackProviderEntry[];
  /**
   * Callback invoked when a fallback provider is about to be tried.
   *
   * @param error - The error that triggered the fallback.
   * @param fallbackProvider - The provider identifier being tried next.
   */
  onFallback?: (error: Error, fallbackProvider: string) => void;
  /** Model router for intelligent provider selection per-call. */
  router?: IModelRouter;
  /** Host-level routing hints forwarded to the high-level generation helpers. */
  hostPolicy?: HostLLMPolicy;
  /**
   * One spend budget for every call this agent and its sessions make: each provider call is checked against what is
   * left before it is made and recorded after it, and {@link AgentSession.recordExternalCost} charges costs made
   * outside AgentOS to it. Settings make one {@link SpendBudget} for the agent; pass an instance to share it wider.
   * With `runtime: 'gmi'` every completion call a GMI makes is checked against it before it is sent, metaprompts and
   * self-reflection included; its cognitive memory's embeddings and the learning layer's own calls are not counted.
   * A seat's turn (`sessionSeat()`, or a member a launched team seats) is checked against it and charged to it beside the
   * budget its team's call carries, and so is a team the seat's turn launches; its refusal of a seat's call runs the
   * carried budget's `onLimitReached` function, as a refusal by that budget's parent does.
   */
  budget?: SpendBudget | SpendBudgetOptions;
  /**
   * Caller's intended content policy tier, forwarded to every `generate()` /
   * `stream()` / session call this agent makes (same contract as
   * {@link GenerateTextOptions.policyTier}): on `'mature'` / `'private-adult'`
   * with no explicit `fallbackProviders`, the auto-built fallback chain
   * leads with the tier's uncensored legs so a content-policy refusal from
   * the primary re-routes to a model that can complete the request, and the
   * model router receives the tier as a routing hint. Unset, the chain
   * follows the tier the call otherwise resolves to (a host policy's tier or
   * the router's default tier); with no tier anywhere it is the
   * availability-only chain. A per-call `policyTier` in `extra` overrides
   * this value.
   */
  policyTier?: GenerateTextOptions['policyTier'];
  /**
   * Routing hints passed to the model router's `selectModel()` call.
   *
   * Useful for declaring capability requirements up-front so the router
   * can pick a model that actually supports what the agent needs:
   *
   * ```ts
   * agent({
   *   name: 'World Architect',
   *   router: policyAwareRouter,
   *   routerParams: { requiredCapabilities: ['json_mode'] },
   *   output: WorldIdentitySchema,
   * });
   * ```
   *
   * When omitted, the router receives a minimal default params object
   * (taskHint only, plus `function_calling` in requiredCapabilities when
   * tools are declared).
   */
  routerParams?: Partial<import('../core/llm/routing/IModelRouter.js').ModelRouteParams>;
  /**
   * Optional Zod schema for validating the LLM's structured output.
   *
   * When provided, the agent's `generate()` result includes a `parsed` field
   * with the Zod-validated and typed output. JSON extraction and validation
   * happen after generation. On validation failure,
   * the agent retries internally (up to `controls.maxValidationRetries ?? 1`).
   *
   * When omitted, behavior is unchanged — `result.parsed` is undefined.
   * This is a non-breaking additive change.
   *
   * @example
   * ```ts
   * import { z } from 'zod';
   * const myAgent = agent({
   *   name: 'Extractor',
   *   instructions: 'Extract entities as JSON',
   *   responseSchema: z.object({ entities: z.array(z.string()) }),
   * });
   * const result = await myAgent.generate('Find entities in: ...');
   * console.log(result.parsed?.entities); // string[]
   * ```
   */
  responseSchema?: import('zod').ZodType;
  /**
   * Pre-generation hook, called before each LLM step. On the GMI path with `learning` on, its `system` is the
   * persona's base prompt, which holds no personality section; the system text in `messages` holds the section after
   * the base prompt.
   */
  onBeforeGeneration?: (context: GenerationHookContext) => Promise<GenerationHookContext | void>;
  /** Post-generation hook, called after each LLM step. */
  onAfterGeneration?: (result: GenerationHookResult) => Promise<GenerationHookResult | void>;
  /** Pre-tool-execution hook. */
  onBeforeToolExecution?: (info: ToolCallHookInfo) => Promise<ToolCallHookInfo | null>;
  /**
   * Optional memory provider. When provided, memory auto-wires on all four
   * agent call paths (see {@link AgentMemoryProvider} for hook contract).
   *
   * - `getContext` runs before each LLM call; result prepended as a system
   *   message.
   * - `observe` runs as fire-and-forget after each LLM call, except schema
   *   calls, which observe only the accepted exchange after validation.
   */
  memoryProvider?: AgentMemoryProvider;
  /**
   * Optional tunables for the automatic {@link memoryProvider} hooks.
   * `timeoutMs` bounds each `getContext` call before the turn ships without
   * memory (default `MEMORY_TIMEOUT_MS`, 5000); `tokenBudget` is forwarded to
   * `getContext` as the recall ceiling (default `DEFAULT_MEMORY_TOKEN_BUDGET`,
   * 2000). Both fall back to the historical module constants when omitted.
   */
  memoryProviderOptions?: MemoryProviderHookOptions;
  /**
   * Optional skill entries to inject into the system prompt.
   * Skill content is appended to the system prompt as markdown sections.
   */
  skills?: SkillEntry[];
  /**
   * Structured system prompt blocks with cache breakpoints.
   * When provided, takes precedence over the assembled string from
   * `instructions`, `name`, `personality`, and `skills`.
   * Use this for prompt caching support with Anthropic.
   */
  systemBlocks?: import('./generateText.js').SystemContentBlock[];
  /**
   * Per-call prompt-cache control forwarded to every generate / stream /
   * session call this agent makes (same contract as
   * {@link GenerateTextOptions.cache}): `false` sends zero cache markers;
   * `{ ttl: '1h' }` re-times the auto markers — including the moving
   * conversation-history tail — onto the 1-hour cache. Set `'1h'` for agent
   * loops whose steps gap past the 5-minute default cache TTL (multi-minute
   * tool executions between LLM steps), where the default-paced history
   * marker expires between steps and every step re-writes the whole prefix.
   * Unset -> the provider's default marker pacing.
   */
  cache?: import('./generateText.js').GenerateTextOptions['cache'];
  /**
   * Session conversation-history policy (spec 2026-07-20 §1a/§1c). Sessions
   * maintain a lossless transcript by default — independent of the memory
   * subsystem — bounded past `maxTokens` (default 120K estimated) by
   * chunk-amortized whole-block eviction. `false` restores stateless
   * sessions (the pre-0.10 `memory: false` behavior). Partial objects
   * override individual bounds.
   */
  history?: false | Partial<SessionHistoryConfig>;
  /**
   * Per-agent identity loaded from a SOUL.md workspace (the OpenClaw / aaronjmars-soul.md
   * convention). Three forms are accepted:
   *
   * - **Workspace path** — points at a directory containing SOUL.md and optional
   *   companion files (STYLE.md, IDENTITY.md, AGENTS.md, MEMORY.md, examples/):
   *   ```ts
   *   agent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });
   *   ```
   *
   * - **Direct file path** — points at a single SOUL.md file:
   *   ```ts
   *   agent({ provider: 'anthropic', soul: './personas/aria.soul.md' });
   *   ```
   *
   * - **Inline content** — pass the soul markdown directly (useful for tests and
   *   ephemeral agents):
   *   ```ts
   *   agent({ provider: 'anthropic', soul: { content: SOUL_MARKDOWN_STRING } });
   *   ```
   *
   * Loading semantics: at agent boot the runtime reads SOUL.md, parses YAML
   * frontmatter into an `IPersonaDefinition` (HEXACO traits, voice, mood,
   * hardLimits), and injects the markdown body as the FIRST system message —
   * before `instructions`, `chainOfThought`, `personality`, or `skills`. STYLE.md
   * is appended as a second system message when present.
   *
   * @see `loadSoul` in `@framers/agentos/cognition/substrate/personas/SoulLoader`
   * for the loader implementation and full SOUL.md format spec.
   * @see https://github.com/aaronjmars/soul.md for the cross-framework convention.
   */
  soul?: string | { content: string } | { path: string };
  /**
   * Which engine serves this agent. `'legacy'` (the default) calls the model through
   * generateText and streamText; `'gmi'` serves every session with a Generalized Mind
   * Instance (docs/GMI.md, "GMIs from agent()").
   */
  runtime?: 'legacy' | 'gmi';
  /**
   * GMI profile when `runtime` is `'gmi'`: `'light'` (the default), `'full'`, or each
   * switch set in a {@link CognitionConfig}.
   */
  cognition?: CognitionProfile | CognitionConfig;
  /**
   * The learning layer when `runtime` is `'gmi'` (docs/GMI.md, "Learning"). Unset, `false` or `null`: off, and the
   * agent runs as it did before the layer existed. `true` or a {@link LearningConfig}: the agent's GMIs send the
   * personality section as a system prompt of its own on every turn, and each session opened with a user id is
   * bound to a learner. The legacy runtime ignores it.
   */
  learning?: boolean | LearningConfig;
  /**
   * Temporary teams this agent launches from a turn, with `runtime: 'gmi'`: `launch: true` registers the
   * `launch_agency` tool, which runs an `agency()` team on one goal and returns its answer as the call's result, and
   * the other fields bound every launch (depth, seats, launches in flight, budget share and pool, deadline, `members`
   * a launch may seat by key, `hitl`). Every bound is checked at construction. Off unless `launch` is true; the legacy
   * runtime throws when it is.
   */
  agencies?: AgencyLaunchOptions;
  /** Explicit runtime binding. No provider is discovered from the process environment for this path. */
  voice?: BaseAgentConfig['voice'] & { session?: { factory: VoiceSessionFactory; agent: VoiceAgent } };
}

/**
 * What a host reads of an agent's learning layer ({@link Agent.learning}).
 */
export interface AgentLearning {
  /** Which loops the agent runs, and for each one that is off, why. */
  manifest(): Promise<LoopManifest>;
}

/**
 * Options for a single {@link AgentSession.send} call.
 */
export interface SessionSendOptions<S extends ZodType | undefined = undefined> {
  /**
   * Zod schema describing the expected shape of the assistant reply. When
   * present, agentos converts the schema to JSON Schema, routes through
   * the provider's native structured-output API (OpenAI json_schema;
   * Anthropic's JSON output format, or a forced tool call for a schema
   * the format cannot carry; Gemini responseSchema), and returns a
   * Zod-validated typed object on `result.object` alongside the JSON
   * string in `result.text`. A call whose provider payload carries no
   * schema (a provider with none, a record schema on an Anthropic model
   * that refuses a forced tool choice, JSON-object mode) gets the schema
   * in its system prompt, in the words `generateObject` uses; each
   * fallback provider is checked for its own payload.
   *
   * The agent's tools are left out of a schema request, and with them the
   * chain-of-thought instruction; `runtime: 'legacy'` (the default) warns
   * that it leaves them out.
   */
  responseSchema?: S;
  /**
   * Display name for the schema in provider payloads. Surfaces in OpenAI's
   * json_schema.name and Anthropic's tool name. Defaults to 'response'.
   * Sanitized to /[a-zA-Z0-9_]/ and truncated to 64 chars.
   */
  schemaName?: string;
  /** Extra schema-validation attempts on the default runtime. Defaults to 0. */
  maxValidationRetries?: number;
  /**
   * Telemetry + eviction-boundary label for this send's transcript block
   * (spec §1c(iv)). Labels are markers, not pins.
   */
  blockLabel?: string;
  /**
   * Per-send generation overrides, merged over the agent's baseOpts with
   * send-level precedence — the same contract `generate(prompt, extra)`
   * gives `extra` (spec §1f). Long tool-driving loops rely on these
   * (toolChoice, requestTimeout, cacheDiagnostics); without send-level
   * carriage a caller migrating from generate() silently loses them.
   */
  toolChoice?: GenerateTextOptions['toolChoice'];
  requestTimeout?: number;
  cacheDiagnostics?: GenerateTextOptions['cacheDiagnostics'];
  cache?: GenerateTextOptions['cache'];
  maxTokens?: number;
  /**
   * Ends this send when it aborts: the provider request in flight is cancelled, no further step, retry or fallback
   * hop starts, and the send rejects with the signal's reason. The session stays open. With the default runtime
   * nothing of the send is added to the session's history; with `runtime: 'gmi'` the turn ends as `close()` ends
   * one, and the steps it finished stay in `messages()`, marked partial.
   */
  abortSignal?: AbortSignal;
  /**
   * A spend budget for this send in place of the agent's: every provider call of the send is checked against it
   * before it is made and recorded after it (settings make a new {@link SpendBudget} for the send). With
   * `runtime: 'gmi'`, every completion call of the turn, metaprompts included.
   */
  budget?: SpendBudget | SpendBudgetOptions;
}

/**
 * Result returned by {@link AgentSession.send} when `responseSchema` is set.
 * Extends {@link GenerateTextResult} with a typed Zod-validated `object`.
 */
export interface SessionSendStructuredResult<T> extends GenerateTextResult {
  /** Zod-validated typed object. */
  object: T;
}

/**
 * A named conversation session returned by `Agent.session()`.
 * Maintains its own message history independently of other sessions on the same agent.
 */
export interface AgentSession {
  /** Stable session identifier supplied to or auto-generated by `Agent.session()`. */
  readonly id: string;
  /**
   * Sends a user message and returns the complete assistant reply.
   * Appends the send's lossless transcript delta to the session history
   * (disable with `history: false` on the agent config).
   * Accepts plain text or multimodal content (text + image parts).
   *
   * @param input - User message as text string or MessageContent array.
   * @param opts - Per-send options without a `responseSchema`: the generation overrides, `abortSignal` and `budget`.
   * @returns The full generation result including text, usage, and tool calls.
   */
  send(input: MessageContent, opts?: SessionSendOptions): Promise<GenerateTextResult>;
  /**
   * Sends a user message with a Zod schema enforced server-side via the
   * provider's native structured-output API. The reply is parsed and
   * validated; the typed object is returned on `result.object` alongside
   * the JSON string in `result.text`. Session history is appended just
   * as in the text-only path, so subsequent `send` calls see the
   * structured response in their conversation context.
   *
   * @throws {ObjectGenerationError} If the provider returns
   *         schema-enforced JSON that nonetheless fails Zod validation
   *         after `maxValidationRetries` extra attempts (default 0).
   *
   * @param input - User message as text string or MessageContent array.
   * @param opts - Must include `responseSchema`.
   * @returns Result with a typed `object: z.infer<S>` field.
   */
  send<S extends ZodType>(
    input: MessageContent,
    opts: SessionSendOptions<S> & { responseSchema: S },
  ): Promise<SessionSendStructuredResult<z.infer<S>>>;
  /**
   * Streams a user message and returns streaming iterables.
   * The assistant reply is appended to session history once the `text` promise resolves.
   * Accepts plain text or multimodal content (text + image parts).
   *
   * @param input - User message as text string or MessageContent array.
   * @param opts - `abortSignal` ends this stream when it aborts, as {@link SessionSendOptions.abortSignal} ends a
   *   send: the provider's stream stops and the stream ends with an `error` part. The session stays open. `budget`
   *   takes the agent's place for this stream, as {@link SessionSendOptions.budget} takes it for a send.
   * @returns A {@link StreamTextResult} with async iterables and awaitable aggregates.
   */
  stream(input: MessageContent, opts?: { abortSignal?: AbortSignal; budget?: SpendBudget | SpendBudgetOptions }): StreamTextResult;
  /**
   * Returns a snapshot of the current conversation transcript for this
   * session in provider-replayable shape (assistant tool_calls, tool
   * results with ids, thinking blocks). Suitable as checkpoint material
   * for {@link AgentSession.reseed}.
   */
  messages(): SessionTranscriptMessage[];
  /**
   * Atomically replaces the session history with a caller-built compact
   * snapshot — the divergence-reset primitive (spec §1d). Bumps the
   * history epoch: an in-flight send that began under an older epoch
   * still returns to its caller, but its history append is discarded.
   * Throws when the snapshot violates tool_use/tool_result pairing.
   */
  reseed(snapshot: SessionTranscriptMessage[]): void;
  /** Returns accumulated history telemetry events (evictions, reseeds,
   *  stale-append discards) and clears the queue. */
  drainHistoryEvents(): HistoryEvent[];
  /** Returns persisted usage totals for this session when the usage ledger is enabled. */
  usage(): Promise<AgentOSUsageAggregate>;
  /**
   * Charges a cost made outside AgentOS (speech-to-text minutes, a tool's own API) to the agent's budget; does nothing
   * without one. With a budget, a cost of zero or below records nothing, and a cost that is not a number throws a
   * `RangeError`.
   */
  recordExternalCost(costUSD: number, meta?: { kind?: string }): void;
  /** Clears all messages from this session's history. */
  clear(): void;
  /**
   * Ends this session and releases its history. A send still running is returned
   * to its caller but added to no history, and the next `agent.session(id)` with
   * this id starts empty. The id's usage totals stay readable through
   * `agent.usage(id)`. With `runtime: 'gmi'`, a send or stream still running is
   * stopped instead: its model call is aborted, its caller gets the abort error,
   * and the steps it had finished stay in this session's `messages()`, marked
   * partial; then the session's GMI is shut down.
   */
  close(): Promise<void>;
}

/**
 * Options for {@link Agent.session}.
 */
export interface AgentSessionOptions {
  /**
   * The user the session serves. With `runtime: 'gmi'` it scopes the session's
   * cognitive memory: sessions opened with the same user id recall each other's
   * facts, and a session opened without one has a scope of its own, its session
   * id. The GMI also sends it with each model request as the end user's id
   * (OpenAI's `user` or `safety_identifier`), so pass an opaque or hashed id,
   * not an email address; a session opened without one sends none. Asking for an
   * open session with another user id throws. The legacy runtime ignores it.
   */
  userId?: string;
}

/**
 * A stateful agent instance returned by {@link agent}.
 *
 * @category Core
 */
export interface Agent {
  /**
   * Generates a single reply without maintaining session history.
   * Accepts plain text or multimodal content (text + image parts).
   *
   * @param prompt - User prompt as text string or MessageContent array.
   * @param opts - Optional overrides merged on top of the agent's base options.
   * @returns The complete generation result.
   */
  generate(prompt: MessageContent, opts?: Partial<GenerateTextOptions>): Promise<GenerateTextResult>;
  /**
   * Streams a single reply without maintaining session history.
   * Accepts plain text or multimodal content (text + image parts).
   *
   * @param prompt - User prompt as text string or MessageContent array.
   * @param opts - Optional overrides merged on top of the agent's base options.
   * @returns A {@link StreamTextResult}.
   */
  stream(prompt: MessageContent, opts?: Partial<GenerateTextOptions>): StreamTextResult;
  /**
   * Returns (or creates) a named {@link AgentSession} with its own conversation history.
   *
   * @param id - Optional session ID. A unique ID is generated when omitted.
   * @param options - The session's user; see {@link AgentSessionOptions}.
   * @returns The session object for this ID.
   */
  session(id?: string, options?: AgentSessionOptions): AgentSession;
  /** Returns persisted usage totals for the whole agent or a single session. */
  usage(sessionId?: string): Promise<AgentOSUsageAggregate>;
  /** Releases all in-memory session state held by this agent. */
  close(): Promise<void>;
  /**
   * The agent's learning layer as its host reads it. Set only with `runtime: 'gmi'` and `learning` on.
   */
  learning?: AgentLearning;
  /**
   * Exports the agent's configuration as a portable object. Secrets are
   * redacted unless `options.redactSecrets` is `false`.
   * @param metadata - Optional human-readable metadata to attach.
   * @param options - Redaction options.
   * @returns A portable {@link AgentExportConfig} object.
   */
  export(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): AgentExportConfig;
  /**
   * Exports the agent's configuration as a pretty-printed JSON string. Secrets
   * are redacted unless `options.redactSecrets` is `false`.
   * @param metadata - Optional human-readable metadata to attach.
   * @param options - Redaction options.
   * @returns JSON string.
   */
  exportJSON(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): string;
  /** Read current avatar binding state (auto-populated from mood/voice/relationship). */
  getAvatarBindings(): import('./types').AvatarBindingInputs & Record<string, unknown>;
  /** Inject game-specific binding overrides (healthBand, combatMode, etc.). */
  setAvatarBindingOverrides(overrides: Record<string, unknown>): void;
  /** Prepares the configured scoped voice call; present only with voice.session. */
  voiceSession?(request: Omit<StartVoiceSession, 'agent'>): Promise<ManagedVoiceSession>;
}

function mergeUsageLedgerOptions(
  ...parts: Array<AgentOSUsageLedgerOptions | undefined>
): AgentOSUsageLedgerOptions | undefined {
  const merged = Object.assign({}, ...parts.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function loadRecordedAgentOSUsage(
  options?: Pick<AgentOSUsageLedgerOptions, 'enabled' | 'path' | 'sessionId' | 'personaId'>
): Promise<AgentOSUsageAggregate> {
  const { getRecordedAgentOSUsage } = await import('./runtime/usageLedger.js');
  return getRecordedAgentOSUsage(options);
}

export function buildSystemPrompt(opts: AgentOptions): string | undefined {
  const sections: string[] = [];

  // SOUL.md content first — the agent's identity comes before everything else.
  // See `loadSoul` in cognition/substrate/personas/SoulLoader.
  if (opts.soul) {
    const loaded = loadSoulFromOption(opts.soul);
    if (loaded?.soulContent) {
      sections.push(loaded.soulContent);
    }
    if (loaded?.styleContent) {
      sections.push(`## Style\n\n${loaded.styleContent}`);
    }
    // The memory wiki's index.md catalog. The agent reads it to know what it
    // remembers, then pulls full pages via the read_memory_page tool. Skip the
    // empty catalog (a bare "# Memory Index") so agents with no memory yet keep
    // a clean prompt.
    if (loaded?.wikiIndex?.trim() && loaded.wikiIndex.trim() !== '# Memory Index') {
      sections.push(
        '## Long-Term Memory (index)\n\n' +
          'You maintain a memory wiki. This is its index. ' +
          'Use the `read_memory_page` tool to open any page by id.\n\n' +
          loaded.wikiIndex.trim(),
      );
    }
  }

  if (opts.instructions?.trim()) {
    sections.push(opts.instructions.trim());
  }

  if (opts.name?.trim()) {
    sections.push(`Assistant name: ${opts.name.trim()}.`);
  }

  if (opts.personality) {
    const desc = renderPersonalitySection(opts.personality);
    if (desc) {
      sections.push(desc);
    }
  }

  // Append skill content as markdown sections
  if (opts.skills?.length) {
    for (const entry of opts.skills) {
      if (entry.skill.content?.trim()) {
        sections.push(entry.skill.content.trim());
      }
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/**
 * Passes every error that leaves a stream result through `mask`: thrown by
 * the iterables, carried by an error part, or rejecting any of the result's
 * promises. With an agency's call mask, what the seat answers leaves masked
 * too: its streamed text, a secret split between two pieces included, its
 * other parts and every value its promises settle to
 * ({@link maskStreamMembers}). With a bare error mask the result's other
 * members are returned as they are.
 *
 * @param result - The stream result `streamText` returned for a seated config.
 * @param mask - The seat's mask.
 * @returns A stream result with the same members, whose errors come out masked.
 */
function maskStreamResult(result: StreamTextResult, mask: (error: unknown) => unknown): StreamTextResult {
  if (isCallMask(mask)) return maskStreamMembers(result, mask);
  const wrapIterable = <T>(iterable: AsyncIterable<T>, mapPart: (part: T) => T): AsyncIterable<T> => ({
    async *[Symbol.asyncIterator]() {
      try {
        for await (const part of iterable) yield mapPart(part);
      } catch (error) {
        throw mask(error);
      }
    },
  });
  const out = { ...result } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof (value as Promise<unknown>).then === 'function') {
      out[key] = (value as Promise<unknown>).then(
        (settled) => settled,
        (error: unknown) => {
          throw mask(error);
        },
      );
    }
  }
  out.textStream = wrapIterable(result.textStream, (text) => text);
  out.fullStream = wrapIterable(result.fullStream, (part) =>
    part.type === 'error' ? { ...part, error: mask(part.error) as Error } : part,
  );
  return out as unknown as StreamTextResult;
}

/**
 * Resolve an `AgentOptions.soul` value (string path | { content } | { path })
 * into a `LoadedSoul`. Returns null on failure so the agent can still boot
 * (the soul is additive, not load-blocking).
 */
export function loadSoulFromOption(
  soul: NonNullable<AgentOptions['soul']>,
): import('../cognition/substrate/personas/SoulLoader.js').LoadedSoul | null {
  try {
    if (typeof soul === 'string') {
      return loadSoulSync({ source: soul });
    }
    if ('content' in soul) {
      return parseSoul(soul.content);
    }
    if ('path' in soul) {
      return loadSoulSync({ source: soul.path });
    }
    return null;
  } catch (err) {
    // Non-fatal: missing soul file logs once and the agent boots without it.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[@framers/agentos] Failed to load soul: ${(err as Error).message}. Agent will boot without SOUL.md identity.`,
      );
    }
    return null;
  }
}

/**
 * Copies only the defined per-send generation overrides off SessionSendOptions
 * (spec §1f) so undefined keys never clobber agent-level baseOpts via spread.
 */
function pickSendGenerationOverrides(
  sendOpts?: SessionSendOptions<ZodType>,
): Partial<GenerateTextOptions> {
  if (!sendOpts) return {};
  const out: Partial<GenerateTextOptions> = {};
  if (sendOpts.toolChoice !== undefined) out.toolChoice = sendOpts.toolChoice;
  if (sendOpts.requestTimeout !== undefined) out.requestTimeout = sendOpts.requestTimeout;
  if (sendOpts.cacheDiagnostics !== undefined) out.cacheDiagnostics = sendOpts.cacheDiagnostics;
  if (sendOpts.cache !== undefined) out.cache = sendOpts.cache;
  if (sendOpts.maxTokens !== undefined) out.maxTokens = sendOpts.maxTokens;
  if (sendOpts.abortSignal !== undefined) out.abortSignal = sendOpts.abortSignal;
  // Settings become one budget here, so a send's validation retries are charged to the same one.
  if (sendOpts.budget !== undefined) out.budget = asSpendBudget(sendOpts.budget);
  return out;
}

/** Observe a validated exchange without letting memory failures reject it. */
function observeValidatedExchange(
  provider: AgentMemoryProvider | undefined,
  userText: string,
  replyText: string,
): void {
  if (!provider?.observe) return;
  for (const [role, text] of [['user', userText], ['assistant', replyText]] as const) {
    if (role === 'assistant' && !text) continue;
    try {
      void provider.observe(role, text).catch(() => { /* fire-and-forget */ });
    } catch {
      // A synchronous observation failure is also non-fatal.
    }
  }
}

/** Generate a reply with optional JSON validation and bounded repair turns. */
async function generateWithValidation(
  options: GenerateTextOptions,
  schema: ZodType | undefined,
  maxRetries: number,
  extract: boolean,
  onResult: (result: GenerateTextResult) => void,
  memory: { provider?: AgentMemoryProvider; userText: string; options?: MemoryProviderHookOptions },
): Promise<{ result: GenerateTextResult; object: unknown; retried: boolean }> {
  if (schema && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new RangeError('maxValidationRetries must be a non-negative integer');
  }
  // Schema attempts retain recall and caller hooks, but only an accepted
  // result may write to memory. Bind recall to preserve provider instances.
  const attemptMemory = schema && memory.provider
    ? { getContext: memory.provider.getContext?.bind(memory.provider) }
    : memory.provider;
  let request = applyMemoryProvider(options, attemptMemory, memory.userText, memory.options) as GenerateTextOptions;
  for (let attempt = 0; ; attempt++) {
    const result = await generateText(request);
    onResult(result);
    if (!schema) return { result, object: undefined, retried: false };

    let failure: ObjectGenerationError;
    try {
      const parsed = extract ? extractJson(result.text) : JSON.parse(result.text);
      const safe = schema.safeParse(parsed);
      if (safe.success) {
        observeValidatedExchange(memory.provider, memory.userText, result.text);
        return { result, object: safe.data, retried: attempt > 0 };
      }
      failure = new ObjectGenerationError('Response failed Zod validation', result.text, safe.error);
    } catch (err) {
      failure = new ObjectGenerationError(
        `Response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        result.text,
      );
    }
    if (attempt >= maxRetries) throw failure;
    const feedback = failure.validationErrors?.message ?? failure.message;
    const priorMessages = request.messages ?? [];
    const repairMessages: Message[] = result.transcriptDelta
      ? [
          ...priorMessages.slice(0, priorMessages.length - (request._transcriptIncludeTrailingCallerMessages ?? 0)),
          ...(result.transcriptDelta as unknown as Message[]),
        ]
      : [
          ...priorMessages,
          ...(request.prompt !== undefined ? [{ role: 'user' as const, content: request.prompt }] : []),
          { role: 'assistant', content: result.text },
        ];
    request = {
      ...request,
      prompt: undefined,
      // Repair from completed tool results without permitting another action.
      tools: undefined,
      toolChoice: undefined,
      _transcriptIncludeTrailingCallerMessages: 0,
      messages: [
        ...repairMessages,
        { role: 'user', content: `Your reply did not match the schema: ${feedback}. Reply again with JSON that matches it.` },
      ],
    };
  }
}

/**
 * Creates a lightweight stateful agent backed by in-memory session storage.
 *
 * The agent wraps {@link generateText} and {@link streamText} with a persistent
 * system prompt built from `instructions`, `name`, and `personality` fields.
 * Multiple independent sessions can be opened via `Agent.session()`.
 *
 * With `runtime: 'gmi'`, `agent(opts)` returns `gmi(opts)`: the same `Agent`
 * surface, with every session served by a Generalized Mind Instance built from
 * these options, and the construction checks and diagnostics of that path.
 *
 * @param opts - Agent configuration. Deferred fields are reported at construction.
 *   Voice is applied only through an explicit `voice.session` binding and the
 *   returned `voiceSession()` method. Ordinary generate/stream/session calls
 *   remain text calls. The full runtime does not apply the voice flag.
 * @returns An {@link Agent} instance with `generate`, `stream`, `session`, and `close` methods.
 * @throws {Error} With `runtime: 'gmi'`, at construction, naming an option the GMI path
 *   cannot honour (see {@link gmi}); without it, when `agencies.launch` is set, which only
 *   the GMI path runs.
 *
 * @example
 * ```ts
 * const myAgent = agent({ provider: 'openai', model: 'gpt-4o', instructions: 'You are a helpful assistant.' });
 * const session = myAgent.session('user-123');
 * const reply = await session.send('Hello!');
 * console.log(reply.text);
 * ```
 *
 * @category Core
 */
export function agent(opts: AgentOptions): Agent {
  if (opts.voice?.session) {
    const keys = Object.keys(opts.voice);
    if (opts.runtime === 'gmi' || opts.voice.enabled !== true || keys.some((key) => !['enabled', 'session'].includes(key)) || Object.keys(opts.voice.session).some((key) => !['factory', 'agent'].includes(key))) throw new Error('configured voice fields refused');
  }
  // Before anything of the legacy path runs: its diagnostics and warnings describe that path.
  if (opts.runtime === 'gmi') return gmi(opts);
  // A legacy agent has no tool loop of a GMI to run launch_agency in; taking the option would offer no tool.
  if (opts.agencies?.launch === true) {
    throw new Error("agent(): agencies.launch runs on the GMI path; set runtime: 'gmi' or use gmi().");
  }
  const sessionBuffers = new Map<string, SessionHistoryBuffer | null>();
  // In-memory usage tally per session and per agent. Populated synchronously
  // after every generate/send/stream call so `agent.usage()` and
  // `session.usage()` work even when the persisted ledger is disabled (the
  // common case). The persisted ledger is still merged in at read time so
  // cross-process / historical totals continue to roll up correctly.
  const sessionUsageTallies = new Map<string, AgentOSUsageAggregate>();
  const agentUsageTally: AgentOSUsageAggregate = createEmptyUsageAggregate();
  // One budget for every call this agent and its sessions make, and for the
  // costs a session records from outside AgentOS.
  const agentBudget = asSpendBudget(opts.budget);
  let avatarBindingOverrides: Record<string, unknown> = {};
  warnOnDeferredLightweightAgentCapabilities(opts.voice?.session ? { ...opts, voice: undefined } : opts);

  /*
   * The cognitive mechanisms run inside a CognitiveMemoryManager, which this
   * lightweight helper never constructs, so a `cognitiveMechanisms` config
   * cannot take effect here. Say so instead of accepting it silently.
   */
  if (opts.cognitiveMechanisms != null) {
    console.warn(
      '[AgentOS] agent() accepted a cognitiveMechanisms config, but the lightweight helper does not run ' +
      'the cognitive mechanisms. Initialize a CognitiveMemoryManager with `cognitiveMechanisms`, or supply ' +
      'one through gmiManagerConfig.cognitiveMemoryFactory on the full runtime, to use them.',
    );
  }

  /*
   * Resolve the effective usage ledger config.  The top-level `usageLedger`
   * field is a backward-compat alias — if it is present we forward it to
   * `observability.usageLedger`.  An explicit `observability.usageLedger`
   * takes precedence when both are supplied.
   */
  const effectiveLedger: AgentOSUsageLedgerOptions | undefined =
    (opts.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? opts.usageLedger;

  // What an agency's seating writes onto a seated config: strict provider
  // resolution, and the call's error mask, which every error that leaves
  // generate() or stream() passes through before a strategy sees it.
  const seatInternals = opts as AgentOptions & Partial<SeatInternals>;
  const maskError = seatInternals.__maskError;

  const baseOpts: Partial<GenerateTextOptions> = {
    provider: opts.provider,
    model: opts.model,
    system: opts.systemBlocks ?? buildSystemPrompt(opts),
    tools: opts.tools,
    maxSteps: opts.maxSteps ?? 5,
    // Per-call completion-token cap applied to every generate /
    // session.send / stream invocation this agent makes. Falls back to
    // controls.maxTotalTokens when no top-level maxTokens is set: on the
    // lightweight agent() surface the token control caps each call's
    // completion output (mapped here to maxTokens), NOT the agency()-level
    // prompt+completion run total, which stays a full-runtime enforcement.
    // Unset means the underlying generateText falls back to the provider
    // default. A per-call maxTokens in `extra` overrides both.
    maxTokens: opts.maxTokens ?? opts.controls?.maxTotalTokens,
    // Per-call request timeout (ms) derived from the declared
    // controls.maxDurationMs budget: on the lightweight agent() surface the
    // duration control bounds each individual LLM request (generateText
    // requestTimeout), not the whole run's wall clock, which stays an
    // agency()-level enforcement. Unset keeps the provider's default
    // failover pacing. A per-call requestTimeout in `extra` overrides this.
    requestTimeout: opts.controls?.maxDurationMs,
    // Extended-thinking switch forwarded to Claude models on every generate /
    // stream / session call (both spread baseOpts): `{ budgetTokens }` turns
    // thinking on, `false` turns it off, unset keeps the model's default.
    thinking: opts.thinking,
    // Reasoning-effort control forwarded the same way as thinking (both spread
    // into baseOpts -> every generate/stream/session call). Unset -> provider
    // default; the provider ignores it on models that don't support effort.
    effort: opts.effort,
    // Provider-specific top-level payload params (e.g. OpenRouter
    // provider-routing preferences) forwarded to every generate / stream /
    // session call this agent makes. Unset adds no payload keys.
    customModelParams: opts.customModelParams,
    // Per-call prompt-cache disposition forwarded like thinking/effort (both
    // spread baseOpts -> every generate/stream/session call this agent
    // makes). Unset keeps the provider's default marker pacing.
    cache: opts.cache,
    chainOfThought: opts.chainOfThought ?? true,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    usageLedger: effectiveLedger,
    fallbackProviders: opts.fallbackProviders,
    onFallback: opts.onFallback,
    router: opts.router,
    hostPolicy: opts.hostPolicy,
    routerParams: opts.routerParams,
    // Agent-level content policy tier forwarded to every generate / stream /
    // session call (both spread baseOpts). Unset keeps the availability-only
    // auto fallback chain and tier-agnostic routing.
    policyTier: opts.policyTier,
    onBeforeGeneration: opts.onBeforeGeneration,
    onAfterGeneration: opts.onAfterGeneration,
    onBeforeToolExecution: opts.onBeforeToolExecution,
    // Set by an agency's seating: strict provider resolution on every call
    // and every failover hop.
    ...(seatInternals.__strictCredentials ? { __strictCredentials: true } : {}),
    // The call's mask reaches the tool loops, which mask a tool's error
    // before they write it anywhere.
    ...(maskError ? { __maskError: maskError } : {}),
    // The agent's one budget, on every generate / stream / session call
    // (each spreads baseOpts). A `budget` passed to generate() or stream()
    // replaces it for that call.
    ...(agentBudget ? { budget: agentBudget } : {}),
  };

  /**
   * One generate() or stream() call's options: the agent's, under the call's.
   * A call whose model's `provider:` prefix names another provider does not
   * inherit the agent's. The agent's key and base URL are for the provider
   * the agent names, so a call that names another provider takes only its
   * own, and that provider's from the environment otherwise.
   */
  const callOptions = (extra: Partial<GenerateTextOptions> | undefined): Partial<GenerateTextOptions> => {
    let merged = { ...baseOpts, ...extra };
    if (!extra || (extra.provider === undefined && extra.model === undefined)) return merged;
    if (
      extra.provider === undefined &&
      extra.model !== undefined &&
      baseOpts.provider !== undefined &&
      modelNamesAnotherProvider(baseOpts.provider, extra.model)
    ) {
      merged = { ...merged, provider: undefined };
    }
    if (baseOpts.apiKey === undefined && baseOpts.baseUrl === undefined) return merged;
    if (credentialsGoWith(baseOpts, merged)) return merged;
    return { ...merged, apiKey: extra.apiKey, baseUrl: extra.baseUrl };
  };

  const agentInstance: Agent = {
    async generate(
      prompt: MessageContent,
      extra?: Partial<GenerateTextOptions>
    ): Promise<GenerateTextResult> {
      try {
        const userText = typeof prompt === 'string' ? prompt : extractTextFromContent(prompt);
        const genOpts: Partial<GenerateTextOptions> = {
          ...callOptions(extra),
          // Settings become one budget here, so the call's validation retries are charged to the same one.
          ...(extra?.budget !== undefined ? { budget: asSpendBudget(extra.budget) } : {}),
          usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, extra?.usageLedger, {
            source: extra?.usageLedger?.source ?? 'agent.generate',
          }),
        };
        if (typeof prompt === 'string') {
          genOpts.prompt = prompt;
        } else {
          genOpts.messages = [...(genOpts.messages ?? []), { role: 'user', content: prompt }];
        }
        if (opts.responseSchema) {
          genOpts._schemaInstruction = buildSchemaInstructionText(lowerZodToJsonSchema(opts.responseSchema), 'response');
        }
        const { result, object } = await generateWithValidation(
          genOpts as GenerateTextOptions,
          opts.responseSchema,
          opts.controls?.maxValidationRetries ?? 1,
          true,
          (attempt) => accumulateUsage(agentUsageTally, attempt.usage),
          { provider: opts.memoryProvider, userText, options: opts.memoryProviderOptions },
        );
        if (opts.responseSchema) result.parsed = object;
        if (opts.verifyCitations) {
          result.grounding = await runCitationVerification(
            result.text,
            userText,
            opts.verifyCitations,
          );
        }
        // A seated config's answer leaves the seat masked, its text and tool
        // calls included: the next seat, a synthesizer, a manager and the
        // chair are sent only what came out of the mask.
        return isCallMask(maskError) ? maskError.strings(result) : result;
      } catch (error) {
        // A seated config's error leaves the seat masked.
        throw maskError ? maskError(error) : error;
      }
    },

    stream(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): StreamTextResult {
      const userText = typeof prompt === 'string' ? prompt : extractTextFromContent(prompt);
      const streamOpts: Partial<GenerateTextOptions> = applyMemoryProvider(
        {
          ...callOptions(extra),
          usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, extra?.usageLedger, {
            source: extra?.usageLedger?.source ?? 'agent.stream',
          }),
        },
        opts.memoryProvider,
        userText,
        opts.memoryProviderOptions,
      );
      if (typeof prompt === 'string') {
        streamOpts.prompt = prompt;
      } else {
        streamOpts.messages = [...(streamOpts.messages ?? []), { role: 'user', content: prompt }];
      }
      const result = streamText(streamOpts as GenerateTextOptions);
      void result.usage
        .then((usage) => accumulateUsage(agentUsageTally, usage))
        .catch(() => { /* stream errored; usage tally unchanged */ });
      // A seated config's errors leave the seat masked: error parts, a
      // throwing iterable and rejected result promises alike.
      return maskError ? maskStreamResult(result, maskError) : result;
    },

    session(id?: string): AgentSession {
      const sessionId = id ?? crypto.randomUUID();
      if (!sessionBuffers.has(sessionId)) {
        // History is independent of the memory subsystem (spec §1a): every
        // session keeps a lossless transcript unless the agent opts out via
        // `history: false`. Bounded by default — unbounded growth was the
        // latent failure mode for every long-lived consumer.
        const historyCfg =
          opts.history === false
            ? null
            : { ...SESSION_HISTORY_DEFAULTS, ...(opts.history ?? {}) };
        sessionBuffers.set(sessionId, historyCfg ? new SessionHistoryBuffer(historyCfg) : null);
      }
      if (!sessionUsageTallies.has(sessionId)) {
        sessionUsageTallies.set(sessionId, createEmptyUsageAggregate(sessionId));
      }
      const historyBuffer = sessionBuffers.get(sessionId)!;
      const sessionUsageTally = sessionUsageTallies.get(sessionId)!;

      const session = {
        id: sessionId,

        async send(
          input: MessageContent,
          sendOpts?: SessionSendOptions<ZodType>,
        ): Promise<GenerateTextResult | SessionSendStructuredResult<unknown>> {
          const textForMemory = typeof input === 'string' ? input : extractTextFromContent(input);
          const userMessage: Message = { role: 'user', content: input };
          // History epoch at entry: a reseed() during this send makes the
          // append below a stale no-op (the caller still gets its result).
          const epochAtStart = historyBuffer?.epoch();
          const priorHistory = historyBuffer
            ? (historyBuffer.messages() as unknown as Message[])
            : [];
          // String input rides `prompt` so generateText's transcript delta
          // captures the user turn positionally; parts input rides the tail
          // of `messages` with the internal trailing-caller marker.
          const inputIsString = typeof input === 'string';
          const requestMessages = inputIsString ? priorHistory : [...priorHistory, userMessage];

          // Schema-driven structured output: when responseSchema is set,
          // route through the provider's native enforcement API via the
          // same per-provider builder generateObject uses; generateText
          // passes the payload through to the provider via _responseFormat.
          let responseFormat: Record<string, unknown> | undefined;
          let responseFormatBuilder: GenerateTextOptions['_responseFormatBuilder'];
          // The schema in generateObject's words, for a call or fallback leg
          // whose payload carries none (generateText decides per leg).
          let schemaInstruction: string | undefined;
          if (sendOpts?.responseSchema) {
            // Resolve the primary the same way generateText will (explicit
            // provider/model fields, then env auto-detect) so the payload is
            // shaped for the provider that actually serves the call. The old
            // local resolver defaulted to 'openai', so a no-provider agent
            // whose env resolution picked e.g. Anthropic sent an OpenAI
            // json_schema payload the provider silently ignores — schema
            // unenforced, ObjectGenerationError on prose. Routing through
            // buildResponseFormatForProvider also applies the strict gates
            // (record schemas degrade to json_object; Fable degrades to the
            // prompt-only JSON path) exactly like generateObject's primary.
            const { providerId, modelId } = resolveModelOption(baseOpts, 'text');
            const schema = sendOpts.responseSchema;
            const schemaName = sendOpts.schemaName ?? 'response';
            const jsonSchema = lowerZodToJsonSchema(schema);
            schemaInstruction = buildSchemaInstructionText(jsonSchema, schemaName);
            responseFormat = buildResponseFormatForProvider({
              providerId,
              modelId,
              jsonSchema,
              effectiveSchema: schema,
              schemaName,
            });
            // Per-leg rebuild (same contract as generateObject): a fallback
            // hop onto a foreign provider gets a payload shaped for THAT
            // provider instead of this primary-shaped one, which the leg
            // provider's guard would silently drop — leaving the leg with
            // zero provider-side enforcement.
            responseFormatBuilder = (legProviderId, legModelId) =>
              buildResponseFormatForProvider({
                providerId: legProviderId,
                modelId: legModelId,
                jsonSchema,
                effectiveSchema: schema,
                schemaName,
              });
          }

          // Schema-aware calls disable tools. Mixing native structured
          // output with tool-calling requires a multi-turn schema+tool
          // protocol that this overload doesn't speak. Anthropic's
          // forced schema tool (a schema its JSON output format cannot
          // carry) reserves the tool slot, and OpenAI's json_schema mode
          // forbids tools alongside.
          // Strip caller-provided tools when responseSchema is set;
          // surface a console.warn so the caller can adjust if they
          // meant to pass both. (toolChoice is not part of
          // GenerateTextOptions; tools is the only public surface here.)
          const baseForRequest: Partial<GenerateTextOptions> = sendOpts?.responseSchema
            ? (() => {
                if (baseOpts.tools !== undefined) {
                  console.warn(
                    '[agentos] session.send: tools are ignored when responseSchema is set. Use generateObject for one-shot schema calls or call send() without a schema for tool-loop calls.',
                  );
                }
                const { tools: _tools, ...rest } = baseOpts;
                return rest;
              })()
            : baseOpts;

          let system = baseForRequest.system;
          const working = typeof opts.memory === 'object' ? opts.memory?.working : undefined;
          if (typeof working === 'function') {
            try {
              const block = await working();
              if (block) {
                system = Array.isArray(system)
                  ? [{ text: block }, ...system]
                  : [block, system].filter(Boolean).join('\n\n');
              }
            } catch {
              createLogger('api').warn('memory.working failed; continuing without the working-memory block.');
            }
          }

          const generationOptions: GenerateTextOptions = {
            ...baseForRequest,
            ...pickSendGenerationOverrides(sendOpts),
            system,
            messages: requestMessages,
            ...(inputIsString
              ? { prompt: input as string }
              : { _transcriptIncludeTrailingCallerMessages: 1 }),
            usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, {
              sessionId,
              source: 'agent.session.send',
            }),
            ...(responseFormat ? { _responseFormat: responseFormat } : {}),
            ...(responseFormatBuilder
              ? { _responseFormatBuilder: responseFormatBuilder }
              : {}),
            ...(schemaInstruction ? { _schemaInstruction: schemaInstruction } : {}),
          };

          const { result, object, retried } = await generateWithValidation(
            generationOptions,
            sendOpts?.responseSchema,
            sendOpts?.maxValidationRetries ?? 0,
            false,
            (attempt) => {
              accumulateUsage(sessionUsageTally, attempt.usage);
              accumulateUsage(agentUsageTally, attempt.usage);
            },
            { provider: opts.memoryProvider, userText: textForMemory, options: opts.memoryProviderOptions },
          );
          if (retried) {
            result.transcriptDelta = [
              userMessage as unknown as SessionTranscriptMessage,
              { role: 'assistant', content: result.text },
            ];
          }
          if (opts.verifyCitations) {
            result.grounding = await runCitationVerification(result.text, textForMemory, opts.verifyCitations);
          }

          if (historyBuffer) {
            // Lossless delta when the call carried one; minimal user/assistant
            // pair otherwise (legacy generateText wrappers and test doubles
            // predating transcriptDelta keep the pre-0.10 history shape).
            historyBuffer.appendSendDelta(
              result.transcriptDelta ?? [
                userMessage as unknown as SessionTranscriptMessage,
                { role: 'assistant', content: result.text },
              ],
              sendOpts?.blockLabel,
              epochAtStart,
            );
          }

          // Backwards-compat: when no schema, return plain GenerateTextResult.
          // When schema, attach typed object. The overload signature on
          // AgentSession.send narrows the return type for callers; runtime
          // payload is identical apart from the extra .object field.
          return object !== undefined
            ? ({ ...result, object } as SessionSendStructuredResult<unknown>)
            : result;
        },

        stream(input: MessageContent, streamOpts?: { abortSignal?: AbortSignal; budget?: SpendBudget | SpendBudgetOptions }): StreamTextResult {
          const textForMemory = typeof input === 'string' ? input : extractTextFromContent(input);
          const userMessage: Message = { role: 'user', content: input };

          const wrappedOpts = applyMemoryProvider(
            {
              ...baseOpts,
              messages: historyBuffer
                ? [...(historyBuffer.messages() as unknown as Message[]), userMessage]
                : [userMessage],
              usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, {
                sessionId,
                source: 'agent.session.stream',
              }),
              // The caller's signal ends the stream; a stream that ends in an
              // error is added to no history (below).
              ...(streamOpts?.abortSignal ? { abortSignal: streamOpts.abortSignal } : {}),
              // A stream's own budget takes the agent's place; without one the agent's applies.
              ...(streamOpts?.budget !== undefined ? { budget: streamOpts.budget } : {}),
            },
            opts.memoryProvider,
            textForMemory,
            opts.memoryProviderOptions,
          );

          const result = streamText(wrappedOpts as GenerateTextOptions);
          if (opts.verifyCitations) {
            const verification = opts.verifyCitations;
            result.grounding = result.text.then(
              (text) => runCitationVerification(text, textForMemory, verification),
              () => undefined,
            );
          }
          void result.usage
            .then((usage) => {
              accumulateUsage(sessionUsageTally, usage);
              accumulateUsage(agentUsageTally, usage);
            })
            .catch(() => { /* stream errored; usage tally unchanged */ });

          // Capture text for history when done. Memory observe runs inside
          // applyMemoryProvider's onAfterGeneration wrapper so it's not
          // re-fired here.
          if (historyBuffer) {
            // Streaming has no lossless delta yet (v1 limitation, documented):
            // append the minimal user/assistant text pair, epoch-guarded so a
            // reseed during the stream discards the stale append.
            const epochAtStreamStart = historyBuffer.epoch();
            const recorded = Promise.all([result.text, result.finishReason]).then(([replyText, finishReason]) => {
              // A stream that ended in an error (a refusal, a dropped
              // connection) is left out, as send() leaves out a call that
              // throws. An empty reply is not recorded as a turn: Anthropic
              // rejects a request whose history has an empty assistant
              // message.
              if (finishReason === 'error') return;
              historyBuffer.appendSendDelta(
                [
                  { role: 'user', content: input } as SessionTranscriptMessage,
                  ...(replyText
                    ? [{ role: 'assistant', content: replyText } as SessionTranscriptMessage]
                    : []),
                ],
                undefined,
                epochAtStreamStart,
              );
            });
            // The text settles once the turn is recorded, so a caller that
            // awaits it and sends again finds the turn in the history. A
            // failed history update is not the caller's error.
            const text = recorded.then(
              () => result.text,
              () => result.text,
            );
            void text.catch(() => undefined);
            return { ...result, text };
          }
          return result;
        },

        messages(): SessionTranscriptMessage[] {
          return historyBuffer ? historyBuffer.messages() : [];
        },

        reseed(snapshot: SessionTranscriptMessage[]): void {
          if (!historyBuffer) {
            throw new Error('reseed requires session history (history: false is set on this agent)');
          }
          historyBuffer.reseed(snapshot);
        },

        drainHistoryEvents(): HistoryEvent[] {
          return historyBuffer?.drainHistoryEvents() ?? [];
        },

        async usage(): Promise<AgentOSUsageAggregate> {
          const persisted = await loadRecordedAgentOSUsage({
            enabled: baseOpts.usageLedger?.enabled,
            path: baseOpts.usageLedger?.path,
            sessionId,
          });
          // When the persisted ledger is enabled it already records every
          // send, so it is authoritative; merging the in-memory tally would
          // double-count. The in-memory tally is only the fallback used when
          // the ledger is disabled.
          return baseOpts.usageLedger?.enabled
            ? persisted
            : mergeAggregates(sessionUsageTally, persisted);
        },

        recordExternalCost(costUSD: number, meta?: { kind?: string }): void {
          agentBudget?.recordExternal(costUSD, meta?.kind ?? 'external');
        },

        clear() {
          historyBuffer?.reseed([]);
        },

        async close(): Promise<void> {
          // The reseed bumps the epoch, so a send still in flight drops its
          // append; the next session(id) builds a new buffer. The usage tally
          // stays, as agent.close() keeps it, so agent.usage(id) still counts.
          historyBuffer?.reseed([]);
          if (sessionBuffers.get(sessionId) === historyBuffer) sessionBuffers.delete(sessionId);
        },
      };
      // The send() implementation returns a union (GenerateTextResult |
      // SessionSendStructuredResult<unknown>) to cover both interface
      // overloads. Cast through unknown so TypeScript accepts the
      // implementation as satisfying the overloaded interface.
      return session as unknown as AgentSession;
    },

    async usage(sessionId?: string): Promise<AgentOSUsageAggregate> {
      const persisted = await loadRecordedAgentOSUsage({
        enabled: baseOpts.usageLedger?.enabled,
        path: baseOpts.usageLedger?.path,
        sessionId,
      });
      // When a sessionId is requested, only that session's tally is in scope.
      // When none is requested, return the agent-wide tally.
      const inMemory = sessionId
        ? sessionUsageTallies.get(sessionId) ?? createEmptyUsageAggregate(sessionId)
        : agentUsageTally;
      // The enabled persisted ledger is authoritative; merging the in-memory
      // tally would double-count (the tally is only a disabled-ledger fallback).
      return baseOpts.usageLedger?.enabled
        ? persisted
        : mergeAggregates(inMemory, persisted);
    },

    async close() {
      sessionBuffers.clear();
    },

    /**
     * Exports this agent's configuration as a portable object.
     * @param metadata - Optional human-readable metadata to attach.
     * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
     * @returns A portable {@link AgentExportConfig} object.
     */
    export(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): AgentExportConfig {
      return exportAgentConfig(agentInstance, metadata, options);
    },

    /**
     * Exports this agent's configuration as a pretty-printed JSON string.
     * @param metadata - Optional human-readable metadata to attach.
     * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
     * @returns JSON string with 2-space indentation.
     */
    exportJSON(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): string {
      return exportAgentConfigJSON(agentInstance, metadata, options);
    },

    getAvatarBindings() {
      const cfg = opts.avatar;
      if (!cfg?.enabled) return {} as any;
      const base: Record<string, unknown> = {
        speaking: false,
        emotion: 'neutral',
        intensity: 0,
        stress: 0,
        anger: 0,
        affection: 0,
        trust: 0,
        relationshipWarmth: 0,
      };
      return { ...base, ...avatarBindingOverrides };
    },

    setAvatarBindingOverrides(overrides: Record<string, unknown>) {
      avatarBindingOverrides = { ...avatarBindingOverrides, ...overrides };
    },
  };

  if (opts.voice?.session) {
    const voice = opts.voice.session;
    const factory = voice.factory;
    const revision = structuredClone(voice.agent);
    agentInstance.voiceSession = (request) => factory.startSession({ ...request, agent: revision });
  }

  // Stash the original config as a non-enumerable property so that
  // exportAgentConfig() can retrieve it without polluting the public API.
  Object.defineProperty(agentInstance, '__config', {
    value: opts.voice?.session ? { ...opts, voice: { enabled: true } } : opts,
    enumerable: false,
    configurable: true,
  });

  return agentInstance;
}
