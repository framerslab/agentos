# CLI Error Codes

[`CLISubprocessError`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts) is the error a [`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts) throws when the CLI it runs fails, and [`CLI_ERROR`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts) names nine codes for it. AgentOS ships two bridges, for the `claude` and `gemini` binaries behind the `claude-code-cli` and `gemini-cli` providers ([CLI Providers](../getting-started/CLI_PROVIDERS.md)). Those two bridges and their providers are the only AgentOS code that raises these errors: the [CLI Registry](./CLI_REGISTRY.md) reports a missing binary in its scan result and throws none of them. This page gives the class, each code, and when the built-in bridges and providers raise it.

## CLISubprocessError Class

A bridge subclass builds the error in its `classifyError()` method, and the bridge's `execute()` and `stream()` throw what that method returns. The class is tied to no binary: `binaryName` is a constructor argument, so a bridge for `ffmpeg` or `git` uses the same class.

### Class Structure

```typescript
class CLISubprocessError extends Error {
  /** Error code: an open string, not a fixed union. Each CLI defines its own. */
  readonly code: string;

  /** The binary that failed (e.g. 'claude', 'gemini', 'ffmpeg'). */
  readonly binaryName: string;

  /** Human-readable fix instructions shown to the user. */
  readonly guidance: string;

  /** Whether the caller can retry or fall back. */
  readonly recoverable: boolean;

  /** Optional underlying error or extra context. */
  readonly details?: unknown;
}
```

`guidance` and `recoverable` hold what the code that builds the error passes. No AgentOS code reads either field ([What AgentOS does with these errors](#what-agentos-does-with-these-errors)).

### Constructor

```typescript
new CLISubprocessError(
  message: string,        // human-readable error description
  code: string,           // error code string (use CLI_ERROR constants or your own)
  binaryName: string,     // the CLI binary that failed
  guidance: string,       // actionable fix instructions shown to the user
  recoverable?: boolean,  // true if the caller should attempt retry/fallback (default false)
  details?: unknown,      // optional underlying error or extra context
)
```

### Example

```typescript
throw new CLISubprocessError(
  'ffmpeg not found.',
  CLI_ERROR.BINARY_NOT_FOUND,
  'ffmpeg',
  'Install ffmpeg: brew install ffmpeg',
  false,
);
```

---

## CLI_ERROR Constants

`CLI_ERROR` maps nine names to strings of the same spelling. They are suggestions: `code` accepts any string, and the two built-in bridges pass the same strings as literals.

```typescript
import { CLI_ERROR } from '@framers/agentos/sandbox/subprocess';
```

The table lists where the built-in bridges and providers raise each code and the `recoverable` value they set. The sections after it give the exact conditions.

| Code | Raised by | `recoverable` |
|------|-----------|---------------|
| `BINARY_NOT_FOUND` | Provider `initialize()`; `classifyError()` on `ENOENT` | `false` |
| `NOT_AUTHENTICATED` | Provider `initialize()`; `classifyError()` on stderr text | `false` |
| `VERSION_OUTDATED` | Nothing | Not set |
| `SPAWN_FAILED` | `classifyError()` on `EACCES` | `false` |
| `TIMEOUT` | `classifyError()` on a timeout or a signal | `true` |
| `CRASHED` | `classifyError()` for every other failure; provider `generateCompletion()` on an error result | `true` |
| `RATE_LIMITED` | `classifyError()` on stderr text | `true` |
| `PERMISSION_DENIED` | Nothing | Not set |
| `CONTEXT_TOO_LONG` | `classifyError()` on stderr text | `false` |

`classifyError()` in both bridges ([`ClaudeCodeCLIBridge.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/ClaudeCodeCLIBridge.ts), [`GeminiCLIBridge.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/GeminiCLIBridge.ts)) checks its conditions in one order and returns the first that matches: a timeout or a signal, authentication, rate limit, context length, `ENOENT`, `EACCES`, and `CRASHED` when none does. The text checks are case-sensitive substring matches on the process's stderr.

### BINARY_NOT_FOUND

- The `initialize()` of [`ClaudeCodeProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/ClaudeCodeProvider.ts) and [`GeminiCLIProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/GeminiCLIProvider.ts) throws it when the bridge's `checkBinaryInstalled()` reports the binary as not installed. That check runs `which <binary>` and then `<binary> --version`, and a failure of either command reads as not installed.
- `classifyError()` returns it when the spawn fails with `ENOENT`.
- The providers' `checkHealth()` reports the same condition without throwing, as `details.error: 'BINARY_NOT_FOUND'`.

To fix it, install the CLI (`npm install -g @anthropic-ai/claude-code` or `npm install -g @google/gemini-cli`, the commands the error's `guidance` gives) and make sure the process that runs AgentOS has the binary's directory on its `PATH`.

### NOT_AUTHENTICATED

- `initialize()` throws it when the bridge's `checkAuthenticated()` returns `false`. The check pipes a one-line prompt (`Reply with exactly: pong`) through the CLI with a 30-second timeout, and any failure of that run reads as not authenticated: a timeout, a rate limit or a crash as well as a missing login.
- `classifyError()` returns it when stderr contains `not logged in`, `authentication` or `unauthorized`; the Gemini bridge also matches `sign in`.
- `checkHealth()` reports it without throwing, as `details.error: 'NOT_AUTHENTICATED'`.

To fix it, run `claude` or `gemini` in a terminal and complete the login. When the login is in place and `initialize()` still throws this code, run the CLI by hand to see the failure the check reported as a missing login.

### VERSION_OUTDATED

No AgentOS code raises it. The constant and both providers' code types declare it for a bridge that checks a version. `checkBinaryInstalled()` returns the version it parses from the `--version` output (the first `x.y.z` it finds, or `unknown`) and compares it with nothing.

### SPAWN_FAILED

`classifyError()` returns it when the spawn fails with `EACCES`, a permission error. Check the execute permission on the binary.

### TIMEOUT

`classifyError()` returns it when [execa](https://github.com/sindresorhus/execa), which runs the process, marks the failed run `timedOut` or `isTerminated`:

- `timedOut` means the run passed its `timeout`, a field of the `BridgeOptions` given to `execute()` or `stream()` (120000 ms when unset). The two providers pass their `requestTimeout` config value, also 120000 ms by default.
- `isTerminated` is true whenever a signal ended the process ([`result.js`](https://github.com/sindresorhus/execa/blob/v10.0.1/lib/return/result.js) in execa 10.0.1). A call cancelled through `abortSignal` therefore carries this code when the signal execa sends ends the process, and so does a process killed from outside.

To allow more time, pass a larger `timeout` to a bridge you call yourself, or set `requestTimeout` in the config the provider is initialized with. `generateText()` and the other helpers initialize the provider with a key and a base URL only, so their CLI calls run on the default.

### CRASHED

- `classifyError()` returns it for every failure the earlier checks do not match, a non-zero exit code among them. Its `guidance` ends with the last 500 characters of stderr.
- The providers' `generateCompletion()` throws it when the CLI exits normally and its JSON result carries `is_error: true`.

### RATE_LIMITED

`classifyError()` returns it when stderr contains `rate limit`, `too many requests` or `429`; the Gemini bridge also matches `quota` and `RESOURCE_EXHAUSTED`. Its `guidance` says to wait a few minutes and try again.

### PERMISSION_DENIED

No AgentOS code raises it, and the providers' code types leave it out. The built-in bridges report a spawn refused with `EACCES` as [`SPAWN_FAILED`](#spawn_failed).

### CONTEXT_TOO_LONG

`classifyError()` returns it when stderr contains `context` together with `too long` or `token limit`; the Gemini bridge also accepts `exceeds`. Start a new conversation or use a model with a larger context window.

---

## Codes Outside CLI_ERROR

The two providers add codes of their own to the nine ([`ClaudeCodeProviderError.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/errors/ClaudeCodeProviderError.ts), [`GeminiCLIProviderError.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/errors/GeminiCLIProviderError.ts)):

| Code | Provider | Raised when |
|------|----------|-------------|
| `EMBEDDINGS_NOT_SUPPORTED` | Both | `generateEmbeddings()` is called: neither provider serves embeddings |
| `UNKNOWN` | Both | A completion is requested while the provider is not initialized |
| `SCHEMA_PARSE_FAILED` | Claude Code | Never. A reply that does not parse as the tool-call shape is retried once without the schema and returned as text |
| `TOOL_PARSE_FAILED` | Gemini CLI | Never. The type declares it and nothing raises it |

## Custom Error Codes

The `code` field is an open string, not a fixed union. A bridge can define codes beyond the common set:

```typescript
// Custom code for a media CLI
new CLISubprocessError(
  'Codec not found',
  'CODEC_NOT_FOUND',        // custom code
  'ffmpeg',
  'Install the required codec: apt install libx264-dev',
  false,
);

// Custom code for a cloud CLI
new CLISubprocessError(
  'Stack deployment failed',
  'DEPLOY_FAILED',          // custom code
  'aws',
  'Check CloudFormation events: aws cloudformation describe-stack-events --stack-name ...',
  true,
);
```

---

## What AgentOS Does with These Errors

- **Bridge.** `execute()` and `stream()` throw the error `classifyError()` returns.
- **Provider, non-streaming.** `generateCompletion()` lets the bridge's error through.
- **Provider, streaming.** `generateCompletionStream()` does not throw for a bridge failure. The stream ends with a final chunk whose `error` holds the message, the `code` and, as `details`, the error object.
- **Initialization through the helpers.** `generateText()`, `streamText()` and the helpers built on them create the provider with [`createProviderManager()`](https://github.com/framerslab/agentos/blob/master/src/api/model.ts). When the provider's `initialize()` throws, that function throws a `ProviderInitializationError` whose `cause` is the `CLISubprocessError`.
- **Fallback.** Those helpers decide whether to try the next provider with [`isRetryableError()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts), which reads the error's name, HTTP status, `code` and message. It counts a `ProviderInitializationError` and the `TIMEOUT` code as retryable, and it never reads `recoverable`.

`guidance` and `recoverable` are for the host that catches the error: show `guidance` to the person who can fix the installation, and treat `recoverable` as the bridge's own hint when you write a retry of your own.

## Error Handling Pattern

A host that calls a bridge itself catches the error where it calls:

```typescript
import { CLISubprocessError } from '@framers/agentos/sandbox/subprocess';

async function run(prompt: string) {
  try {
    return await bridge.execute({ prompt });
  } catch (error) {
    if (error instanceof CLISubprocessError) {
      console.error(`[${error.code}] ${error.binaryName}: ${error.message}`);
      console.error(`Fix: ${error.guidance}`);

      if (error.recoverable) {
        // The bridge marked the failure as worth another try: here, on a second bridge.
        return await fallbackBridge.execute({ prompt });
      }
    }

    throw error;
  }
}
```

## Exports

The class and the constants are exported from the subprocess barrel:

```typescript
import { CLISubprocessError, CLI_ERROR } from '@framers/agentos/sandbox/subprocess';
```

Source file: `src/safety/sandbox/subprocess/errors.ts`
