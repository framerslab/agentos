# CLI Registry

The CLI Registry is AgentOS's detector for installed command-line tools. It scans the user's PATH for known binaries and detects their versions, and a host reads the results.

## Overview

AgentOS ships a JSON-based registry of 54 CLI descriptors across 8 categories. When a host calls `scan()`, the [`CLIRegistry`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLIRegistry.ts) runs `which` and the version flag for each registered binary in parallel and returns what is installed on the machine.

The registry is a standalone utility: nothing else in AgentOS calls it. A host uses it to report which tools are installed, to gate a feature on a binary, or to build capability descriptors for the discovery engine from the scan. The CLI bridges ([`ClaudeCodeCLIBridge`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/ClaudeCodeCLIBridge.ts), [`GeminiCLIBridge`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/GeminiCLIBridge.ts)) check their own binary with `checkBinaryInstalled()`, not through the registry, and the cli-executor pack's `shell_execute` runs whatever binaries the host has.

## Registry Categories

The 54 bundled descriptors live in `src/safety/sandbox/subprocess/registry/` as plain JSON files:

| File | Category | Count | Examples |
|------|----------|-------|----------|
| `llm.json` | llm | 5 | claude, gemini, ollama, lmstudio, aichat |
| `devtools.json` | devtools | 10 | git, gh, docker, docker-compose, kubectl, terraform, make, jq, yq, tmux |
| `runtimes.json` | runtime | 8 | node, python3, deno, bun, ruby, go, rustc, java |
| `package-managers.json` | package-manager | 7 | npm, pnpm, yarn, pip, uv, brew, cargo |
| `cloud.json` | cloud | 9 | gcloud, aws, az, flyctl, vercel, netlify, railway, heroku, wrangler |
| `databases.json` | database | 5 | psql, mysql, sqlite3, redis-cli, mongosh |
| `media.json` | media | 5 | ffmpeg, ffprobe, magick, sox, yt-dlp |
| `networking.json` | networking | 5 | curl, wget, ssh, rsync, scp |

## CLIDescriptor Shape

Each JSON entry conforms to the [`CLIDescriptor`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/types.ts) interface:

```typescript
interface CLIDescriptor {
  /** Binary name on PATH (e.g. 'claude', 'docker', 'ffmpeg'). */
  binaryName: string;
  /** Human-readable display name. */
  displayName: string;
  /** What this CLI does. */
  description: string;
  /** Category for grouping (e.g. 'llm', 'media', 'devtools'). */
  category: string;
  /** How to install if missing. */
  installGuidance: string;
  /** Version flag override if not --version. */
  versionFlag?: string;
  /** Regex to parse version from output (default: /(\d+\.\d+\.\d+)/). */
  versionPattern?: RegExp;
}
```

Example from `cloud.json`:

```json
{
  "binaryName": "gcloud",
  "displayName": "Google Cloud SDK",
  "description": "Google Cloud resource management",
  "category": "cloud",
  "installGuidance": "https://cloud.google.com/sdk/docs/install",
  "versionFlag": "--version"
}
```

## CLIRegistry API

```typescript
import { CLIRegistry, WELL_KNOWN_CLIS } from '@framers/agentos/sandbox/subprocess';
```

### Constructor

```typescript
const registry = new CLIRegistry();           // loads bundled JSON descriptors
const empty    = new CLIRegistry(false);       // starts empty (no defaults)
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `register(descriptor)` | `void` | Register a single CLI descriptor. Overwrites existing entry for same `binaryName`. |
| `registerAll(descriptors)` | `void` | Register multiple descriptors at once. |
| `unregister(binaryName)` | `boolean` | Remove a descriptor by binary name. |
| `scan()` | `Promise<CLIScanResult[]>` | Scan PATH for all registered CLIs (parallel `which` + `--version`). |
| `check(binaryName)` | `Promise<CLIScanResult>` | Check a single binary by name. |
| `list()` | `CLIDescriptor[]` | Get all registered descriptors (installed status unknown). |
| `installed()` | `Promise<CLIScanResult[]>` | Get only CLIs that are installed. |
| `byCategory(category)` | `Promise<CLIScanResult[]>` | Get CLIs by category (scans first). |
| `categories()` | `string[]` | Get all unique categories. |
| `has(binaryName)` | `boolean` | Check if a binary is registered (not whether installed). |
| `get(binaryName)` | `CLIDescriptor \| undefined` | Get a descriptor by binary name. |
| `size` | `number` | Total number of registered descriptors. |

### CLIScanResult

The result from `scan()` or `check()` extends [`CLIDescriptor`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/types.ts):

```typescript
interface CLIScanResult extends CLIDescriptor {
  installed: boolean;         // whether the binary was found on PATH
  binaryPath?: string;        // resolved absolute path (e.g. /usr/local/bin/node)
  version?: string;           // parsed version string (e.g. "22.4.0")
}
```

## Adding Custom CLIs

### Option 1: Contribute a descriptor

A descriptor that belongs in every install goes into AgentOS itself: add an entry to a category file, or a new `*.json` file, in `src/safety/sandbox/subprocess/registry/`. The build ships those files in `dist/`, and the registry loads every `*.json` in that folder:

```json
[
  {
    "binaryName": "my-tool",
    "displayName": "My Tool",
    "description": "Internal deployment CLI",
    "category": "devtools",
    "installGuidance": "brew install my-tool"
  }
]
```

### Option 2: Register at runtime (dynamic)

```typescript
const registry = new CLIRegistry();

registry.register({
  binaryName: 'my-tool',
  displayName: 'My Tool',
  description: 'Internal deployment CLI',
  category: 'devtools',
  installGuidance: 'brew install my-tool',
});

const result = await registry.check('my-tool');
if (result.installed) {
  console.log(`my-tool v${result.version} at ${result.binaryPath}`);
}
```

### Option 3: Full scan with custom CLIs

```typescript
const registry = new CLIRegistry();

// Add several custom CLIs
registry.registerAll([
  { binaryName: 'tsc', displayName: 'TypeScript', description: 'TS compiler', category: 'devtools', installGuidance: 'npm i -g typescript' },
  { binaryName: 'eslint', displayName: 'ESLint', description: 'JS linter', category: 'devtools', installGuidance: 'npm i -g eslint' },
]);

// Scan everything (bundled + custom)
const results = await registry.scan();
for (const r of results) {
  const status = r.installed ? `v${r.version}` : 'not installed';
  console.log(`${r.displayName.padEnd(24)} ${status}`);
}

// Filter by category
const llmClis = await registry.byCategory('llm');
console.log(`LLM CLIs found: ${llmClis.filter(c => c.installed).length}/${llmClis.length}`);
```

## Integration with CLISubprocessBridge

The [`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts) is an abstract base class for managing CLI subprocesses. It handles spawning, stdin piping, NDJSON stream parsing, timeouts, and abort signals. Subclasses implement CLI-specific flag assembly and error classification.

Two production bridges extend it:

| Bridge | Binary | Purpose |
|--------|--------|---------|
| [`ClaudeCodeCLIBridge`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/ClaudeCodeCLIBridge.ts) | `claude` | Anthropic Claude via Max subscription (no API key needed) |
| [`GeminiCLIBridge`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/GeminiCLIBridge.ts) | `gemini` | Google Gemini via Google account login (no API key needed) |

The `claude-code-cli` and `gemini-cli` providers call their bridge's `checkBinaryInstalled()` (`which`, then `--version`) when they initialize, and `initialize()` throws `BINARY_NOT_FOUND` when the binary is missing ([CLI Error Codes](./CLI_ERROR_CODES.md)).

### Creating a custom bridge

```typescript
import { CLISubprocessBridge } from '@framers/agentos/sandbox/subprocess';
import { CLISubprocessError, CLI_ERROR } from '@framers/agentos/sandbox/subprocess';

class MyToolBridge extends CLISubprocessBridge {
  protected readonly binaryName = 'mytool';

  protected buildArgs(options, format) {
    return ['--prompt', options.prompt, '--format', format];
  }

  protected classifyError(error) {
    if (error.code === 'ENOENT') {
      return new CLISubprocessError(
        'mytool not found',
        CLI_ERROR.BINARY_NOT_FOUND,
        'mytool',
        'Install: brew install mytool',
        false,
      );
    }
    return new CLISubprocessError(
      error.message,
      CLI_ERROR.CRASHED,
      'mytool',
      'Check mytool logs',
      true,
    );
  }

  protected parseStreamEvent(raw) {
    if (raw.text) return { type: 'text_delta', text: raw.text };
    if (raw.done) return { type: 'result', result: raw.output };
    return null;
  }
}
```

## Integration with cli-executor Extension

The `cli-executor` extension pack (`@framers/agentos-ext-cli-executor`) provides tools that let agents execute arbitrary shell commands on the host. While it does not import [`CLIRegistry`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLIRegistry.ts) directly, the two systems are complementary:

- **CLIRegistry** answers "what binaries exist?" -- discovery and detection.
- **cli-executor** answers "can the agent run this command?" -- execution with security guardrails.

The cli-executor pack takes its policy from its options: `filesystem` (read and write roots), its own command checks, and `dangerouslySkipSecurityChecks`. The host that loads the pack sets them.

## Security Considerations

The CLI Registry runs nothing beyond `which` and each binary's version flag. It applies no security policy, and neither does the rest of AgentOS for CLI execution: `SecurityTier` (`'dangerous' | 'permissive' | 'balanced' | 'strict' | 'paranoid'`) is a type AgentOS declares and does not enforce. Which commands an agent may run, and where it may write, is set by the host through the cli-executor pack's options.

## Error Handling

The [`CLISubprocessError`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/errors.ts) class provides structured errors with actionable guidance:

```typescript
import { CLISubprocessError, CLI_ERROR } from '@framers/agentos/sandbox/subprocess';

// Common error codes:
CLI_ERROR.BINARY_NOT_FOUND   // Binary not found on PATH
CLI_ERROR.NOT_AUTHENTICATED  // Binary installed but not logged in
CLI_ERROR.VERSION_OUTDATED   // Version too old for required features
CLI_ERROR.SPAWN_FAILED       // Process failed to start
CLI_ERROR.TIMEOUT            // Process exceeded timeout
CLI_ERROR.CRASHED            // Non-zero exit code
CLI_ERROR.RATE_LIMITED       // Rate limit / quota exceeded
CLI_ERROR.PERMISSION_DENIED  // EACCES
CLI_ERROR.CONTEXT_TOO_LONG   // Input too long for the CLI
```

Each error carries a `guidance` string with fix instructions and a `recoverable` flag, both set by the code that builds the error. [CLI Error Codes](./CLI_ERROR_CODES.md) lists which of these codes the Claude Code and Gemini CLI bridges raise and when, and what AgentOS does with the error.

## Exports

Everything is exported from the barrel at `@framers/agentos/sandbox/subprocess`:

```typescript
export { CLISubprocessBridge } from './CLISubprocessBridge';
export { CLIRegistry, WELL_KNOWN_CLIS } from './CLIRegistry';
export { CLISubprocessError, CLI_ERROR } from './errors';
export type {
  BridgeOptions,
  BridgeResult,
  StreamEvent,
  OutputFormat,
  InstallCheckResult,
  CLIDescriptor,
  CLIScanResult,
} from './types';
```

## Troubleshooting

### CLI not detected

The registry reports a binary as not installed when `which <binary>` fails during `scan()` or `check()`.

**Common causes:**
- **Binary not installed.** Follow the `installGuidance` field from the descriptor. Run the install command, then re-scan.
- **PATH does not include the binary's directory.** GUI-launched processes (IDEs, Electron apps) may inherit a different PATH than your terminal. Verify with `echo $PATH` and add the directory to your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.profile`).
- **Binary has an unexpected name.** Some CLIs differ across platforms — `python` vs `python3`, `docker-compose` (v1) vs `docker compose` (v2 plugin). The registry tracks specific binary names; check the `binaryName` field.
**Fix:** Install the binary, ensure its directory is on PATH, or register a custom descriptor with the correct `binaryName`.

### Version shows "unknown"

The binary was found on PATH (`installed: true`) but the version string could not be parsed.

**Common causes:**
- The binary's version output does not match the default regex `/(\d+\.\d+\.\d+)/`. For example, a CLI that outputs `v2.1` (two segments) or `Build 20240315` (no semver) will not match.
- The version output goes to stderr instead of stdout.
- The version flag fails (some CLIs use `-v`, `-V`, or `version` instead of `--version`): the binary still reads as installed, with version `unknown`. Provide a custom `versionFlag` in the descriptor.

**Fix:** Register the CLI with a custom `versionPattern` regex that matches its actual output format:

```typescript
registry.register({
  binaryName: 'my-tool',
  displayName: 'My Tool',
  description: 'Custom tool',
  category: 'devtools',
  installGuidance: 'brew install my-tool',
  versionPattern: /v?(\d+\.\d+)/,  // match two-segment versions
});
```

### Custom CLI not persisted

Runtime registrations via `registry.register()` or `registry.registerAll()` are **per-process only**. They do not survive process restarts.

**Fix:** Register your descriptors each time the process starts, or contribute them to AgentOS (`src/safety/sandbox/subprocess/registry/`): the [`CLIRegistry`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLIRegistry.ts) constructor loads every `*.json` file the package ships in that folder.

### scan() is slow

The `scan()` method runs `which` + `--version` for every registered descriptor. With 54+ CLIs, this involves 100+ subprocess spawns.

**Common causes:**
- **Network-attached PATH entries.** If PATH includes NFS or CIFS mounts, each `which` call may incur network latency. Remove network paths from PATH or move them to the end.
- **Slow binary startup.** Some CLIs (e.g., Java, `gcloud`) have slow startup times for `--version`. The registry runs all checks in parallel, but a single slow binary can delay the overall result.
- **Antivirus scanning.** On Windows, real-time antivirus may scan each spawned subprocess, adding per-binary overhead.

**Fix:** The registry already runs checks in parallel. To reduce scan time further, use `check(binaryName)` for specific binaries instead of `scan()` for all, or use `byCategory(category)` to scan only the categories you need.

## Complete CLI Reference

All 54 bundled CLI descriptors, organized by category. Data sourced from `src/safety/sandbox/subprocess/registry/*.json`.

### LLM (5)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 1 | `claude` | Claude Code | llm | `npm install -g @anthropic-ai/claude-code` |
| 2 | `gemini` | Gemini CLI | llm | `npm install -g @google/gemini-cli` |
| 3 | `ollama` | Ollama | llm | https://ollama.com/download |
| 4 | `lmstudio` | LM Studio CLI | llm | https://lmstudio.ai/ |
| 5 | `aichat` | AIChat | llm | `cargo install aichat` or `brew install aichat` |

### Dev Tools (10)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 6 | `git` | Git | devtools | https://git-scm.com/downloads |
| 7 | `gh` | GitHub CLI | devtools | https://cli.github.com/ |
| 8 | `docker` | Docker | devtools | https://docs.docker.com/get-docker/ |
| 9 | `docker-compose` | Docker Compose | devtools | Included with Docker Desktop or `pip install docker-compose` |
| 10 | `kubectl` | kubectl | devtools | https://kubernetes.io/docs/tasks/tools/ |
| 11 | `terraform` | Terraform | devtools | https://developer.hashicorp.com/terraform/install |
| 12 | `make` | Make | devtools | Pre-installed on macOS/Linux; Windows: `choco install make` |
| 13 | `jq` | jq | devtools | `brew install jq` or `apt install jq` |
| 14 | `yq` | yq | devtools | `brew install yq` or `pip install yq` |
| 15 | `tmux` | tmux | devtools | `brew install tmux` or `apt install tmux` |

### Runtimes (8)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 16 | `node` | Node.js | runtime | https://nodejs.org/ |
| 17 | `python3` | Python 3 | runtime | https://www.python.org/downloads/ |
| 18 | `deno` | Deno | runtime | `curl -fsSL https://deno.land/install.sh \| sh` |
| 19 | `bun` | Bun | runtime | `curl -fsSL https://bun.sh/install \| bash` |
| 20 | `ruby` | Ruby | runtime | https://www.ruby-lang.org/en/documentation/installation/ |
| 21 | `go` | Go | runtime | https://go.dev/doc/install |
| 22 | `rustc` | Rust | runtime | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| 23 | `java` | Java | runtime | https://adoptium.net/ or `brew install openjdk` |

### Package Managers (7)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 24 | `npm` | npm | package-manager | Installed with Node.js |
| 25 | `pnpm` | pnpm | package-manager | `npm install -g pnpm` or `corepack enable` |
| 26 | `yarn` | Yarn | package-manager | `npm install -g yarn` or `corepack enable` |
| 27 | `pip` | pip | package-manager | Installed with Python: `python3 -m ensurepip` |
| 28 | `uv` | uv | package-manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| 29 | `brew` | Homebrew | package-manager | https://brew.sh/ |
| 30 | `cargo` | Cargo | package-manager | Installed with Rust: https://rustup.rs/ |

### Cloud (9)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 31 | `gcloud` | Google Cloud SDK | cloud | https://cloud.google.com/sdk/docs/install |
| 32 | `aws` | AWS CLI | cloud | https://aws.amazon.com/cli/ |
| 33 | `az` | Azure CLI | cloud | https://learn.microsoft.com/en-us/cli/azure/install-azure-cli |
| 34 | `flyctl` | Fly.io CLI | cloud | `curl -L https://fly.io/install.sh \| sh` |
| 35 | `vercel` | Vercel CLI | cloud | `npm install -g vercel` |
| 36 | `netlify` | Netlify CLI | cloud | `npm install -g netlify-cli` |
| 37 | `railway` | Railway CLI | cloud | `npm install -g @railway/cli` |
| 38 | `heroku` | Heroku CLI | cloud | https://devcenter.heroku.com/articles/heroku-cli |
| 39 | `wrangler` | Cloudflare Wrangler | cloud | `npm install -g wrangler` |

### Databases (5)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 40 | `psql` | PostgreSQL | database | `brew install postgresql` or `apt install postgresql-client` |
| 41 | `mysql` | MySQL | database | `brew install mysql-client` or `apt install mysql-client` |
| 42 | `sqlite3` | SQLite | database | Pre-installed on macOS; `apt install sqlite3` |
| 43 | `redis-cli` | Redis CLI | database | `brew install redis` or `apt install redis-tools` |
| 44 | `mongosh` | MongoDB Shell | database | `brew install mongosh` or `npm install -g mongosh` |

### Media (5)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 45 | `ffmpeg` | FFmpeg | media | https://ffmpeg.org/download.html |
| 46 | `ffprobe` | FFprobe | media | Installed with FFmpeg |
| 47 | `magick` | ImageMagick | media | `brew install imagemagick` or `apt install imagemagick` |
| 48 | `sox` | SoX | media | `brew install sox` or `apt install sox` |
| 49 | `yt-dlp` | yt-dlp | media | `brew install yt-dlp` or `pip install yt-dlp` |

### Networking (5)

| # | Binary | Display Name | Category | Install |
|---|--------|-------------|----------|---------|
| 50 | `curl` | cURL | networking | Pre-installed on macOS/Linux |
| 51 | `wget` | Wget | networking | `brew install wget` or `apt install wget` |
| 52 | `ssh` | SSH | networking | Pre-installed on macOS/Linux |
| 53 | `rsync` | rsync | networking | Pre-installed on macOS; `apt install rsync` |
| 54 | `scp` | SCP | networking | Pre-installed with SSH |
