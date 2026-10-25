/**
 * @file global-default.ts
 * Module-level default-provider registry.
 *
 * Lets applications configure a single default provider once at boot
 * (or via the `AgentOSConfig.defaultProvider` field) and have every
 * subsequent high-level call (`generateText`, `agent`, `agency`, etc.)
 * inherit from it without inline `apiKey` / `provider` arguments and
 * without environment variables.
 *
 * Resolution priority (highest first):
 *   1. Inline `apiKey` / `provider` / `model` / `baseUrl` on the call
 *   2. Global default set via `setDefaultProvider()`
 *   3. Environment-variable auto-detect chain (OPENROUTER_API_KEY, OPENAI_API_KEY, …)
 *   4. Error
 *
 * The registry is process-scoped: tests should call `clearDefaultProvider()`
 * in `beforeEach` / `afterEach` to avoid cross-test leakage.
 */

/**
 * Shape of the global default-provider config.
 *
 * All fields are optional. Setting just `provider` lets AgentOS pick
 * the provider's default model for each task type; setting `apiKey` /
 * `baseUrl` provides credentials without touching the environment.
 */
export interface GlobalDefaultProvider {
  /** Provider identifier (e.g. `"openai"`, `"anthropic"`, `"openrouter"`, `"ollama"`). */
  provider?: string;
  /**
   * Default text model for this provider (e.g. `"gpt-4o-mini"`), used by
   * `generateText`, `streamText` and agents. Embedding and image calls use it
   * too unless it is recognizably a chat model (GPT, Claude, Gemini, Llama,
   * MiniMax and similar families) sent to the provider's own endpoint, in
   * which case the provider's default model for the task applies. With a
   * custom endpoint, and for `embedText` on Ollama, it is always used. The
   * endpoint is the base URL the call is sent to: the call's own `baseUrl`,
   * else `baseUrl` here, else the provider's base-URL env var. An empty
   * string from the call or here is that URL, so the env var is not read,
   * and it names the provider's own endpoint. MiniMax's two API roots,
   * `https://api.minimax.io/v1` and the China root
   * `https://api.minimaxi.com/v1`, are its own endpoint, not a custom one.
   */
  model?: string;
  /** API key used when no inline override is supplied. */
  apiKey?: string;
  /**
   * Base URL override (useful for proxies, local Ollama, etc.). An empty
   * string is a value, not unset: the provider's base-URL env var is then not
   * read, and text and image calls go to the provider's own endpoint (Ollama
   * and `stable-diffusion-local`, which have none, refuse them).
   */
  baseUrl?: string;
}

let _globalDefault: GlobalDefaultProvider | undefined;

/**
 * Set the module-level default provider configuration.
 *
 * Call once at application boot. Pass `undefined` to clear.
 *
 * @example
 * ```ts
 * import { setDefaultProvider, generateText } from '@framers/agentos';
 *
 * setDefaultProvider({ provider: 'openai', apiKey: process.env.MY_OWN_KEY });
 *
 * // Every subsequent call inherits these defaults:
 * const { text } = await generateText({ prompt: 'hello' });
 * ```
 */
export function setDefaultProvider(config?: GlobalDefaultProvider): void {
  _globalDefault = config;
}

/**
 * Read the current module-level default provider configuration.
 * Returns `undefined` when none has been set.
 */
export function getDefaultProvider(): GlobalDefaultProvider | undefined {
  return _globalDefault;
}

/** Alias for `setDefaultProvider(undefined)` — clears the registry. */
export function clearDefaultProvider(): void {
  _globalDefault = undefined;
}
