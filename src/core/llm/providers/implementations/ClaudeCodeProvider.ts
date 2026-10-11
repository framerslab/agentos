/**
 * @fileoverview IProvider implementation that invokes the Claude Code CLI
 * as a subprocess, allowing users to leverage their personal Max subscription
 * without an API key. Completely separate from the `anthropic` provider
 * (which uses ANTHROPIC_API_KEY for pay-per-token access).
 *
 * Two-class architecture:
 * - **ClaudeCodeProvider** (this file) — IProvider contract, message formatting,
 *   tool schema injection, response mapping. Knows nothing about subprocesses.
 * - **ClaudeCodeCLIBridge** — subprocess lifecycle via execa. Knows nothing
 *   about LLM semantics.
 *
 * @module agentos/core/llm/providers/implementations/ClaudeCodeProvider
 * @see ClaudeCodeCLIBridge
 */

import {
  type IProvider,
  type ChatMessage,
  type ModelCompletionOptions,
  type ModelCompletionResponse,
  type ModelInfo,
  type ModelUsage,
  type ProviderEmbeddingOptions,
  type ProviderEmbeddingResponse,
} from '../IProvider';
import { ClaudeCodeCLIBridge, type CLIBridgeOptions, type StreamEvent } from './ClaudeCodeCLIBridge';
import { ClaudeCodeProviderError } from '../errors/ClaudeCodeProviderError';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Configuration for the Claude Code CLI provider. */
export interface ClaudeCodeProviderConfig {
  /** Override the default model. Defaults to `claude-sonnet-4-6`. */
  defaultModelId?: string;
  /** Subprocess timeout in ms (default 120 000). */
  requestTimeout?: number;
}

/* ------------------------------------------------------------------ */
/*  Static model catalog                                               */
/* ------------------------------------------------------------------ */

/**
 * Static catalog of Claude models available through Claude Code CLI.
 * All prices are $0 because the user is on a subscription.
 */
const CLAUDE_CODE_MODELS: ModelInfo[] = [
  {
    modelId: 'claude-fable-5-1',
    providerId: 'claude-code-cli',
    displayName: 'Claude Fable 5.1',
    description: 'Most capable Claude model, for demanding reasoning and long-horizon agentic work',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'claude-fable-5',
    providerId: 'claude-code-cli',
    displayName: 'Claude Fable 5',
    description: 'Previous Fable generation, superseded by Claude Fable 5.1',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'claude-opus-5-5',
    providerId: 'claude-code-cli',
    displayName: 'Claude Opus 5.5',
    description: "Anthropic's recommended starting model, frontier Opus for agents and coding",
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'claude-sonnet-5-5',
    providerId: 'claude-code-cli',
    displayName: 'Claude Sonnet 5.5',
    description: 'Current Sonnet for coding and agentic work',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'claude-sonnet-5',
    providerId: 'claude-code-cli',
    displayName: 'Claude Sonnet 5',
    description: 'Near-Opus Sonnet for coding and agentic work',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'claude-sonnet-4-6',
    providerId: 'claude-code-cli',
    displayName: 'Claude Sonnet 4.6',
    description: 'Balanced intelligence, cost and speed, and the default for this provider',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 128_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: true,
  },
  // The 2025-05-14 Claude Opus 4 and Sonnet 4 snapshots were retired by
  // Anthropic on 2026-06-15 and return HTTP 404 on the Messages API (probed
  // 2026-09-29). ClaudeCodeCLIBridge passes the model id to the CLI as given.
  // Kept as `deprecated` so a caller holding either id still sees a catalog
  // row.
  {
    modelId: 'claude-opus-4-20250514',
    providerId: 'claude-code-cli',
    displayName: 'Claude Opus 4',
    description: 'Retired 2026-06-15 and no longer served. Use claude-opus-5-5',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 200_000,
    inputTokenLimit: 200_000,
    outputTokenLimit: 32_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
  {
    modelId: 'claude-sonnet-4-20250514',
    providerId: 'claude-code-cli',
    displayName: 'Claude Sonnet 4',
    description: 'Retired 2026-06-15 and no longer served. Use claude-sonnet-4-6',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 200_000,
    inputTokenLimit: 200_000,
    outputTokenLimit: 16_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    providerId: 'claude-code-cli',
    displayName: 'Claude Haiku 4.5',
    description: 'Fastest Claude model — great for lightweight tasks and high throughput',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 200_000,
    inputTokenLimit: 200_000,
    outputTokenLimit: 64_000,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
];

/* ------------------------------------------------------------------ */
/*  JSON schema for structured tool-calling responses                  */
/* ------------------------------------------------------------------ */

/**
 * JSON schema passed to `--json-schema` when tools are present.
 * Forces the model to respond with either `{ response_type: "text" }`
 * or `{ response_type: "tool_calls", tool_calls: [...] }`.
 */
const TOOL_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['response_type'],
  properties: {
    response_type: { enum: ['text', 'tool_calls'] },
    text: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'arguments'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'object' },
        },
      },
    },
  },
} as const;

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

/**
 * LLM provider that wraps the locally-installed Claude Code CLI.
 * Users authenticate Claude Code separately (via `claude` in terminal);
 * this provider detects that installation and uses it for completions.
 *
 * No API key required — the user's Max subscription handles billing.
 * `costUSD` is always 0 since there is no per-token charge.
 */
export class ClaudeCodeProvider implements IProvider {
  public readonly providerId: string = 'claude-code-cli';
  public isInitialized: boolean = false;
  public defaultModelId?: string;

  private config!: ClaudeCodeProviderConfig;
  private bridge: ClaudeCodeCLIBridge;

  constructor() {
    this.bridge = new ClaudeCodeCLIBridge();
  }

  /* ---- Lifecycle ------------------------------------------------- */

  /**
   * Initialize the provider by verifying that Claude Code CLI is
   * installed and authenticated. Fails fast with actionable guidance
   * if either check fails.
   */
  async initialize(config: ClaudeCodeProviderConfig): Promise<void> {
    this.config = {
      defaultModelId: 'claude-sonnet-4-6',
      requestTimeout: 120_000,
      ...config,
    };
    this.defaultModelId = this.config.defaultModelId;

    /* 1. Check CLI is installed */
    const installCheck = await this.bridge.checkBinaryInstalled();
    if (!installCheck.installed) {
      throw new ClaudeCodeProviderError(
        'Claude Code CLI is not installed.',
        'BINARY_NOT_FOUND',
        'Install Claude Code: npm install -g @anthropic-ai/claude-code — or download from https://claude.ai/download\n\nThen log in by running "claude" in your terminal.\n\nAlternatively, switch to a different provider:\n  wunderland login',
        false,
      );
    }

    /* 2. Check authentication */
    const isAuth = await this.bridge.checkAuthenticated();
    if (!isAuth) {
      throw new ClaudeCodeProviderError(
        'Claude Code is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Open your terminal and run:\n  claude\n\nComplete the login flow with your Anthropic account, then restart your agent.',
        false,
      );
    }

    this.isInitialized = true;
  }

  /** Clean shutdown — marks provider as uninitialized. */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }

  /* ---- Completions ---------------------------------------------- */

  /**
   * Generate a single completion by spawning `claude --bare -p`.
   *
   * When `options.tools` is provided, tool schemas are injected into the
   * system prompt and `--json-schema` enforces structured output for
   * reliable tool call parsing. Falls back to text on parse failure.
   */
  async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();

    const hasTools = options.tools && options.tools.length > 0 && options.toolChoice !== 'none';
    const { systemPrompt, conversationPrompt } = this.formatMessages(messages);
    const fullSystemPrompt = hasTools
      ? this.injectToolSchemas(systemPrompt, options.tools!, options.toolChoice)
      : systemPrompt;

    const bridgeOpts: CLIBridgeOptions = {
      prompt: conversationPrompt,
      systemPrompt: fullSystemPrompt || undefined,
      model: modelId,
      jsonSchema: hasTools ? TOOL_RESPONSE_SCHEMA : undefined,
      timeout: this.config.requestTimeout,
      abortSignal: options.abortSignal,
    };

    const result = await this.bridge.execute(bridgeOpts);

    if (result.isError) {
      /* The bridge carries the failure's message in `error`. */
      throw this.errorResultError(result.error ?? result.result);
    }

    /* Parse tool call response if tools were requested. With --json-schema,
     * Claude Code returns the reply that matches it in structured_output,
     * which the bridge passes on as structuredOutput; the result text is
     * parsed when there is none. */
    if (hasTools) {
      try {
        const parsed = result.structuredOutput ?? JSON.parse(result.result);
        if (parsed.response_type === 'tool_calls' && Array.isArray(parsed.tool_calls)) {
          return this.buildToolCallResponse(parsed.tool_calls, result, undefined, undefined, modelId);
        }
        /* Model chose text response */
        return this.buildTextResponse(parsed.text ?? result.result, result, undefined, undefined, modelId);
      } catch {
        /* SCHEMA_PARSE_FAILED — retry without schema */
        const retryOpts = { ...bridgeOpts, jsonSchema: undefined };
        const retryResult = await this.bridge.execute(retryOpts);
        return this.buildTextResponse(retryResult.result, retryResult, undefined, undefined, modelId);
      }
    }

    return this.buildTextResponse(result.result, result, undefined, undefined, modelId);
  }

  /**
   * Stream a completion by spawning `claude --bare -p --output-format stream-json`.
   *
   * Text-only turns get full token-by-token streaming. Tool-calling turns
   * stream progress events for UX feedback, then yield a single final
   * response with parsed tool calls.
   *
   * The final chunk is yielded once the bridge's stream has ended, which is
   * after the CLI has exited: a non-zero exit after the result line ends the
   * stream with the bridge's classified error, and a result flagged
   * `is_error` ends it with an error chunk.
   *
   * A text reply in the result's structured output that the text deltas do
   * not already hold (none came, or only text the model wrote before the
   * reply, such as whitespace) is yielded as one text delta just before the
   * final chunk built from it, so a consumer that builds the reply from the
   * deltas (streamText(), the StreamingReconstructor, the GMI) reads it once.
   * The delta goes out only once the run has ended with that reply, so a run
   * that fails after its result line still ends with its error chunk alone.
   * A caller who aborts while the consumer holds the delta gets the abort
   * chunk in place of the reply's final chunk.
   */
  async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();

    const hasTools = options.tools && options.tools.length > 0 && options.toolChoice !== 'none';
    const { systemPrompt, conversationPrompt } = this.formatMessages(messages);
    const fullSystemPrompt = hasTools
      ? this.injectToolSchemas(systemPrompt, options.tools!, options.toolChoice)
      : systemPrompt;

    const bridgeOpts: CLIBridgeOptions = {
      prompt: conversationPrompt,
      systemPrompt: fullSystemPrompt || undefined,
      model: modelId,
      jsonSchema: hasTools ? TOOL_RESPONSE_SCHEMA : undefined,
      timeout: this.config.requestTimeout,
      abortSignal: options.abortSignal,
    };

    let accumulatedText = '';
    const responseId = `cc-${Date.now()}`;
    let finalUsage: ModelUsage | undefined;
    /* The chunk that ends the stream. It is held while the bridge's stream is
     * read to its end, where the bridge awaits the CLI's exit, so a failed
     * exit after the result line still reaches the catch below. */
    let finalChunk: ModelCompletionResponse | undefined;
    /* Set when the CLI reports a failure in its own output (an error event or
     * an is_error result), which says more than the exit code that follows. */
    let cliReportedError = false;
    /* A text reply in the result's structured output that the text deltas
     * did not carry, and the final chunk built from it: it goes out as a
     * delta of its own after the loop, if that chunk still ends the stream. */
    let structuredText: { text: string; finalChunk: ModelCompletionResponse } | undefined;

    try {
      for await (const event of this.bridge.stream(bridgeOpts)) {
        /* Once the ending is known the rest of the stream is only drained. */
        if (finalChunk) continue;
        switch (event.type) {
          case 'text_delta':
            accumulatedText += event.text;
            yield this.buildTextDeltaChunk(event.text, accumulatedText, modelId, responseId);
            break;

          case 'result': {
            const usage = event.usage;
            finalUsage = usage
              ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens, costUSD: 0 }
              : { totalTokens: 0, costUSD: 0 };

            /* A failed turn: the error generateCompletion() throws for it */
            if (event.isError) {
              /* The bridge carries the failure's message in `error`. */
              const error = this.errorResultError(event.error ?? event.result);
              cliReportedError = true;
              finalChunk = this.buildStreamErrorResponse(error.message, modelId, responseId, finalUsage, error.code, error);
              break;
            }

            const finalText = event.result || accumulatedText;

            /* Try parsing as tool call response. With --json-schema, Claude
             * Code returns the reply that matches it in structured_output,
             * which the bridge passes on as structuredOutput; the final text
             * is parsed when there is none. */
            if (hasTools) {
              try {
                const parsed = event.structuredOutput ?? JSON.parse(finalText);
                if (parsed.response_type === 'tool_calls' && Array.isArray(parsed.tool_calls)) {
                  finalChunk = this.buildToolCallResponse(
                    parsed.tool_calls,
                    { sessionId: event.sessionId, usage: event.usage },
                    responseId,
                    finalUsage,
                    modelId,
                  );
                  break;
                }
                /* A text reply in structured output is its `text`: the turn
                 * that returns it ends with no assistant message of its own. */
                if (event.structuredOutput != null && typeof parsed.text === 'string') {
                  finalChunk = this.buildTextResponse(
                    parsed.text,
                    { sessionId: event.sessionId, usage: event.usage },
                    responseId,
                    finalUsage,
                    modelId,
                  );
                  /* Text deltas that hold the reply already carried it, and
                   * it gets no second copy. Any others came before it (text
                   * the model wrote ahead of the reply, or whitespace), and
                   * the reply follows them. Any text holds an empty reply. */
                  if (!accumulatedText.includes(parsed.text)) {
                    structuredText = { text: parsed.text, finalChunk };
                  }
                  break;
                }
              } catch { /* fall through to text */ }
            }

            finalChunk = this.buildTextResponse(
              finalText,
              { sessionId: event.sessionId, usage: event.usage },
              responseId,
              finalUsage,
              modelId,
            );
            break;
          }

          case 'error':
            cliReportedError = true;
            finalChunk = this.buildStreamErrorResponse(
              `Claude Code stream error: ${event.error}`,
              modelId,
              responseId,
              finalUsage,
            );
            break;
        }
      }
    } catch (error: any) {
      /* A failed run (a non-zero exit, a timeout, an abort) ends the stream
       * with the bridge's classified error, unless the CLI already reported
       * the failure itself. */
      if (!cliReportedError) {
        finalChunk = this.buildStreamErrorResponse(
          error?.message ?? 'Claude Code stream failed.',
          modelId,
          responseId,
          finalUsage,
          error?.code,
          error,
          /* The caller's abort ends the stream with type 'abort', as the
           * abortSignal contract in IProvider asks of a streaming provider. */
          error?.code === 'REQUEST_ABORTED' ? 'abort' : undefined,
        );
      }
    }

    /* streamText() and the StreamingReconstructor build a reply's text from
     * the deltas alone. The delta goes out once the run is known to have
     * ended with this reply: a run that failed or was aborted after its
     * result line ends with its error chunk alone, as a stream with no reply
     * text does. */
    if (structuredText && finalChunk === structuredText.finalChunk) {
      yield this.buildTextDeltaChunk(structuredText.text, accumulatedText + structuredText.text, modelId, responseId);
      /* The bridge's stream has ended, so it no longer sees the caller's
       * signal. An abort while the consumer held the delta still comes before
       * the final chunk, and ends the stream as the bridge ends a run the
       * caller aborted before the stream's end. */
      if (options.abortSignal?.aborted) {
        const error = ClaudeCodeProviderError.requestAborted();
        finalChunk = this.buildStreamErrorResponse(
          error.message,
          modelId,
          responseId,
          finalUsage,
          error.code,
          error,
          'abort',
        );
      }
    }

    yield finalChunk ?? this.buildTextResponse(accumulatedText, {}, responseId, finalUsage, modelId);
  }

  /* ---- Embeddings (not supported) -------------------------------- */

  /** Claude Code CLI does not support embeddings — throws immediately. */
  async generateEmbeddings(
    _modelId: string,
    _texts: string[],
    _options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    throw new ClaudeCodeProviderError(
      'Claude Code CLI does not support embeddings. Use a different provider (OpenAI, Ollama, etc.) for embedding operations.',
      'EMBEDDINGS_NOT_SUPPORTED',
      'Configure an additional provider with embedding support: wunderland login',
      false,
    );
  }

  /* ---- Model catalog -------------------------------------------- */

  /** Returns the static Claude model catalog (Opus, Sonnet, Haiku). */
  async listAvailableModels(): Promise<ModelInfo[]> {
    return [...CLAUDE_CODE_MODELS];
  }

  /** Look up a specific model by ID from the static catalog. */
  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return CLAUDE_CODE_MODELS.find(m => m.modelId === modelId);
  }

  /* ---- Health check --------------------------------------------- */

  /**
   * Structured health check for `wunderland doctor`.
   * Returns installation status, version, path, and auth state.
   */
  async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    const installCheck = await this.bridge.checkBinaryInstalled();
    if (!installCheck.installed) {
      return {
        isHealthy: false,
        details: {
          cliInstalled: false,
          error: 'BINARY_NOT_FOUND',
          guidance: 'Install Claude Code: npm install -g @anthropic-ai/claude-code — or download from https://claude.ai/download',
        },
      };
    }

    const isAuth = await this.bridge.checkAuthenticated();
    return {
      isHealthy: isAuth,
      details: {
        cliInstalled: true,
        cliVersion: installCheck.version,
        cliPath: installCheck.binaryPath,
        authenticated: isAuth,
        ...(isAuth ? {} : {
          error: 'NOT_AUTHENTICATED',
          guidance: 'Run "claude" in your terminal to log in.',
        }),
      },
    };
  }

  /* ---- Private: message formatting ------------------------------ */

  /**
   * Split ChatMessage[] into a system prompt string and a conversation
   * prompt serialized as XML.
   */
  private formatMessages(messages: ChatMessage[]): { systemPrompt: string; conversationPrompt: string } {
    let systemPrompt = '';
    const nonSystemMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (typeof msg.content === 'string' ? msg.content : this.contentPartsToText(msg.content)) + '\n';
      } else {
        nonSystemMessages.push(msg);
      }
    }

    const conversationPrompt = this.serializeConversationXml(nonSystemMessages);
    return { systemPrompt: systemPrompt.trim(), conversationPrompt };
  }

  /**
   * Serialize non-system messages as XML for piping to Claude Code stdin.
   * Single user messages are passed through as plain text (no XML wrapper).
   */
  private serializeConversationXml(messages: ChatMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length === 1 && messages[0].role === 'user') {
      /* Single user message — no XML wrapper needed */
      return typeof messages[0].content === 'string'
        ? messages[0].content
        : this.contentPartsToText(messages[0].content);
    }

    const lines: string[] = ['<conversation>'];
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : this.contentPartsToText(msg.content);

      if (msg.role === 'tool') {
        lines.push(`<message role="tool" tool_call_id="${msg.tool_call_id ?? ''}">${content}</message>`);
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const toolCallXml = msg.tool_calls.map(tc =>
          `<tool_call name="${tc.function.name}">${tc.function.arguments}</tool_call>`
        ).join('');
        lines.push(`<message role="assistant">${toolCallXml}</message>`);
      } else {
        lines.push(`<message role="${msg.role}">${content}</message>`);
      }
    }
    lines.push('</conversation>');
    return lines.join('\n');
  }

  /** Convert MessageContentPart[] to plain text (best-effort). */
  private contentPartsToText(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('');
    }
    return String(content);
  }

  /* ---- Private: tool schema injection --------------------------- */

  /**
   * Append tool schemas and calling instructions to the system prompt.
   * Tools are formatted as XML blocks that Claude handles natively.
   */
  private injectToolSchemas(
    systemPrompt: string,
    tools: any[],
    toolChoice?: any,
  ): string {
    const toolsXml = tools.map(t => {
      const fn = t.function ?? t;
      return `<tool name="${fn.name}" description="${fn.description ?? ''}">\n  <parameters>${JSON.stringify(fn.parameters ?? {})}</parameters>\n</tool>`;
    }).join('\n');

    const choiceInstruction = this.toolChoiceInstruction(toolChoice);

    return `${systemPrompt}

<available_tools>
${toolsXml}
</available_tools>

<instructions>
${choiceInstruction}
When calling tools, respond with response_type "tool_calls" and include an array of tool calls.
When responding with text, respond with response_type "text" and include your response in the "text" field.
Each tool call must include "id" (unique string), "name" (tool name), and "arguments" (object matching the tool's parameters schema).
</instructions>`;
  }

  /** Map toolChoice to a natural language instruction. */
  private toolChoiceInstruction(toolChoice: any): string {
    if (!toolChoice || toolChoice === 'auto') {
      return 'Use tools if helpful to answer the user, otherwise respond with text.';
    }
    if (toolChoice === 'required') {
      return 'You MUST call at least one tool. Do not respond with text only.';
    }
    if (toolChoice === 'none') {
      return 'Do not use any tools. Respond with text only.';
    }
    if (typeof toolChoice === 'object' && toolChoice.function?.name) {
      return `You MUST call the tool named "${toolChoice.function.name}".`;
    }
    return 'Use tools if helpful to answer the user, otherwise respond with text.';
  }

  /* ---- Private: response builders ------------------------------- */

  /**
   * Build a streaming chunk for a piece of the reply's text: `delta` is the
   * new text, and `message.content` the reply's text so far.
   */
  private buildTextDeltaChunk(
    delta: string,
    textSoFar: string,
    modelId: string,
    responseId: string,
  ): ModelCompletionResponse {
    return {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Date.now(),
      modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: textSoFar },
        finishReason: null,
      }],
      responseTextDelta: delta,
      isFinal: false,
    };
  }

  /** Build a text-only ModelCompletionResponse. */
  private buildTextResponse(
    text: string,
    result: { sessionId?: string; usage?: { input_tokens: number; output_tokens: number } },
    responseId?: string,
    usage?: ModelUsage,
    modelId?: string,
  ): ModelCompletionResponse {
    const u = usage ?? this.buildUsage(result.usage);
    return {
      id: responseId ?? `cc-${result.sessionId ?? Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      modelId: modelId ?? this.defaultModelId ?? 'claude-sonnet-4-6',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      }],
      usage: u,
      isFinal: true,
    };
  }

  /** Build a tool-call ModelCompletionResponse. */
  private buildToolCallResponse(
    toolCalls: Array<{ id: string; name: string; arguments: any }>,
    result: { sessionId?: string; usage?: { input_tokens: number; output_tokens: number } },
    responseId?: string,
    usage?: ModelUsage,
    modelId?: string,
  ): ModelCompletionResponse {
    const u = usage ?? this.buildUsage(result.usage);
    return {
      id: responseId ?? `cc-${result.sessionId ?? Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      modelId: modelId ?? this.defaultModelId ?? 'claude-sonnet-4-6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          })),
        },
        finishReason: 'tool_calls',
      }],
      usage: u,
      isFinal: true,
    };
  }

  /**
   * The error a result flagged `is_error` stands for: generateCompletion()
   * throws it, and a stream ends with it. The bridge's execute() throws the
   * same error when the CLI exits non-zero after such a result.
   */
  private errorResultError(message: string): ClaudeCodeProviderError {
    return ClaudeCodeProviderError.fromErrorResult(message);
  }

  /** Build a terminal streaming error chunk instead of throwing mid-stream. */
  private buildStreamErrorResponse(
    message: string,
    modelId: string,
    responseId: string,
    usage?: ModelUsage,
    code?: string | number,
    details?: unknown,
    type?: string,
  ): ModelCompletionResponse {
    return {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Date.now(),
      modelId,
      choices: [],
      usage,
      error: {
        message,
        ...(type === undefined ? {} : { type }),
        ...(code === undefined ? {} : { code }),
        ...(details === undefined ? {} : { details }),
      },
      isFinal: true,
    };
  }

  /** Convert raw usage from CLI bridge to ModelUsage. Always costUSD: 0. */
  private buildUsage(raw?: { input_tokens: number; output_tokens: number }): ModelUsage {
    if (!raw) return { totalTokens: 0, costUSD: 0 };
    return {
      promptTokens: raw.input_tokens,
      completionTokens: raw.output_tokens,
      totalTokens: raw.input_tokens + raw.output_tokens,
      costUSD: 0,
    };
  }

  /** Guard — throws if provider is not initialized. */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new ClaudeCodeProviderError(
        'ClaudeCodeProvider is not initialized. Call initialize() first.',
        'UNKNOWN',
        'Ensure the provider is initialized before making API calls.',
        false,
      );
    }
  }
}
