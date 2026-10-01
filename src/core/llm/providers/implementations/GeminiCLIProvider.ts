/**
 * @fileoverview IProvider implementation that invokes the Gemini CLI
 * as a subprocess, allowing users to leverage their Google account
 * (free / AI Pro / AI Ultra) without an API key. Completely separate
 * from the `gemini` provider (which uses GEMINI_API_KEY).
 *
 * @module agentos/core/llm/providers/implementations/GeminiCLIProvider
 * @see GeminiCLIBridge
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
import { GeminiCLIBridge, type BridgeOptions, type StreamEvent } from './GeminiCLIBridge';
import { GeminiCLIProviderError } from '../errors/GeminiCLIProviderError';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Configuration for the Gemini CLI provider. */
export interface GeminiCLIProviderConfig {
  /** Override the default model. Defaults to `gemini-3.5-flash`. */
  defaultModelId?: string;
  /** Subprocess timeout in ms (default 120 000). */
  requestTimeout?: number;
}

/* ------------------------------------------------------------------ */
/*  Static model catalog                                               */
/* ------------------------------------------------------------------ */

/**
 * The model this provider uses when none is named. The CLI answers requests
 * for gemini-2.5-flash (and gemini-3.8-flash) with gemini-3.5-flash (probed
 * 2026-09-30 with --output-format json, which reports the model that
 * produced the answer), so the default names the model that actually runs.
 */
const GEMINI_CLI_DEFAULT_MODEL = 'gemini-3.5-flash';

const GEMINI_CLI_MODELS: ModelInfo[] = [
  {
    modelId: 'gemini-3.5-flash',
    providerId: 'gemini-cli',
    displayName: 'Gemini 3.5 Flash',
    description: 'Fast and capable; the model the CLI serves for Flash requests',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_048_576,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: true,
  },
  // Each of the next three answered as the model requested through Gemini CLI
  // (probed 2026-09-29 and again 2026-09-30 with --output-format json).
  {
    modelId: 'gemini-3.1-pro-preview',
    providerId: 'gemini-cli',
    displayName: 'Gemini 3.1 Pro',
    description: 'Most capable Gemini model, for complex reasoning and analysis',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_048_576,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'gemini-3.5-flash-lite',
    providerId: 'gemini-cli',
    displayName: 'Gemini 3.5 Flash-Lite',
    description: 'Lowest-cost Gemini 3.5 tier, for high-volume and latency-sensitive work',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_048_576,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    providerId: 'gemini-cli',
    displayName: 'Gemini 2.5 Flash-Lite',
    description: 'Cheapest Gemini model, and the cheap tier for this provider',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_048_576,
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
  },
  // Not served as requested (probed 2026-09-30): the CLI answers a
  // gemini-2.5-flash request with gemini-3.5-flash, and returns 404 for
  // gemini-2.5-pro and exits 1. Kept as `deprecated` rows, and passed through
  // at request time, so a caller holding either id still sees a catalog row
  // and an account that is served 2.5 Pro keeps working.
  {
    modelId: 'gemini-2.5-flash',
    providerId: 'gemini-cli',
    displayName: 'Gemini 2.5 Flash (answered by 3.5 Flash)',
    description: 'The CLI answers requests for this id with gemini-3.5-flash. Pin gemini-3.5-flash.',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
  {
    modelId: 'gemini-2.5-pro',
    providerId: 'gemini-cli',
    displayName: 'Gemini 2.5 Pro (not served by the CLI)',
    description: 'Gemini CLI returns 404 for this id and exits 1. Use gemini-3.1-pro-preview.',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 65_536,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
  // Retired by Google. Through Gemini CLI 0.59.0 (probed 2026-09-29),
  // gemini-2.0-flash-lite fails with ModelNotFoundError "This model
  // models/gemini-2.0-flash-lite is no longer available", and a request for
  // gemini-2.0-flash exits 0 with an answer produced by gemini-3.5-flash. Kept
  // as `deprecated` so a caller holding either id still sees a catalog row.
  {
    modelId: 'gemini-2.0-flash',
    providerId: 'gemini-cli',
    displayName: 'Gemini 2.0 Flash (retired)',
    description: 'Retired by Google. The CLI answers requests for it with a different model',
    capabilities: ['chat', 'vision_input', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 8_192,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
  {
    modelId: 'gemini-2.0-flash-lite',
    providerId: 'gemini-cli',
    displayName: 'Gemini 2.0 Flash Lite (retired)',
    description: 'Retired by Google and no longer served',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 1_000_000,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 8_192,
    pricePer1MTokensInput: 0,
    pricePer1MTokensOutput: 0,
    supportsStreaming: true,
    isDefaultModel: false,
    status: 'deprecated',
  },
];

/* ------------------------------------------------------------------ */
/*  Tool call XML parsing                                              */
/* ------------------------------------------------------------------ */

/** Regex to extract tool_call blocks from Gemini's text response. */
const TOOL_CALL_REGEX = /<tool_call\s+id="([^"]+)"\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;

/** Parse tool calls from raw text containing XML markers. */
function parseToolCallsFromText(text: string): Array<{ id: string; name: string; arguments: any }> | null {
  const calls: Array<{ id: string; name: string; arguments: any }> = [];
  let match: RegExpExecArray | null;

  /* Reset regex state */
  TOOL_CALL_REGEX.lastIndex = 0;

  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    try {
      const args = JSON.parse(match[3].trim());
      calls.push({ id: match[1], name: match[2], arguments: args });
    } catch {
      /* Malformed JSON in tool call — skip this one */
    }
  }

  return calls.length > 0 ? calls : null;
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

/**
 * LLM provider that wraps the locally-installed Gemini CLI.
 * Users authenticate Gemini separately (via `gemini` in terminal);
 * this provider detects that installation and uses it for completions.
 *
 * No API key required — the user's Google account handles access.
 * `costUSD` is always 0 since there is no per-token charge.
 */
export class GeminiCLIProvider implements IProvider {
  public readonly providerId: string = 'gemini-cli';
  public isInitialized: boolean = false;
  public defaultModelId?: string;

  private config!: GeminiCLIProviderConfig;
  private bridge: GeminiCLIBridge;

  constructor() {
    this.bridge = new GeminiCLIBridge();
  }

  /* ---- Lifecycle ------------------------------------------------- */

  async initialize(config: GeminiCLIProviderConfig): Promise<void> {
    this.config = {
      defaultModelId: GEMINI_CLI_DEFAULT_MODEL,
      requestTimeout: 120_000,
      ...config,
    };
    this.defaultModelId = this.config.defaultModelId;

    const installCheck = await this.bridge.checkBinaryInstalled();
    if (!installCheck.installed) {
      throw new GeminiCLIProviderError(
        'Gemini CLI is not installed.',
        'BINARY_NOT_FOUND',
        'Install Gemini CLI: npm install -g @google/gemini-cli\n\nThen log in by running "gemini" in your terminal.\n\nAlternatively, switch to a different provider:\n  wunderland login',
        false,
      );
    }

    const isAuth = await this.bridge.checkAuthenticated();
    if (!isAuth) {
      throw new GeminiCLIProviderError(
        'Gemini CLI is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Open your terminal and run:\n  gemini\n\nComplete the Google account login flow, then restart your agent.',
        false,
      );
    }

    this.isInitialized = true;
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
  }

  /* ---- Completions ---------------------------------------------- */

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

    const bridgeOpts: BridgeOptions = {
      prompt: conversationPrompt,
      systemPrompt: fullSystemPrompt || undefined,
      model: modelId,
      timeout: this.config.requestTimeout,
      abortSignal: options.abortSignal,
    };

    const result = await this.bridge.executeWithSystemPrompt(bridgeOpts);

    if (result.isError) {
      throw new GeminiCLIProviderError(
        `Gemini CLI returned an error: ${result.result}`,
        'CRASHED',
        'Try running "gemini -p test" manually to diagnose.',
        true,
      );
    }

    /* Try parsing tool calls from XML markers */
    if (hasTools) {
      const toolCalls = parseToolCallsFromText(result.result);
      if (toolCalls) {
        return this.buildToolCallResponse(toolCalls, result, undefined, undefined, modelId);
      }
      /* No tool calls found — check if it's a text response or parse failure */
      /* If text contains partial XML, retry without tools */
      if (result.result.includes('<tool_call') && !result.result.includes('</tool_call>')) {
        const retryOpts = { ...bridgeOpts, systemPrompt: systemPrompt || undefined };
        const retryResult = await this.bridge.executeWithSystemPrompt(retryOpts);
        return this.buildTextResponse(retryResult.result, retryResult, undefined, undefined, modelId);
      }
    }

    return this.buildTextResponse(result.result, result, undefined, undefined, modelId);
  }

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

    const bridgeOpts: BridgeOptions = {
      prompt: conversationPrompt,
      systemPrompt: fullSystemPrompt || undefined,
      model: modelId,
      timeout: this.config.requestTimeout,
      abortSignal: options.abortSignal,
    };

    let accumulatedText = '';
    const responseId = `gc-${Date.now()}`;
    let finalUsage: ModelUsage | undefined;
    let emittedFinal = false;

    try {
      for await (const event of this.bridge.streamWithSystemPrompt(bridgeOpts)) {
        switch (event.type) {
          case 'text_delta':
            accumulatedText += event.text;
            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: Date.now(),
              modelId,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: accumulatedText },
                finishReason: null,
              }],
              responseTextDelta: event.text,
              isFinal: false,
            };
            break;

          case 'result': {
            const usage = event.usage;
            finalUsage = usage
              ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens, costUSD: 0 }
              : { totalTokens: 0, costUSD: 0 };

            const finalText = event.result || accumulatedText;

            /* Try parsing tool calls from final text */
            if (hasTools) {
              const toolCalls = parseToolCallsFromText(finalText);
              if (toolCalls) {
                emittedFinal = true;
                yield this.buildToolCallResponse(
                  toolCalls,
                  { sessionId: event.sessionId, usage: event.usage },
                  responseId,
                  finalUsage,
                  modelId,
                );
                return;
              }
            }

            emittedFinal = true;
            yield this.buildTextResponse(
              finalText,
              { sessionId: event.sessionId, usage: event.usage },
              responseId,
              finalUsage,
              modelId,
            );
            return;
          }

          case 'error':
            emittedFinal = true;
            yield this.buildStreamErrorResponse(
              `Gemini CLI stream error: ${event.error}`,
              modelId,
              responseId,
              finalUsage,
            );
            return;
        }
      }
    } catch (error: any) {
      emittedFinal = true;
      yield this.buildStreamErrorResponse(
        error?.message ?? 'Gemini CLI stream failed.',
        modelId,
        responseId,
        finalUsage,
        error?.code,
        error,
      );
      return;
    }

    if (!emittedFinal) {
      yield this.buildTextResponse(accumulatedText, {}, responseId, finalUsage, modelId);
    }
  }

  /* ---- Embeddings (not supported) -------------------------------- */

  async generateEmbeddings(
    _modelId: string,
    _texts: string[],
    _options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    throw new GeminiCLIProviderError(
      'Gemini CLI does not support embeddings. Use a different provider (OpenAI, Ollama, etc.) for embedding operations.',
      'EMBEDDINGS_NOT_SUPPORTED',
      'Configure an additional provider with embedding support: wunderland login',
      false,
    );
  }

  /* ---- Model catalog -------------------------------------------- */

  async listAvailableModels(): Promise<ModelInfo[]> {
    return [...GEMINI_CLI_MODELS];
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return GEMINI_CLI_MODELS.find(m => m.modelId === modelId);
  }

  /* ---- Health check --------------------------------------------- */

  async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    const installCheck = await this.bridge.checkBinaryInstalled();
    if (!installCheck.installed) {
      return {
        isHealthy: false,
        details: {
          cliInstalled: false,
          error: 'BINARY_NOT_FOUND',
          guidance: 'Install Gemini CLI: npm install -g @google/gemini-cli',
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
          guidance: 'Run "gemini" in your terminal to log in with your Google account.',
        }),
      },
    };
  }

  /* ---- Private: message formatting ------------------------------ */

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

  private serializeConversationXml(messages: ChatMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length === 1 && messages[0].role === 'user') {
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

  private injectToolSchemas(systemPrompt: string, tools: any[], toolChoice?: any): string {
    const toolsXml = tools.map(t => {
      const fn = t.function ?? t;
      return `<tool name="${fn.name}" description="${fn.description ?? ''}">\n  <parameters>${JSON.stringify(fn.parameters ?? {})}</parameters>\n</tool>`;
    }).join('\n');

    const choiceInstruction = this.toolChoiceInstruction(toolChoice);

    return `${systemPrompt}

<available_tools>
${toolsXml}
</available_tools>

<response_format>
${choiceInstruction}
When you want to call a tool, respond with XML:
<tool_call id="unique-id" name="tool_name">{"arg": "value"}</tool_call>
When responding with text, respond normally without XML tags.
You may include multiple tool_call blocks in one response.
Each tool_call must include id (unique string), name (tool name), and a JSON body matching the tool's parameters schema.
</response_format>`;
  }

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

  private buildTextResponse(
    text: string,
    result: { sessionId?: string; usage?: { input_tokens: number; output_tokens: number } },
    responseId?: string,
    usage?: ModelUsage,
    modelId?: string,
  ): ModelCompletionResponse {
    const u = usage ?? this.buildUsage(result.usage);
    return {
      id: responseId ?? `gc-${result.sessionId ?? Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      modelId: modelId ?? this.defaultModelId ?? GEMINI_CLI_DEFAULT_MODEL,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      }],
      usage: u,
      isFinal: true,
    };
  }

  private buildToolCallResponse(
    toolCalls: Array<{ id: string; name: string; arguments: any }>,
    result: { sessionId?: string; usage?: { input_tokens: number; output_tokens: number } },
    responseId?: string,
    usage?: ModelUsage,
    modelId?: string,
  ): ModelCompletionResponse {
    const u = usage ?? this.buildUsage(result.usage);
    return {
      id: responseId ?? `gc-${result.sessionId ?? Date.now()}`,
      object: 'chat.completion',
      created: Date.now(),
      modelId: modelId ?? this.defaultModelId ?? GEMINI_CLI_DEFAULT_MODEL,
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

  private buildStreamErrorResponse(
    message: string,
    modelId: string,
    responseId: string,
    usage?: ModelUsage,
    code?: string | number,
    details?: unknown,
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
        ...(code === undefined ? {} : { code }),
        ...(details === undefined ? {} : { details }),
      },
      isFinal: true,
    };
  }

  private buildUsage(raw?: { input_tokens: number; output_tokens: number }): ModelUsage {
    if (!raw) return { totalTokens: 0, costUSD: 0 };
    return {
      promptTokens: raw.input_tokens,
      completionTokens: raw.output_tokens,
      totalTokens: raw.input_tokens + raw.output_tokens,
      costUSD: 0,
    };
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GeminiCLIProviderError(
        'GeminiCLIProvider is not initialized. Call initialize() first.',
        'UNKNOWN',
        'Ensure the provider is initialized before making API calls.',
        false,
      );
    }
  }
}
