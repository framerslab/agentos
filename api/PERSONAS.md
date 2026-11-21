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
- `defaultModelId` and `defaultProviderId` name the model the GMI calls, unless a request picks another model with `options.preferredModelId`. The GMI takes the model and the provider each from the first of three levels that names it: the request (`options.preferredModelId`, `options.preferredProviderId`), the persona, then `gmiManagerConfig.defaultGMIBaseConfigDefaults`. A provider named at a more specific level than the model runs on that provider's own default model: a persona with `defaultProviderId: 'minimax'` and no `defaultModelId` calls MiniMax's default model, never the runtime's default model of another provider, and so does a request that names a provider and no model. A model named beside the same provider is kept, so a request that repeats the persona's provider keeps the persona's model. With neither a model nor a provider named at any level, the call runs on the default provider's default model. `defaultModelCompletionOptions` sets the completion options of every model call (`temperature`, `maxTokens`, `topP`, `stopSequences`, `thinking`, `effort` and the other keys listed under [Completion options](./GMI.md#completion-options)); a request's options replace them key by key for its turn.
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

`personas` replaces the file-system source: when it is set, no directory is read. The list is checked before any subsystem starts; `create()` rejects with the code `SYS_CONFIGURATION_ERROR` when the value is not an array, an entry is not an object with a string `id` that is not blank (empty or whitespace only), an id repeats, or one of two optional fields is present with the wrong shape: `activationKeywords` must be an array of strings and `sentimentTracking.presets` an array. The refusal of an entry names its index, and its id where that id is a string that is not blank; the refusal of a value that is not an array gives the type it received in its details. `personas` and `personaLoader` cannot both be set.

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

`InMemoryPersonaLoader` and the file-system `PersonaLoader` are exported for composition. `GMIManager` runs `normalizePersonaDefinition()` on every definition a loader returns, yours included, so sentiment presets expand and `null` memory settings drop the way the built-in loaders do; a definition that needs neither is stored as the same object. A `sentimentTracking.presets` that is not an array (`null` included) merges no presets and is reported as `invalid_sentiment_presets`. A `metaPrompts` that is not an array is reported as `invalid_metaprompts` whether or not presets replace it: when presets are merged, the stored persona holds only the preset metaprompts, in their usual order, and the issue names the shape the persona was supplied with; otherwise the value is kept as loaded. Either way `personaValidationStrict.blockOnCodes: ['invalid_metaprompts']` blocks the persona. The record of a replaced `metaPrompts` rides on the definition object itself, so a loader that wraps another (an `InMemoryPersonaLoader`, the file-system `PersonaLoader`, or your own) must pass the definitions it gets back unchanged or copy each one with `clonePersonaDefinition()`. A spread (`(await inner.loadAllPersonaDefinitions()).map((p) => ({ ...p }))`) or a JSON round trip drops the record: the persona then loads with only the preset metaprompts and no `invalid_metaprompts` issue, so strict mode cannot block it. A definition the normalizer cannot read is skipped with a warning, so one bad definition never stops the others from loading or being validated.

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

## Notetaker traits and writing

`NOTETAKER_PERSONA` is a frozen map of authored HEXACO scores, not an `IPersonaDefinition`. Import it and the renderer from the public substrate entry:

```ts
import {
  NOTETAKER_PERSONA,
  renderPersonalitySection,
  type TraitBand,
  type PersonalityRegister,
} from '@framers/agentos/cognition/substrate';

const rigour: TraitBand = 'low';
const register: PersonalityRegister = 'writing';
const section = renderPersonalitySection(NOTETAKER_PERSONA, {
  bands: { conscientiousness: rigour },
  register,
});
```

| Trait | Score | Default band |
|---|---|---|
| honesty | 0.8 | high |
| emotionality | 0.25 | low |
| extraversion | 0.3 | low |
| agreeableness | 0.55 | moderate |
| conscientiousness | 0.85 | high |
| openness | 0.5 | moderate |

The `conversation` register is the default and preserves the existing directives. The `writing` register starts its rendered directives with the rule that style changes presentation only. A `register` other than these two throws a `TypeError` rather than rendering the conversation directives without that rule. A band may change length, order, tone or how stated open points are presented; it may not introduce content, facts or suggestions absent from the material. A prompt directive is not a guarantee that a model will comply. Hosts still validate generated content against their source material and their task's requirements.

The preset's writing section is:

```text
## Personality & Communication Style

Change only how grounded material is presented: its length, order, tone and stated open points; never change its meaning or introduce content, suggestions or facts absent from the material.
State what was said and what is certain; mark what is inferred; no flattery and no softening
Write plainly; no exclamation, no reassurance, no alarm
Keep to the material; add nothing the speakers did not say
Structure the text; complete lists; exact names, numbers and times as given
```

`bands` overrides the rendered band of each supplied trait; other traits use their scores. A moderate trait contributes no line. Low conscientiousness contributes a brief-writing directive, so it does not remove the trait's line. Setting conscientiousness to moderate removes that line. An entirely moderate trait map returns null in either register. The notetaker's authored honesty and emotionality keep its section present even when its other four bands are moderate.

The public entry exports all nine required names: `NOTETAKER_PERSONA`, `renderPersonalitySection`, `TraitBand`, `OPERATOR_ONLY_TRAITS`, `HEXACO_TRAIT_KEYS`, `normalizeHexacoTraits`, `bandOf`, `HexacoTraitKey` and `IPersonaDefinition`. It also exports `PersonalityRegister`. Import the four type-only names, `TraitBand`, `PersonalityRegister`, `HexacoTraitKey` and `IPersonaDefinition`, as types, with `import type` or an inline `type` modifier as the sample above does; they have no runtime value. `bandOf(value, previous?)` computes the existing threshold and hysteresis bands; `HexacoTraitKey` types the canonical keys; `IPersonaDefinition` types a complete authored persona whose `personalityTraits` may contain the notetaker score map. The score map itself remains distinct from that definition. The normalizer retains the canonical spellings and the existing aliases. Render with `conversation` for dialogue and `writing` for written material; the choice belongs to the host call, not to a trait or a stored band. The renderer does not register or run adaptation tools.

## Operator-only traits and host migration

Honesty and emotionality are set by the authored persona definition. Role overlays already drop changes to them. `AdaptPersonalityTool` now imports that same `OPERATOR_ONLY_TRAITS` list and refuses either trait on every host, whether or not `sessionData.learning` is present. The result has `success: false` and `details.reason: 'operator_only'`. It reads no personality state, applies no mutation, records nothing, runs no decay and consumes no budget for that refusal. The exported list is frozen, so code in the same process cannot remove a trait from it and lift either guard: `splice` or `push` on it throws a `TypeError`.

This changes hosts that previously adapted honesty or emotionality without a learning layer. Set those scores in the authored persona instead. Continue using adaptation for extraversion, agreeableness, conscientiousness and openness where the application permits it. Existing session budgets, clamping, decay, learning modes, step bounds and accepted-call limits remain unchanged. Process freeze and learning-mode refusals retain their existing precedence.
