# Defining and loading personas

A persona is the definition a GMI is built from: who the agent is, how it speaks, which model it prefers, which tools it may use, how its sentiment tracking and metaprompts behave. The runtime loads persona definitions once at start, validates them, and serves them to sessions by id. This page shows the definition's shape and the three ways to load one: a directory of JSON files, an inline list of objects, or a loader you write.

## The definition

A definition is an [`IPersonaDefinition`](../src/cognition/substrate/personas/IPersonaDefinition.ts). Five fields must be present and non-empty; everything else is optional.

```json
{
  "id": "support_agent",
  "name": "Support Agent",
  "description": "Answers product questions from the docs and escalates billing issues.",
  "version": "1.0.0",
  "baseSystemPrompt": "You are the support agent for Acme. Answer from the documentation; escalate billing to a human."
}
```

- `id`: unique across the loaded set. `system_admin` and `internal_default` are reserved.
- `version`: `major.minor.patch`, optionally with a pre-release suffix (`1.2.0-beta.1`); build metadata (`1.0.0+build`) is rejected.
- `baseSystemPrompt`: a string, a `{ "template": "...", "variables": ["name"] }` object, or an ordered array of `{ "content": "...", "priority": 1 }` fragments.
- `activationKeywords`, when present, must be an array of strings.
- `conversationContextConfig.maxMessages` sets the GMI's conversation-history window (20 messages by default).
- `reasoningTraceConfig.maxEntries` and `reasoningTraceConfig.maxMessageLength` set the reasoning trace's size (500 entries and 1000 characters per message by default; the runtime's `defaultReasoningTraceMaxEntries` and `defaultReasoningTraceMaxMessageLength` in `gmiManagerConfig.defaultGMIBaseConfigDefaults` set the defaults for every persona). A value that is not a positive integer is ignored and the next source applies; `maxEntries` below 20 is raised to 20, the window the self-reflection metaprompt reads; values above the ceilings (5,000 entries, 20,000 characters) are clamped. Every such setting, from the persona or the runtime, is recorded as a warning entry in the GMI's trace at initialization; persona values are also reported by validation (an unknown key is a warning, a non-object `reasoningTraceConfig` is an error that blocks the persona under strict validation). `SOUL.md` carries the same limits under `reasoningTrace` in its frontmatter.
- `sentimentTracking: { "enabled": true, "presets": ["frustration_recovery", "confusion_clarification"] }` (or `["all"]`) expands into the matching recovery metaprompts on load, from every source alike. The preset names are `frustration_recovery`, `confusion_clarification`, `satisfaction_reinforcement`, `error_recovery` and `engagement_boost`.

The package ships five definitions as JSON: `atlas_systems_architect`, `default_assistant_persona`, `default_free_assistant`, `nerf_generalist` and `v_researcher`, exported as `BUILT_IN_PERSONAS` with `getBuiltInPersona(id)`.

## Loading from a directory of JSON files (the default)

`AgentOS.create()` reads `./personas` with the file-system loader, one definition per `.json` file.

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create(); // reads ./personas/*.json
```

Options live under `gmiManagerConfig.personaLoaderConfig`: `personaSource` (the directory; `personaDefinitionPath` is accepted too), `fileExtension` (default `.json`), `recursiveSearch` (default `false`). A missing directory is a warning and zero personas, not an error. A file missing `id`, `name`, `version` or `baseSystemPrompt` is skipped with a warning; a duplicate id overwrites the earlier one with a warning.

## Loading inline: JSON objects or code

Pass the definitions as an array. A parsed JSON file is such an object; code builds the same objects.

```ts
import { readFile } from 'node:fs/promises';
import { AgentOS, BUILT_IN_PERSONAS } from '@framers/agentos';

// The package's own personas:
const agentos = await AgentOS.create({ personas: BUILT_IN_PERSONAS });

// One definition per file, parsed by you:
const fromFile = await AgentOS.create({
  personas: [JSON.parse(await readFile('./personas/support_agent.json', 'utf8'))],
});

// Built in code:
const fromCode = await AgentOS.create({
  personas: [{
    id: 'support_agent', name: 'Support Agent', version: '1.0.0',
    description: 'Answers product questions from the docs.',
    baseSystemPrompt: 'You are the support agent for Acme.',
  }],
});
```

`personas` replaces the file-system source: when it is set, no directory is read. The list is checked before any subsystem starts; `create()` rejects with `CONFIGURATION_ERROR` naming the index or id when the value is not an array, an entry lacks a string `id`, an id repeats, or `activationKeywords` is not an array. `personas` and `personaLoader` cannot both be set.

## Loading from anywhere: write a loader

A loader is an object with three methods (and an optional `refreshPersonas`). Use it to read a database, an HTTP service, or to combine sources.

```ts
import { AgentOS, type IPersonaLoader, type IPersonaDefinition } from '@framers/agentos';

class DatabasePersonaLoader implements IPersonaLoader {
  async initialize() {}
  async loadPersonaById(id: string): Promise<IPersonaDefinition | undefined> {
    return db.personas.findById(id);
  }
  async loadAllPersonaDefinitions(): Promise<IPersonaDefinition[]> {
    return db.personas.findAll();
  }
}

const agentos = await AgentOS.create({ personaLoader: new DatabasePersonaLoader() });
```

`InMemoryPersonaLoader` and the file-system `PersonaLoader` are exported for composition. Apply `normalizePersonaDefinition()` to definitions your loader returns so sentiment presets expand the way the built-in loaders expand them.

## Validation and strict mode

Every loaded set goes through `validatePersonas` in `GMIManager`: required fields, the version pattern, reserved ids, prompt length (a warning above 4000 characters or about 2000 tokens), tool references against the registered tools, duplicate activation keywords across personas. Problems are logged. With `gmiManagerConfig.personaValidationStrict: { enabled: true }`, a persona with errors is blocked at activation (`mode: 'load_block'` also hides it from listings); `shadowMode: true` logs what strict mode would block without enforcing it.

## Where things live

| What | Where |
|---|---|
| Definition type | `src/cognition/substrate/personas/IPersonaDefinition.ts` |
| Loader contract | `src/cognition/substrate/personas/IPersonaLoader.ts` |
| File-system loader | `src/cognition/substrate/personas/PersonaLoader.ts` |
| In-memory loader and the inline rules | `src/cognition/substrate/personas/InMemoryPersonaLoader.ts` |
| Shared normalization | `src/cognition/substrate/personas/personaNormalization.ts` |
| Source resolution for a runtime | `src/api/runtime/personaLoaderResolution.ts` |
| Validation | `src/cognition/substrate/personas/PersonaValidation.ts` |
| Built-in definitions | `src/cognition/substrate/personas/definitions/` |
