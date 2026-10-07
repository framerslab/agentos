# CLI-Based LLM Providers

AgentOS supports using locally-installed CLI tools as LLM providers. This allows users to leverage their existing subscriptions (Anthropic Max, Google AI Pro/Ultra, OpenAI ChatGPT Plus/Pro) without separate API keys.

## Architecture

CLI providers use the **subprocess bridge pattern** — each provider spawns the CLI binary via `execa`, pipes prompts through stdin, and parses structured JSON/NDJSON output from stdout.

```
IProvider (AgentOS interface)
    │
    ▼
ClaudeCodeProvider / GeminiCLIProvider     ← message formatting, tool schema injection, response mapping
    │
    ▼
ClaudeCodeCLIBridge / GeminiCLIBridge      ← extends CLISubprocessBridge (flag assembly, error classification)
    │
    ▼
CLISubprocessBridge (abstract base)        ← sandbox/subprocess/ — spawn, pipe, NDJSON parse, timeout/abort
    │
    ▼
execa → local CLI binary                   ← user's authenticated CLI (claude, gemini, codex)
```

### Core Subprocess Module

The generalized subprocess bridge lives at `src/safety/sandbox/subprocess/`:

- **[`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts)** — abstract base class (template method pattern). Owns process lifecycle: spawn, stdin pipe, NDJSON line splitting, timeout, abort signal. Subclasses implement `buildArgs()`, `classifyError()`, `parseStreamEvent()`.
- **[`CLISubprocessError`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts)** — generic error with open string codes, `guidance` (user-facing fix instructions), and `recoverable` flag. Works for any binary, not just LLM CLIs.
- **[`CLIRegistry`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLIRegistry.ts)** — PATH scanner that discovers installed CLIs. Ships with 10 well-known defaults (claude, gemini, git, gh, docker, node, python3, ffmpeg, gcloud, aws). Feeds into health checks and capability discovery.

## Available CLI Providers

| Provider ID | Binary | Auth | Default Model | Status |
|---|---|---|---|---|
| `claude-code-cli` | `claude` | Anthropic Max subscription | `claude-sonnet-4-6` | **Confirmed — officially supported by Anthropic** |
| `gemini-cli` | `gemini` | Google account login | `gemini-3.5-flash` | **Use at your own risk — see ToS warning below** |

## Terms of Service Compliance

### claude-code-cli — CONFIRMED SAFE

Anthropic **explicitly supports** programmatic use of Claude Code CLI via the `-p` (print) flag. Their [headless mode documentation](https://code.claude.com/docs/en/headless) provides examples for CI/CD pipelines, shell scripts, GitHub Actions, and subprocess invocation.

Key points from Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance):
- Calling `claude -p` from scripts and automation is the intended use case
- The `--bare` flag is recommended for reproducible scripted calls
- Max plan usage limits "assume ordinary, individual usage"
- **Extracting or reusing OAuth tokens** from Claude Code in other tools is explicitly prohibited

**What AgentOS does**: Spawns `claude --bare -p --output-format json` as a subprocess. Never extracts, proxies, or stores OAuth tokens. Each invocation uses the user's own locally-authenticated Claude Code installation. This is the pattern Anthropic designed and documents.

### gemini-cli — USE AT YOUR OWN RISK

> **WARNING**: Google's Gemini CLI Terms of Service contain language that could be interpreted as prohibiting third-party subprocess invocation when using Google account (OAuth) authentication. While Google's own [automation tutorial](https://geminicli.com/docs/cli/tutorials/automation/) promotes headless scripted use, their ToS also states:
>
> *"Directly accessing the services powering Gemini CLI using third-party software, tools, or services is a violation of applicable terms and policies, and such actions may be grounds for suspension or termination of your account."*
>
> Google has enforced this aggressively — users report account suspensions for using third-party tools with Gemini CLI OAuth. A first-offense reinstatement process exists but requires manual appeal.

**Safer alternative**: Use the `gemini` provider with `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey). This uses the Gemini API directly (separate ToS) and carries no third-party usage risk. The `gemini-cli` provider is available for users who understand and accept the risk.

**What AgentOS does**: Spawns `gemini -p --output-format json` as a subprocess. System prompts are injected via a temporary file + the `GEMINI_SYSTEM_MD` environment variable (Gemini CLI's official mechanism). Never extracts or stores OAuth tokens.

### OpenAI Codex CLI — OAuth Token Extraction Supported

OpenAI's approach is the most permissive. The Codex CLI is Apache 2.0 licensed, and an OpenAI maintainer [confirmed](https://github.com/openai/codex/discussions/8338) that the terms are "quite permissive" toward third-party tools doing similar things.

AgentOS includes a complete [`OpenAIOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/OpenAIOAuthFlow.ts) implementation that uses the same public OAuth client ID (`app_EMoamEEZ73f0CkXaXp7hrann`) and PKCE flow as the Codex CLI. This allows users to authenticate with their ChatGPT Plus/Pro subscription and obtain an API key without a separate Console account.

**Current status**: The OAuth flow is architecturally complete but disabled in the CLI pending full integration testing. The flow mirrors Codex CLI's `obtain_api_key()` step exactly — browser-based PKCE on `localhost:1455`, id_token exchange for API key.

## Provider Details

### claude-code-cli

- **Binary**: `claude` (install: `npm install -g @anthropic-ai/claude-code`)
- **Auth**: User logs into Claude Code separately by running `claude` in terminal
- **System prompt**: `--system-prompt` flag (direct)
- **Tool calling**: `--json-schema` for structured output enforcement
- **Streaming**: `--output-format stream-json` with `--verbose --include-partial-messages`
- **Key flags**: `--bare` (skip plugins/hooks), `--max-turns 1` (single completion)
- **Models**: claude-opus-5-5, claude-fable-5-1, claude-fable-5, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-4-6 (default), claude-haiku-4-5-20251001
- **Cost**: $0 per token (subscription)
- **Auto-detection**: Checks if `claude` is on PATH (after API-key providers, before Ollama)

### gemini-cli

- **Binary**: `gemini` (install: `npm install -g @google/gemini-cli`)
- **Auth**: User logs in via Google account by running `gemini` in terminal
- **System prompt**: Temp file + `GEMINI_SYSTEM_MD` env var (no `--system-prompt` flag)
- **Tool calling**: XML prompt-based with `<tool_call>` markers (no `--json-schema` support)
- **Streaming**: `--output-format stream-json`
- **Key flags**: `-p` (headless), `-m` (model selection)
- **Models**: gemini-3.5-flash (default), gemini-3.1-pro-preview, gemini-3.5-flash-lite, gemini-2.5-flash-lite. The CLI answers gemini-2.5-flash with gemini-3.5-flash and returns 404 for gemini-2.5-pro.
- **Cost**: $0 per token (Google account — free tier: 60 req/min, 1000 req/day; higher with AI Pro/Ultra)
- **Auto-detection**: Checks if `gemini` is on PATH (after `claude-code-cli`, before Ollama)

## Adding a New CLI Provider

To add support for a new CLI binary:

1. Create `{Name}CLIBridge extends CLISubprocessBridge` — implement `buildArgs()`, `classifyError()`, `parseStreamEvent()`
2. Create `{Name}CLIProviderError extends CLISubprocessError` — define CLI-specific error codes
3. Create `{Name}CLIProvider implements IProvider` — message formatting, tool calling strategy, response mapping
4. Register in `CLIRegistry.WELL_KNOWN_CLIS` if it should be auto-discovered
5. Register in [`AIModelProviderManager`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts), `SmallModelResolver`, `LLM_PROVIDERS`, `PROVIDER_CATALOG`, and the provider registry

The [`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts) base class handles ~60% of the work (spawn, pipe, NDJSON parse, timeout, health checks). Subclasses only implement what's CLI-specific.

## Auto-Detection Order

When no provider is explicitly configured, AgentOS probes in this order:

```
1. openrouter     → OPENROUTER_API_KEY
2. openai         → OPENAI_API_KEY
3. anthropic      → ANTHROPIC_API_KEY
4. gemini         → GEMINI_API_KEY
5. claude-code-cli → `which claude` (PATH detection)
6. gemini-cli     → `which gemini` (PATH detection)
7. ollama         → OLLAMA_BASE_URL
```

API-key providers take priority (explicitly configured). CLI providers come next (subscription-grade models). Ollama is last (local/free).
