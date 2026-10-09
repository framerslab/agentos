# AgentOS Extension Standards

## Status

This page began as a December 2024 proposal. The extensions repository adopted a different layout from the one it proposed (a `packages/ext-{name}` folder per pack, MIT licensing, CI and a marketplace for community repositories); what follows is the standard the repository and the runtime follow. The contribution process itself lives in the extensions repository's [CONTRIBUTING.md](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md).

## Summary

An extension pack is an npm package whose factory returns an [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts): a name, a version and a list of descriptors (tools, guardrails, workflows and the other extension kinds). [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts) loads the packs named in `AgentOSConfig.extensionManifest` and registers their descriptors.

## Terminology

- **Extension**: one descriptor in a pack (a tool, a guardrail, a workflow, a channel adapter, and so on).
- **Extension pack**: a package of related extensions distributed together.
- **Registry**: `registry.json`, the index of the curated packs, shipped by the root package `@framers/agentos-extensions`.

## Repository Structure

The curated packs live in [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions), one workspace package per pack under a category folder:

```
agentos-extensions/
├── registry/curated/
│   ├── research/web-search/      # @framers/agentos-ext-web-search
│   ├── channels/telegram/        # @framers/agentos-ext-telegram
│   └── ...                       # auth, cloud, media, memory, safety, voice, ...
├── templates/                    # basic-tool, guardrail, multi-tool
├── registry.json                 # rewritten from the packs on disk by the build
└── CONTRIBUTING.md
```

Everything in the repository is licensed under Apache-2.0.

## Extension Package Structure

```
registry/curated/<category>/<name>/
├── src/
│   ├── index.ts           # exports createExtensionPack(context)
│   └── tools/             # one file per tool
├── test/
├── README.md              # with an example
├── manifest.json          # describes the pack
├── package.json           # name @framers/agentos-ext-<name>, license Apache-2.0
└── tsconfig.json
```

A new pack starts as a copy of `templates/basic-tool`. The pack's `package.json` sets `"publishConfig": { "access": "public" }` and carries no LICENSE file of its own: the repository's LICENSE applies.

### Package Naming

- npm name: `@framers/agentos-ext-{name}`
- Folder: `registry/curated/{category}/{name}`
- Manifest id (the template's convention): `com.framers.ext.{name}`

### Manifest

`manifest.json` describes the pack for the registry: its id, name, version, description, categories, the extensions it contains and their entry files, and its configuration properties (a property marked `"secret": true` holds a credential). The template's manifest is the reference shape.

## Extension Implementation

### A tool

A tool implements [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts): `id`, `name`, `displayName`, `description`, `inputSchema` and `execute(args, context)`, with optional `outputSchema`, `category`, `version`, `hasSideEffects` and `requiredCapabilities`. The tool's configuration comes from the pack factory, not from the execution context, which carries the GMI, persona and user identifiers, the session data and an abort signal.

```typescript
// src/tools/webSearch.ts
import type { ITool, ToolExecutionContext, ToolExecutionResult, JSONSchemaObject } from '@framers/agentos';

export interface WebSearchConfig {
  provider: 'serper' | 'brave';
  apiKey?: string;
}

export class WebSearchTool implements ITool<{ query: string; maxResults?: number }> {
  readonly id = 'com.framers.ext.search.webSearch';
  readonly name = 'webSearch';
  readonly displayName = 'Web Search';
  readonly description = 'Search the web for information using the configured search API';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
    required: ['query'],
  };

  constructor(private config: WebSearchConfig) {}

  setApiKey(apiKey: string): void {
    this.config = { ...this.config, apiKey };
  }

  async execute(
    input: { query: string; maxResults?: number },
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.config.apiKey) {
      return { success: false, error: 'Search API key not configured' };
    }
    try {
      const results = await this.performSearch(input.query, input.maxResults ?? 5, context.signal);
      return { success: true, output: { results } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  }

  private async performSearch(query: string, maxResults: number, signal?: AbortSignal) {
    // Provider-specific implementation
    return [] as Array<{ title: string; snippet: string; url: string }>;
  }
}
```

### The pack factory

`createExtensionPack(context)` receives an [`ExtensionPackContext`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts): the manifest entry, its `options`, a `logger`, `getSecret(id)` and the shared `services`. `ExtensionManager` calls the module's `createExtensionPack` export, or its default export.

```typescript
// src/index.ts
import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { WebSearchTool } from './tools/webSearch';

export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const options = (context.options ?? {}) as { provider?: 'serper' | 'brave' };
  const tool = new WebSearchTool({ provider: options.provider ?? 'serper' });

  return {
    name: '@framers/agentos-ext-search',
    version: '1.0.0',
    descriptors: [
      {
        id: 'webSearch',
        kind: 'tool',
        payload: tool,
        priority: 10,
        enableByDefault: true,
        requiredSecrets: [{ id: 'serper.apiKey' }],
        metadata: { category: 'research' },
        onActivate: async (ctx) => {
          const apiKey = ctx.getSecret?.('serper.apiKey');
          if (apiKey) tool.setApiKey(apiKey);
        },
      },
    ],
  };
}

export default createExtensionPack;
```

`getSecret(id)` reads `AgentOSConfig.extensionSecrets[id]` first, then the environment variable the secret catalog maps to that id.

### Loading a pack

```typescript
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      { package: '@framers/agentos-ext-search', options: { provider: 'serper' } },
      // or { module: './local-pack.js' }, or { factory: () => createExtensionPack({}) }
    ],
  },
  extensionSecrets: { 'serper.apiKey': process.env.SERPER_API_KEY! },
});

const tool = await agentos.getToolOrchestrator().getTool('webSearch');
```

## Testing

Each pack keeps its own tests and runs them with `pnpm test` in its folder. The repository's CI builds every pack, runs each pack's tests, and runs the pack guard: it packs every package the next release would publish, installs the tarball into an empty project and imports it with network access refused, so a pack must construct with inert inputs and return its descriptors. An integration test loads the pack through `extensionManifest` as above and calls the tool through the tool orchestrator.

## Documentation

Each pack has a README with installation, configuration (its options and secrets) and an example.

## Publishing

Packs are released with changesets (`pnpm changeset`: `patch` for a fix, `minor` for a new tool or export, `major` for a breaking change); the release workflow publishes each changed pack to npm. The [release guide](https://github.com/framerslab/agentos-extensions/blob/master/RELEASING.md) has the details.

## Security

- A pack runs in the host process with the host's permissions: AgentOS does not sandbox a pack's code, restrict its file system or network access, or limit its resources. Install packs you trust.
- Never hardcode credentials: declare them as `requiredSecrets` and read them with `getSecret()`. A descriptor whose required secret (one not marked `optional`) is missing is skipped with a warning.
- Mark credential properties in `manifest.json` with `"secret": true`.

## References

- [AgentOS Architecture](../architecture/ARCHITECTURE.md)
- [ITool Interface](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts)
- [ExtensionManager](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts)
- [agentos-extensions](https://github.com/framerslab/agentos-extensions) and its [CONTRIBUTING.md](https://github.com/framerslab/agentos-extensions/blob/master/CONTRIBUTING.md)
