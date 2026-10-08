# CLI Error Codes

Reference for all error codes defined in [`CLISubprocessError`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts) and the [`CLI_ERROR`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts) constant object. These codes are used across all CLI subprocess operations -- LLM providers, dev tools, media tools, and any custom bridges.

## CLISubprocessError Class

The base error class for all CLI subprocess operations. Not specific to any single binary -- works for `claude`, `gemini`, `ffmpeg`, `git`, or any binary managed by [`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts).

### Class Structure

```typescript
class CLISubprocessError extends Error {
  /** Error code -- open string, not a fixed union. Each CLI defines its own. */
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

Common error code constants shared across many CLIs. These are suggestions, not constraints -- consumers can use these or define their own custom codes.

```typescript
import { CLI_ERROR } from '@framers/agentos/sandbox/subprocess';
```

### BINARY_NOT_FOUND

| Property | Value |
|----------|-------|
| Code | `"BINARY_NOT_FOUND"` |
| Recoverable | No |
| Description | Binary not found on PATH. The `which` check for the binary failed. |
| Common Cause | The CLI is not installed, or its directory is not in the system PATH. |
| How to Fix | Install the binary using its official instructions. Verify PATH includes the installation directory. On macOS, ensure `/opt/homebrew/bin` or `/usr/local/bin` is in PATH. |

### NOT_AUTHENTICATED

| Property | Value |
|----------|-------|
| Code | `"NOT_AUTHENTICATED"` |
| Recoverable | No |
| Description | Binary installed but not authenticated or logged in. The CLI requires a login step before use. |
| Common Cause | The user has not run the initial authentication flow (e.g., `claude` login, `gcloud auth login`, `gh auth login`). |
| How to Fix | Run the CLI's login command manually. For `claude`: run `claude` in terminal and follow prompts. For `gemini`: run `gemini` in terminal and authenticate via Google. |

### VERSION_OUTDATED

| Property | Value |
|----------|-------|
| Code | `"VERSION_OUTDATED"` |
| Recoverable | No |
| Description | Binary version too old for required features. A specific flag, output format, or API is unavailable in the installed version. |
| Common Cause | The user has an old version of the CLI installed. Auto-update may be disabled. |
| How to Fix | Update the CLI to the latest version. For npm-installed CLIs: `npm install -g <package>@latest`. For brew-installed CLIs: `brew upgrade <package>`. |

### SPAWN_FAILED

| Property | Value |
|----------|-------|
| Code | `"SPAWN_FAILED"` |
| Recoverable | No |
| Description | Process failed to start. The underlying `execa` spawn call threw before the process could begin executing. |
| Common Cause | File permissions (EACCES), missing shared libraries, corrupted binary, or OS-level restrictions (AppArmor, SELinux, Gatekeeper). |
| How to Fix | Verify the binary has execute permissions (`chmod +x`). Check system logs for OS-level blocks. Reinstall the binary if corrupted. |

### TIMEOUT

| Property | Value |
|----------|-------|
| Code | `"TIMEOUT"` |
| Recoverable | Yes |
| Description | Process exceeded the configured timeout. The subprocess was killed after the deadline elapsed. |
| Common Cause | The command is genuinely long-running, the process is stuck waiting for input, or network latency for cloud CLIs. |
| How to Fix | Increase the `timeout` option in bridge configuration. Ensure the command does not require interactive input. For network-dependent CLIs, check connectivity. |

### CRASHED

| Property | Value |
|----------|-------|
| Code | `"CRASHED"` |
| Recoverable | Yes |
| Description | Process exited with a non-zero exit code. The binary ran but returned an error. |
| Common Cause | Invalid arguments, malformed input, internal CLI error, upstream service error (for API-backed CLIs). |
| How to Fix | Check the error message and stderr output for details. Verify the command arguments are correct. For LLM CLIs, check that the prompt format is valid. |

### RATE_LIMITED

| Property | Value |
|----------|-------|
| Code | `"RATE_LIMITED"` |
| Recoverable | Yes |
| Description | Rate limit or quota exceeded. The upstream service has throttled requests. |
| Common Cause | Too many requests in a short period. For subscription-based CLIs (claude, gemini), exceeding the plan's usage limits. |
| How to Fix | Wait and retry after a delay. Check the CLI's rate limit documentation. Consider upgrading the subscription plan or using an API-key provider with higher limits. |

### PERMISSION_DENIED

| Property | Value |
|----------|-------|
| Code | `"PERMISSION_DENIED"` |
| Recoverable | No |
| Description | Permission denied (EACCES). The binary or a resource it needs is not accessible. |
| Common Cause | The binary lacks execute permissions. The target file/directory lacks read/write permissions. The process is running as a restricted user. |
| How to Fix | Grant appropriate permissions (`chmod`). Run as a user with sufficient privileges. Check filesystem ACLs and ownership. |

### CONTEXT_TOO_LONG

| Property | Value |
|----------|-------|
| Code | `"CONTEXT_TOO_LONG"` |
| Recoverable | No |
| Description | Input or context too long for the CLI to handle. The prompt, file, or data exceeds the binary's maximum input size. |
| Common Cause | Sending a very large prompt to an LLM CLI, piping a huge file to a processing tool, or exceeding model context window limits. |
| How to Fix | Reduce input size. For LLM CLIs, truncate or summarize the prompt. For file-processing CLIs, split the input into smaller chunks. |

---

## Custom Error Codes

The `code` field is an open string, not a fixed union. Consumers can define CLI-specific error codes beyond the common set:

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

## Error Handling Pattern

```typescript
import { CLISubprocessError, CLI_ERROR } from '@framers/agentos/sandbox/subprocess';

try {
  const result = await bridge.execute({ prompt });
} catch (error) {
  if (error instanceof CLISubprocessError) {
    console.error(`[${error.code}] ${error.binaryName}: ${error.message}`);
    console.error(`Fix: ${error.guidance}`);

    if (error.recoverable) {
      // Retry or fall back to another provider
      return await fallbackBridge.execute({ prompt });
    }

    // Non-recoverable -- surface to user
    throw error;
  }

  // Unknown error
  throw error;
}
```

## Exports

All error types are exported from the subprocess barrel:

```typescript
import { CLISubprocessError, CLI_ERROR } from '@framers/agentos/sandbox/subprocess';
```

Source file: `src/safety/sandbox/subprocess/errors.ts`
