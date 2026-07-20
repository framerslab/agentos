/**
 * @file agent.ts
 * Lightweight stateful agent factory for the AgentOS high-level API.
 *
 * Wraps {@link generateText} and {@link streamText} with per-session conversation
 * history, optional HEXACO-inspired personality shaping, and a named-agent system
 * prompt builder.  Guardrail identifiers are accepted and stored in config but
 * are not actively enforced in this lightweight layer — use the full AgentOS
 * runtime (`AgentOSOrchestrator`) or `agency()` for guardrail enforcement.
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
import { resolveModelOption } from './model.js';
import { lowerZodToJsonSchema } from '../orchestration/compiler/SchemaLowering.js';
import { ObjectGenerationError } from './generateObject.js';
import { streamText, type StreamTextResult } from './streamText.js';
import type { HostLLMPolicy } from './runtime/hostPolicy.js';
import type { IModelRouter } from '../core/llm/routing/IModelRouter.js';
import type { SkillEntry } from '../cognition/skills/types.js';
import { loadSoulSync, parseSoul } from '../cognition/substrate/personas/SoulLoader.js';
import { CitationVerifier } from '../cognition/rag/citation/CitationVerifier.js';
import type { VerifyCitationsConfig } from './types.js';
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
import { exportAgentConfig, exportAgentConfigJSON, type AgentExportConfig } from './agentExportCore.js';
import { applyMemoryProvider } from './runtime/memoryProviderHooks.js';

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
 * All `BaseAgentConfig` fields (rag, discovery, permissions, emergent, voice,
 * etc.) are accepted and stored in config but are not actively wired in the
 * lightweight agent — they will be consumed by `agency()` and the full runtime.
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
   * happen automatically in the `onAfterGeneration` hook. On validation failure,
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
  /** Pre-generation hook, called before each LLM step. */
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
   * - `observe` runs after each LLM call as fire-and-forget.
   */
  memoryProvider?: AgentMemoryProvider;
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
   * @see {@link loadSoul} in `@framers/agentos/cognition/substrate/personas/SoulLoader`
   * for the loader implementation and full SOUL.md format spec.
   * @see https://github.com/aaronjmars/soul.md for the cross-framework convention.
   */
  soul?: string | { content: string } | { path: string };
}

/**
 * Options for a single {@link AgentSession.send} call.
 */
export interface SessionSendOptions<S extends ZodType | undefined = undefined> {
  /**
   * Zod schema describing the expected shape of the assistant reply. When
   * present, agentos converts the schema to JSON Schema, routes through
   * the provider's native structured-output API (OpenAI json_schema,
   * Anthropic forced tool-use, Gemini responseSchema), and returns a
   * Zod-validated typed object on `result.object` alongside the JSON
   * string in `result.text`.
   *
   * Tools (caller-provided in baseOpts.tools) are still passed through;
   * the structured-output mode adds its own forced tool on Anthropic
   * but the existing tool definitions remain in the payload.
   */
  responseSchema?: S;
  /**
   * Display name for the schema in provider payloads. Surfaces in OpenAI's
   * json_schema.name and Anthropic's tool name. Defaults to 'response'.
   * Sanitized to /[a-zA-Z0-9_]/ and truncated to 64 chars.
   */
  schemaName?: string;
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
   * Appends both turns to the session history when `memory` is enabled.
   * Accepts plain text or multimodal content (text + image parts).
   *
   * @param input - User message as text string or MessageContent array.
   * @returns The full generation result including text, usage, and tool calls.
   */
  send(input: MessageContent): Promise<GenerateTextResult>;
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
   *         (real provider bug; not retried).
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
   * @returns A {@link StreamTextResult} with async iterables and awaitable aggregates.
   */
  stream(input: MessageContent): StreamTextResult;
  /** Returns a snapshot of the current conversation history for this session. */
  messages(): Message[];
  /** Returns persisted usage totals for this session when the usage ledger is enabled. */
  usage(): Promise<AgentOSUsageAggregate>;
  /** Clears all messages from this session's history. */
  clear(): void;
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
   * @returns The session object for this ID.
   */
  session(id?: string): AgentSession;
  /** Returns persisted usage totals for the whole agent or a single session. */
  usage(sessionId?: string): Promise<AgentOSUsageAggregate>;
  /** Releases all in-memory session state held by this agent. */
  close(): Promise<void>;
  /**
   * Exports the agent's configuration as a portable object.
   * @param metadata - Optional human-readable metadata to attach.
   * @returns A portable {@link AgentExportConfig} object.
   */
  export(metadata?: AgentExportConfig['metadata']): AgentExportConfig;
  /**
   * Exports the agent's configuration as a pretty-printed JSON string.
   * @param metadata - Optional human-readable metadata to attach.
   * @returns JSON string.
   */
  exportJSON(metadata?: AgentExportConfig['metadata']): string;
  /** Read current avatar binding state (auto-populated from mood/voice/relationship). */
  getAvatarBindings(): import('./types').AvatarBindingInputs & Record<string, unknown>;
  /** Inject game-specific binding overrides (healthBand, combatMode, etc.). */
  setAvatarBindingOverrides(overrides: Record<string, unknown>): void;
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


/**
 * Convert HEXACO trait values (0-1) into behavioral descriptions the LLM can act on.
 *
 * Each trait produces a directive when it deviates from the neutral midpoint (0.5).
 * High values (>0.65) and low values (<0.35) produce distinct behavioral instructions.
 * Moderate values (0.35-0.65) are omitted to avoid over-constraining the model.
 */
function buildPersonalityDescription(
  traits: Partial<Record<string, number>>
): string | null {
  const lines: string[] = [];
  const v = (key: string) => typeof traits[key] === 'number' ? traits[key]! : 0.5;

  const h = v('honesty');
  const e = v('emotionality');
  const x = v('extraversion');
  const a = v('agreeableness');
  const c = v('conscientiousness');
  const o = v('openness');

  // Honesty-Humility
  if (h > 0.65) lines.push('Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.');
  else if (h < 0.35) lines.push('Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages.');

  // Emotionality
  if (e > 0.65) lines.push('Respond with emotional awareness and empathy. Acknowledge feelings in the conversation. Express concern when appropriate.');
  else if (e < 0.35) lines.push('Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic.');

  // Extraversion
  if (x > 0.65) lines.push('Be energetic and engaging. Use vivid language. Take initiative in the conversation. Offer suggestions proactively.');
  else if (x < 0.35) lines.push('Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth.');

  // Agreeableness
  if (a > 0.65) lines.push('Prioritize harmony and cooperation. Validate the other perspective before offering alternatives. Be supportive and encouraging.');
  else if (a < 0.35) lines.push('Be direct and challenge-oriented. Question assumptions. Prioritize accuracy over comfort. Push back when something seems wrong.');

  // Conscientiousness
  if (c > 0.65) lines.push('Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed.');
  else if (c < 0.35) lines.push('Be flexible and adaptive. Prioritize the big picture over details. Respond quickly. Tolerate ambiguity and improvise.');

  // Openness
  if (o > 0.65) lines.push('Explore creative angles and unconventional ideas. Draw unexpected connections. Question established approaches.');
  else if (o < 0.35) lines.push('Stick to proven approaches and established knowledge. Be practical and concrete. Favor reliability over novelty.');

  if (lines.length === 0) return null;

  return `## Personality & Communication Style\n\n${lines.join('\n')}`;
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
    const desc = buildPersonalityDescription(opts.personality);
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
 * Resolve an `AgentOptions.soul` value (string path | { content } | { path })
 * into a `LoadedSoul`. Returns null on failure so the agent can still boot
 * (the soul is additive, not load-blocking).
 */
/**
 * Run citation verification on a freshly-generated response. Retrieves
 * sources via the configured `retrieve` hook, then scores each atomic claim
 * in the response against those sources with {@link CitationVerifier}.
 *
 * Errors are non-fatal: a failed retrieval or verifier crash returns
 * `undefined` so the agent's response is still delivered to the caller
 * unchanged. Verification is a *check*, not a gate.
 *
 * @param text     - The generated response text to verify.
 * @param userText - The user's input — passed to the retriever as a query.
 * @param config   - Verifier wiring (embedder, retriever, thresholds).
 */
async function runCitationVerification(
  text: string,
  userText: string,
  config: VerifyCitationsConfig,
): Promise<import('../cognition/rag/citation/types.js').VerifiedResponse | undefined> {
  try {
    // Resolve wiring: `retrievalAugmentor` shortcut takes precedence and
    // auto-derives both retrieve + embedFn. Otherwise fall back to the
    // explicit hooks. We require at least one valid combination; if neither
    // is provided we no-op (verification is a check, not a gate, so a
    // missing config should not fail the response).
    const augmentor = config.retrievalAugmentor;

    const retrieve = augmentor
      ? async (query: string) => {
          const result = await augmentor.retrieveContext(query, config.retrievalOptions);
          // Convert RagRetrievedChunk -> VerificationSource. The verifier only
          // looks at content/title/url; metadata + score are dropped (they
          // do not feed cosine similarity).
          return (result.retrievedChunks ?? []).map((chunk) => ({
            content: chunk.content,
            title:
              typeof chunk.metadata?.title === 'string'
                ? (chunk.metadata.title as string)
                : undefined,
            url:
              chunk.source ??
              (typeof chunk.metadata?.url === 'string'
                ? (chunk.metadata.url as string)
                : undefined),
          }));
        }
      : config.retrieve;

    const embedFn = augmentor
      ? (texts: string[]) => augmentor.embedTexts(texts)
      : config.embedFn;

    if (!retrieve || !embedFn) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          '[@framers/agentos] verifyCitations missing both retrievalAugmentor and explicit retrieve/embedFn. Skipping verification.',
        );
      }
      return undefined;
    }

    const sources = await retrieve(userText);
    if (!sources || sources.length === 0) return undefined;
    const verifier = new CitationVerifier({
      embedFn,
      supportThreshold: config.supportThreshold,
      unverifiableThreshold: config.unverifiableThreshold,
      nliFn: config.nliFn,
      extractClaims: config.extractClaims,
    });
    return await verifier.verify(text, sources);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[@framers/agentos] verifyCitations failed: ${(err as Error).message}. Returning response without grounding.`,
      );
    }
    return undefined;
  }
}

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
 * Creates a lightweight stateful agent backed by in-memory session storage.
 *
 * The agent wraps {@link generateText} and {@link streamText} with a persistent
 * system prompt built from `instructions`, `name`, and `personality` fields.
 * Multiple independent sessions can be opened via `Agent.session()`.
 *
 * @param opts - Agent configuration including model, instructions, and optional tools.
 *   All `BaseAgentConfig` fields are accepted; advanced fields (rag, discovery,
 *   permissions, emergent, voice, guardrails, etc.) are stored but not actively
 *   wired in the lightweight layer — they are consumed by `agency()` and the full runtime.
 * @returns An {@link Agent} instance with `generate`, `stream`, `session`, and `close` methods.
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
  const sessions = new Map<string, Message[]>();
  // In-memory usage tally per session and per agent. Populated synchronously
  // after every generate/send/stream call so `agent.usage()` and
  // `session.usage()` work even when the persisted ledger is disabled (the
  // common case). The persisted ledger is still merged in at read time so
  // cross-process / historical totals continue to roll up correctly.
  const sessionUsageTallies = new Map<string, AgentOSUsageAggregate>();
  const agentUsageTally: AgentOSUsageAggregate = createEmptyUsageAggregate();
  let avatarBindingOverrides: Record<string, unknown> = {};
  const useMemory = opts.memory !== false;

  warnOnDeferredLightweightAgentCapabilities(opts);

  /*
   * Cognitive mechanisms validation.  When the caller provides a
   * `cognitiveMechanisms` config but has memory disabled, the mechanisms
   * cannot be wired (they depend on CognitiveMemoryManager which needs an
   * active memory subsystem).  Log a warning and drop the config.
   */
  if (opts.cognitiveMechanisms && !useMemory) {
    console.warn(
      '[AgentOS] cognitiveMechanisms config was provided but memory is disabled. ' +
      'Mechanisms require memory to be enabled (set `memory: true` or pass a MemoryConfig). ' +
      'The cognitiveMechanisms config will be ignored.',
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

  const baseOpts: Partial<GenerateTextOptions> = {
    provider: opts.provider,
    model: opts.model,
    system: opts.systemBlocks ?? buildSystemPrompt(opts),
    tools: opts.tools,
    maxSteps: opts.maxSteps ?? 5,
    // Per-call completion-token cap applied to every generate /
    // session.send / stream invocation this agent makes. Unset means
    // the underlying generateText falls back to the provider default.
    maxTokens: opts.maxTokens,
    // Extended-thinking budget forwarded to thinking-capable models on every
    // generate / stream / session call (both spread baseOpts). Unset means
    // thinking stays off; the provider ignores it on unsupported models.
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
    onBeforeGeneration: opts.onBeforeGeneration,
    onAfterGeneration: opts.onAfterGeneration,
    onBeforeToolExecution: opts.onBeforeToolExecution,
  };

  const agentInstance: Agent = {
    async generate(
      prompt: MessageContent,
      extra?: Partial<GenerateTextOptions>
    ): Promise<GenerateTextResult> {
      const userText = typeof prompt === 'string' ? prompt : extractTextFromContent(prompt);
      const genOpts: Partial<GenerateTextOptions> = applyMemoryProvider(
        {
          ...baseOpts,
          ...extra,
          usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, extra?.usageLedger, {
            source: extra?.usageLedger?.source ?? 'agent.generate',
          }),
        },
        opts.memoryProvider,
        userText,
      );
      if (typeof prompt === 'string') {
        genOpts.prompt = prompt;
      } else {
        genOpts.messages = [...(genOpts.messages ?? []), { role: 'user', content: prompt }];
      }
      const result = await generateText(genOpts as GenerateTextOptions);
      accumulateUsage(agentUsageTally, result.usage);
      if (opts.verifyCitations) {
        result.grounding = await runCitationVerification(
          result.text,
          userText,
          opts.verifyCitations,
        );
      }
      return result;
    },

    stream(prompt: MessageContent, extra?: Partial<GenerateTextOptions>): StreamTextResult {
      const userText = typeof prompt === 'string' ? prompt : extractTextFromContent(prompt);
      const streamOpts: Partial<GenerateTextOptions> = applyMemoryProvider(
        {
          ...baseOpts,
          ...extra,
          usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, extra?.usageLedger, {
            source: extra?.usageLedger?.source ?? 'agent.stream',
          }),
        },
        opts.memoryProvider,
        userText,
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
      return result;
    },

    session(id?: string): AgentSession {
      const sessionId = id ?? crypto.randomUUID();
      if (!sessions.has(sessionId)) sessions.set(sessionId, []);
      if (!sessionUsageTallies.has(sessionId)) {
        sessionUsageTallies.set(sessionId, createEmptyUsageAggregate(sessionId));
      }
      const history = sessions.get(sessionId)!;
      const sessionUsageTally = sessionUsageTallies.get(sessionId)!;

      const session = {
        id: sessionId,

        async send(
          input: MessageContent,
          sendOpts?: SessionSendOptions<ZodType>,
        ): Promise<GenerateTextResult | SessionSendStructuredResult<unknown>> {
          const textForMemory = typeof input === 'string' ? input : extractTextFromContent(input);
          const userMessage: Message = { role: 'user', content: input };
          const requestMessages = useMemory
            ? [...history, userMessage]
            : [userMessage];

          // Schema-driven structured output: when responseSchema is set,
          // route through the provider's native enforcement API via the
          // same per-provider builder generateObject uses; generateText
          // passes the payload through to the provider via _responseFormat.
          let responseFormat: Record<string, unknown> | undefined;
          let responseFormatBuilder: GenerateTextOptions['_responseFormatBuilder'];
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
          // forced tool-use mode reserves the tool slot for the schema
          // tool, and OpenAI's json_schema mode forbids tools alongside.
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

          const wrappedOpts = applyMemoryProvider(
            {
              ...baseForRequest,
              messages: requestMessages,
              usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, {
                sessionId,
                source: 'agent.session.send',
              }),
              ...(responseFormat ? { _responseFormat: responseFormat } : {}),
              ...(responseFormatBuilder
                ? { _responseFormatBuilder: responseFormatBuilder }
                : {}),
            },
            opts.memoryProvider,
            textForMemory,
          );

          const result = await generateText(wrappedOpts as GenerateTextOptions);
          accumulateUsage(sessionUsageTally, result.usage);
          accumulateUsage(agentUsageTally, result.usage);

          // Validate + parse when a schema was supplied. Native enforcement
          // guarantees a valid shape on every successful response, so a
          // parse/validation failure here is a real provider bug rather
          // than retry-worthy. Throw with the rawText + Zod error attached.
          let object: unknown;
          if (sendOpts?.responseSchema) {
            try {
              const parsed = JSON.parse(result.text);
              const safe = sendOpts.responseSchema.safeParse(parsed);
              if (!safe.success) {
                throw new ObjectGenerationError(
                  'session.send: provider-enforced JSON failed Zod validation',
                  result.text,
                  safe.error,
                );
              }
              object = safe.data;
            } catch (err) {
              if (err instanceof ObjectGenerationError) throw err;
              throw new ObjectGenerationError(
                `session.send: provider response is not valid JSON despite enforcement (${err instanceof Error ? err.message : String(err)})`,
                result.text,
              );
            }
          }

          if (useMemory) {
            history.push(userMessage);
            history.push({ role: 'assistant', content: result.text });
          }

          // Backwards-compat: when no schema, return plain GenerateTextResult.
          // When schema, attach typed object. The overload signature on
          // AgentSession.send narrows the return type for callers; runtime
          // payload is identical apart from the extra .object field.
          return object !== undefined
            ? ({ ...result, object } as SessionSendStructuredResult<unknown>)
            : result;
        },

        stream(input: MessageContent): StreamTextResult {
          const textForMemory = typeof input === 'string' ? input : extractTextFromContent(input);
          const userMessage: Message = { role: 'user', content: input };

          const wrappedOpts = applyMemoryProvider(
            {
              ...baseOpts,
              messages: useMemory
                ? [...history, userMessage]
                : [userMessage],
              usageLedger: mergeUsageLedgerOptions(baseOpts.usageLedger, {
                sessionId,
                source: 'agent.session.stream',
              }),
            },
            opts.memoryProvider,
            textForMemory,
          );

          const result = streamText(wrappedOpts as GenerateTextOptions);
          void result.usage
            .then((usage) => {
              accumulateUsage(sessionUsageTally, usage);
              accumulateUsage(agentUsageTally, usage);
            })
            .catch(() => { /* stream errored; usage tally unchanged */ });

          // Capture text for history when done. Memory observe runs inside
          // applyMemoryProvider's onAfterGeneration wrapper so it's not
          // re-fired here.
          if (useMemory) {
            history.push(userMessage);
            void result.text
              .then((replyText) => {
                history.push({ role: 'assistant', content: replyText });
              })
              .catch(() => {
                /* history update failed, non-critical */
              });
          }
          return result;
        },

        messages(): Message[] {
          return [...history];
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

        clear() {
          history.length = 0;
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
      sessions.clear();
    },

    /**
     * Exports this agent's configuration as a portable object.
     * @param metadata - Optional human-readable metadata to attach.
     * @returns A portable {@link AgentExportConfig} object.
     */
    export(metadata?: AgentExportConfig['metadata']): AgentExportConfig {
      return exportAgentConfig(agentInstance, metadata);
    },

    /**
     * Exports this agent's configuration as a pretty-printed JSON string.
     * @param metadata - Optional human-readable metadata to attach.
     * @returns JSON string with 2-space indentation.
     */
    exportJSON(metadata?: AgentExportConfig['metadata']): string {
      return exportAgentConfigJSON(agentInstance, metadata);
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

  // Stash the original config as a non-enumerable property so that
  // exportAgentConfig() can retrieve it without polluting the public API.
  Object.defineProperty(agentInstance, '__config', {
    value: opts,
    enumerable: false,
    configurable: true,
  });

  return agentInstance;
}
