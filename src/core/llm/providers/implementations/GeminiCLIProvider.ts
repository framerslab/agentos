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
/*  Tool-call markup in a streamed reply                               */
/* ------------------------------------------------------------------ */

/** The closing tag of a tool-call block. */
const TOOL_CALL_CLOSE = '</tool_call>';

/** `\s+` in the opening tag TOOL_CALL_REGEX reads. */
const SPACE = Symbol('space');
/** `[^"]+` in the opening tag TOOL_CALL_REGEX reads: an attribute's value. */
const VALUE = Symbol('value');

/** The opening tag TOOL_CALL_REGEX reads, `<tool_call\s+id="([^"]+)"\s+name="([^"]+)">`, part by part. */
const OPENING_TAG: ReadonlyArray<string | typeof SPACE | typeof VALUE> = [
  '<tool_call', SPACE, 'id="', VALUE, '"', SPACE, 'name="', VALUE, '">',
];

/**
 * Reads the opening tag of a tool-call block at the start of `text` as
 * TOOL_CALL_REGEX does: its length when `text` starts with one, `'more'` when
 * `text` ends before that can be told, and `'none'` when `text` does not start
 * with one. Each `\s+` and `[^"]+` of the tag is followed by a character it
 * cannot take, so reading each as far as it goes reads the tag as the regex
 * does.
 */
function openingTagLength(text: string): number | 'more' | 'none' {
  let at = 0;
  for (const part of OPENING_TAG) {
    if (typeof part === 'string') {
      const seen = text.slice(at, at + part.length);
      if (!part.startsWith(seen)) return 'none';
      if (seen.length < part.length) return 'more';
      at += part.length;
      continue;
    }
    const start = at;
    while (at < text.length && (part === SPACE ? /\s/.test(text[at]) : text[at] !== '"')) at++;
    if (at === text.length) return 'more';
    if (at === start) return 'none';
  }
  return at;
}

/**
 * Reads a tool-call block at the start of `text` as TOOL_CALL_REGEX does: its
 * length once the first closing tag after its opening tag has arrived,
 * `'more'` while it may still be one, and `'none'` when `text` does not start
 * with one. The closing tag is searched for from `closeFrom` at the earliest,
 * past text already searched.
 */
function toolCallBlockLength(text: string, closeFrom: number): number | 'more' | 'none' {
  const opening = openingTagLength(text);
  if (typeof opening !== 'number') return opening;
  const close = text.indexOf(TOOL_CALL_CLOSE, Math.max(opening, closeFrom));
  return close < 0 ? 'more' : close + TOOL_CALL_CLOSE.length;
}

/**
 * The text of a reply streamed with tools, less the blocks that
 * parseToolCallsFromText reads as tool calls from the whole reply. It reads
 * the text as TOOL_CALL_REGEX does, from left to right, and holds back the
 * text from a '<' that may open a block until the first closing tag after the
 * block's opening tag shows whether it is one. A block whose body is not JSON
 * is no tool call to the reply's parse either, and goes out as text.
 */
class ToolCallMarkupFilter {
  /** Text not yet known to lie outside a tool-call block: empty, or from a '<' on. */
  private held = '';

  /** Takes the next piece of the reply, and returns the text now known to lie outside a tool-call block. */
  push(piece: string): string {
    /* The held text has been searched for a closing tag: one that ends in
     * this piece starts at most the tag's length less one before it. */
    let closeFrom = Math.max(0, this.held.length - (TOOL_CALL_CLOSE.length - 1));
    let rest = this.held + piece;
    let out = '';
    for (;;) {
      const at = rest.indexOf('<');
      if (at < 0) {
        out += rest;
        rest = '';
        break;
      }
      if (at > 0) {
        out += rest.slice(0, at);
        rest = rest.slice(at);
        closeFrom = 0;
      }
      const length = toolCallBlockLength(rest, closeFrom);
      if (length === 'more') break;
      closeFrom = 0;
      if (length === 'none') {
        out += '<';
        rest = rest.slice(1);
        continue;
      }
      const block = rest.slice(0, length);
      if (parseToolCallsFromText(block) === null) out += block;
      rest = rest.slice(length);
    }
    this.held = rest;
    return out;
  }

  /**
   * Once the reply has ended: the text still held, which no closing tag
   * followed, so no tool-call block.
   */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
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
      throw this.errorResultError(result.result);
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

  /**
   * Stream a completion by spawning `gemini -p --output-format stream-json`.
   *
   * The final chunk is yielded once the bridge's stream has ended, which is
   * after the CLI has exited: a non-zero exit after the result line ends the
   * stream with the bridge's classified error, and a result with
   * `status: 'error'` ends it with an error chunk.
   *
   * With tools, the reply's text streams without the tool-call blocks the
   * provider reads as tool calls, which reach the consumer as the final
   * chunk's tool calls alone (a block whose body is not JSON is no tool call,
   * and streams as text): the text from a '<' that may open a block is held
   * back until the block's closing tag shows whether it is one. Text still
   * held when the run ends with its reply is no block, and is yielded as one
   * text delta just before the final chunk; a run that fails ends with its
   * error chunk alone. A caller who aborts while the consumer holds that
   * delta gets the abort chunk in place of the reply's final chunk.
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

    const bridgeOpts: BridgeOptions = {
      prompt: conversationPrompt,
      systemPrompt: fullSystemPrompt || undefined,
      model: modelId,
      timeout: this.config.requestTimeout,
      abortSignal: options.abortSignal,
    };

    let accumulatedText = '';
    /* With tools, the tool-call blocks in the reply's text are left out of
     * the text the stream yields, which `streamedText` holds. */
    const markup = hasTools ? new ToolCallMarkupFilter() : undefined;
    let streamedText = '';
    const responseId = `gc-${Date.now()}`;
    let finalUsage: ModelUsage | undefined;
    /* The chunk that ends the stream. It is held while the bridge's stream is
     * read to its end, where the bridge awaits the CLI's exit, so a failed
     * exit after the result line still reaches the catch below. */
    let finalChunk: ModelCompletionResponse | undefined;
    /* Set when the CLI reports a failure in its own output (an error event or
     * an error result), which says more than the exit code that follows. */
    let cliReportedError = false;

    try {
      for await (const event of this.bridge.streamWithSystemPrompt(bridgeOpts)) {
        /* Once the ending is known the rest of the stream is only drained. */
        if (finalChunk) continue;
        switch (event.type) {
          case 'text_delta': {
            accumulatedText += event.text;
            const text = markup ? markup.push(event.text) : event.text;
            /* Text held back as part of a possible tool-call block goes out
             * once it is known not to be one. */
            if (markup && text === '') break;
            streamedText += text;
            yield this.buildTextDeltaChunk(text, streamedText, modelId, responseId);
            break;
          }

          case 'result': {
            const usage = event.usage;
            finalUsage = usage
              ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens, costUSD: 0 }
              : { totalTokens: 0, costUSD: 0 };

            /* A failed run the CLI reports in its result: the error
             * generateCompletion() throws for it */
            if (event.isError) {
              /* The bridge carries the failure's message in `error`. */
              const error = this.errorResultError(event.error ?? event.result);
              cliReportedError = true;
              finalChunk = this.buildStreamErrorResponse(error.message, modelId, responseId, finalUsage, error.code, error);
              break;
            }

            /* The tool calls are read from the whole reply. */
            finalChunk = this.buildReplyResponse(
              event.result || accumulatedText,
              Boolean(hasTools),
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
              `Gemini CLI stream error: ${event.error}`,
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
          error?.message ?? 'Gemini CLI stream failed.',
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

    /* A stream that ended with no result line ends as one whose result
     * carried no text, its tool calls read from the whole reply as well, so
     * a block the deltas left out still arrives as a tool call. */
    if (!finalChunk) {
      finalChunk = this.buildReplyResponse(accumulatedText, Boolean(hasTools), {}, responseId, finalUsage, modelId);
    }

    /* Once the run has ended with its reply, the text still held back is no
     * tool-call block, as no closing tag followed it, and it goes out just
     * before the final chunk. A run that failed ends with its error chunk
     * alone. */
    const heldText = finalChunk.error ? '' : (markup?.flush() ?? '');
    if (heldText) {
      streamedText += heldText;
      yield this.buildTextDeltaChunk(heldText, streamedText, modelId, responseId);
      /* The bridge's stream has ended, so it no longer sees the caller's
       * signal. An abort while the consumer held the delta still comes before
       * the final chunk, and ends the stream as the bridge ends a run the
       * caller aborted before the stream's end. */
      if (options.abortSignal?.aborted) {
        const error = GeminiCLIProviderError.requestAborted();
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

    yield finalChunk;
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

  /**
   * Build a streaming chunk for a piece of the reply's text: `delta` is the
   * new text, and `message.content` the text the stream has yielded so far.
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

  /**
   * The final chunk of a reply: with tools, its tool calls when its text
   * holds tool-call blocks, and otherwise its text.
   */
  private buildReplyResponse(
    text: string,
    hasTools: boolean,
    result: { sessionId?: string; usage?: { input_tokens: number; output_tokens: number } },
    responseId: string,
    usage: ModelUsage | undefined,
    modelId: string,
  ): ModelCompletionResponse {
    const toolCalls = hasTools ? parseToolCallsFromText(text) : null;
    return toolCalls
      ? this.buildToolCallResponse(toolCalls, result, responseId, usage, modelId)
      : this.buildTextResponse(text, result, responseId, usage, modelId);
  }

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

  /**
   * The error a result flagged as an error stands for: generateCompletion()
   * throws it, and a stream ends with it.
   */
  private errorResultError(message: string): GeminiCLIProviderError {
    return new GeminiCLIProviderError(
      `Gemini CLI returned an error: ${message}`,
      'CRASHED',
      'Try running "gemini -p test" manually to diagnose.',
      true,
    );
  }

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
