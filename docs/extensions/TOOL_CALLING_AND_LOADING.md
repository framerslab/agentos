# Tool Calling & Lazy Loading

This guide explains how AgentOS wires **extensions (tools)** and **skills (prompt modules)** into a tool-calling agent loop, and what “lazy loading” means in practice.

## Tool Calling Loop (Runtime)

At a high level, each turn looks like:

```mermaid
sequenceDiagram
  participant U as User
  participant G as GMI
  participant P as LLM Provider
  participant O as ToolOrchestrator
  participant E as ToolExecutor
  participant T as Tool

  U->>G: user message
  G->>O: listAvailableTools(persona,user)
  O-->>G: tool schemas (OpenAI-style)
  G->>P: completion(prompt + tool schemas)
  P-->>G: assistant text and/or tool_calls
  alt tool_calls present
    G->>O: processToolCall(tool_call)
    O->>E: executeTool(request)
    E->>T: tool.execute(args, ctx)
    T-->>E: ToolExecutionResult
    E-->>O: ToolCallResult
    O-->>G: ToolCallResult
    G->>P: follow-up completion (with tool result messages)
  end
  P-->>G: final assistant text
```

Key implementation points:

- `ToolOrchestrator.listAvailableTools()` returns the tool schemas the model can call this turn.
- `ToolOrchestrator.processToolCall()` enforces permissions and delegates execution to [`ToolExecutor`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolExecutor.ts).
- [`ToolExecutor`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolExecutor.ts) resolves tools from the tool [`ExtensionRegistry`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionRegistry.ts) by tool-call name (`ITool.name`).

## Extensions: How Tools Load

AgentOS loads extension packs from `extensionManifest.packs` via `ExtensionManager.loadManifest()` and registers descriptors into kind-specific registries.

```mermaid
graph TD
  M[ExtensionManifest] --> EM[ExtensionManager.loadManifest]
  EM --> RP[Resolve Pack (factory/package/module)]
  RP --> P[ExtensionPack]
  P --> D[Descriptors]
  D --> R[ExtensionRegistry (by kind)]
  R --> TE[ToolExecutor (tool registry)]
  TE --> TO[ToolOrchestrator]
```

### Pack Resolution Modes

AgentOS supports three ways to resolve a pack entry:

1. `factory`: inline factory returning an [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts)
2. `package`: dynamic `import()` of an npm package exporting `createExtensionPack()`
3. `module`: dynamic `import()` of a local module path exporting `createExtensionPack()`

### Descriptor IDs For Tools

Tool calling uses the OpenAI-style tool `name`, which maps to `ITool.name`.

For tool descriptors, keep:

- `descriptor.id === tool.name`

## Secrets & Required Secrets

Descriptors can declare `requiredSecrets`. AgentOS resolves secrets from:

1. explicit `extensionSecrets` (host-provided), plus
2. `packs[].options.secrets` (if provided), plus
3. environment variables mapped via the extension secrets catalog (`extension-secrets.json`)

If a descriptor declares a non-optional secret and it can’t be resolved, it’s skipped.

## Skills: Prompt Modules + Optional Tooling

Skills are prompt modules loaded from `SKILL.md` files. Hosts can inject skills into a system prompt via `SkillRegistry.buildSnapshot()`.

For “lazy” skills, the `@framers/agentos-ext-skills` extension pack gives the model tools (`skills_list`, `skills_read` and the rest) that fetch `SKILL.md` content on demand instead of pre-injecting everything; [`SkillRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts) from `@framers/agentos/cognition/skills` loads the skills and builds the snapshot. Curated skill content ships in `@framers/agentos-skills`.

## What “Lazy Loading” Means Here

AgentOS supports a few different “lazy” patterns:

- Lazy optional dependencies: registry helpers can `tryImport()` optional extension packages and skip those not installed.
- Lazy pack import: `package`/`module` entries are imported when `loadManifest()` runs.
- Lazy tool implementation: a tool’s `execute()` can dynamically `import()` heavy dependencies on first call.

### Schema-On-Demand Tool Schemas (Optional)

Tool calling requires schemas **up front for each round**. The **schema-on-demand pattern** works around that with optional meta tools that load extension packs at runtime.

When enabled, AgentOS registers these meta tools:

- `extensions_list` — list loaded packs + curated catalog (if installed)
- `extensions_enable` — load an extension pack at runtime (side effects, HITL recommended)
- `extensions_status` — show packs loaded in this process

Because the GMI loop calls `ToolOrchestrator.listAvailableTools()` on every iteration, any tools added by `extensions_enable` appear in the **next** LLM call’s tool schemas automatically.

```mermaid
sequenceDiagram
  participant U as User
  participant G as GMI
  participant P as LLM Provider
  participant O as ToolOrchestrator
  participant EM as ExtensionManager

  U->>G: user message
  G->>O: listAvailableTools()
  O-->>G: meta tool schemas only
  G->>P: completion(meta tools)
  P-->>G: tool_call extensions_enable(...)
  G->>O: processToolCall(extensions_enable)
  O-->>EM: loadPackFromPackage/module(...)
  EM-->>O: new tool descriptors registered
  G->>O: listAvailableTools()
  O-->>G: meta tools + newly enabled tool schemas
  G->>P: completion(updated tools)
```

#### How To Enable In AgentOS

In [`AgentOSConfig`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), set:

```ts
schemaOnDemandTools: {
  enabled: true,
  // Recommended for production: allow curated names only (no arbitrary package imports).
  // Default: true in non-production, false in production.
  allowPackages: false,
  // Default: false (prefer curated packages).
  allowModules: false,
  // Default: true. When enabled, `extensions_enable` only loads packs present in
  // the installed @framers/agentos-extensions-registry catalog.
  officialRegistryOnly: true,
}
```

Then start your agent with a minimal `extensionManifest` (or selectively-loaded packs), and let the model call `extensions_enable` as needed.
