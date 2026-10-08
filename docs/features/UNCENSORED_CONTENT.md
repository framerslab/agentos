# Uncensored Content — Policy-Tier Routing

A `policyTier` of `'mature'` or `'private-adult'` routes a call to models that accept adult content. What it changes depends on the API:

- **Text** (`generateText`, `generateObject`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts), `agent()`): the fallback chain built from the environment leads with uncensored OpenRouter models, and a content-policy error from the primary model moves the call onto them. The first model changes only when the call carries a [`PolicyAwareRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/PolicyAwareRouter.ts).
- **Images** (`generateImage`, `editImage`): the call moves to a Replicate model from the uncensored catalog, and Replicate's safety checker is turned off.

This document covers:

- Text generation and structured output
- Image generation and editing
- The model catalog and how to extend it

## Policy tiers

| Tier             | What AgentOS does                                                          |
|------------------|----------------------------------------------------------------------------|
| `safe`           | Nothing: the configured provider and the availability fallback chain.      |
| `standard`       | Nothing, as for `safe`.                                                    |
| `mature`         | Uncensored routing with the mature ranking.                                |
| `private-adult`  | Uncensored routing with the private-adult ranking; the text fallback legs keep only models that permit erotic content. |

The tier selects models; AgentOS does not filter content by tier. Two content categories are prohibited at every tier, `private-adult` included: sexual content involving minors, and real-world instructions for weapons, explosives, or poisons. Enforcing that is the host's work, with its own guardrails.

## Text — uncensored chat and structured output

Without a router, `policyTier` changes the fallback chain, not the first model:

```typescript
import { generateText } from '@framers/agentos';

const result = await generateText({
  provider: 'openai',
  model: 'gpt-4o',
  policyTier: 'mature',
  prompt: 'Continue the scene.',
});
```

When the call names no `fallbackProviders`, it builds its chain with `buildPolicyAwareFallbackChain(tier)`: with `OPENROUTER_API_KEY` set, the tier's ranked uncensored models come first, then the availability chain. A content-policy error from a provider (an error code or type of `content_policy_violation`, `content_filter` or `safety_violations`) counts as retryable, so the call moves on to those models.

To send the first call to an uncensored model, pass a `PolicyAwareRouter`, which picks from the [`UncensoredModelCatalog`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/UncensoredModelCatalog.ts):

```typescript
import { agent } from '@framers/agentos';
import { generateText, PolicyAwareRouter, createUncensoredModelCatalog } from '@framers/agentos/api';

// Option 1 — a router on one call
const router = new PolicyAwareRouter(
  createUncensoredModelCatalog(),
  undefined,        // base router for safe and standard calls
  undefined,        // per-tier model overrides
  'private-adult',  // the tier when the call carries none
);
const result = await generateText({
  router,
  system: 'You are a confident adult character named Cleopatra.',
  prompt: 'Describe the scene the way you want me to see it.',
});

// Option 2 — a router on an agent
const a = agent({
  instructions: 'You are Cleopatra, confident and direct.',
  router: new PolicyAwareRouter(createUncensoredModelCatalog(), undefined, undefined, 'mature'),
});
const reply = await a.generate('Tell me about the court intrigue.');
```

A `policyTier` on the call overrides the router's default tier. On `mature` and `private-adult` the router returns, in order:

1. the per-tier override model, when one is set (on OpenRouter);
2. with required capabilities, the best-quality catalog model that lists each of them by that exact name and permits the content intent (`erotic` on `private-adult` and `romantic` on `mature` when the call names none). A call with tools requires `function_calling`, which the catalog lists as `tool_use`, so no catalog model matches it: the router hands such a call to its base router, or returns no route and the configured model answers;
3. otherwise `getPreferredTextModel(tier, contentIntent)`, the first model of the tier's ranking.

On `safe` and `standard` the router hands the call to its base router, or returns no route.

### Catalog entries (text)

`createUncensoredModelCatalog().getFallbackLadder(tier)` returns each tier's
ranked OpenRouter text models; `getPreferredTextModel(tier)` is its first entry.

| Tier | Ranking, best first | Context windows |
|---|---|---|
| `mature` | `meta-llama/llama-3.3-70b-instruct`, `anthracite-org/magnum-v4-72b`, `nousresearch/hermes-3-llama-3.1-70b`, `meta-llama/llama-3.1-8b-instruct` | 131,072; 32,768; 131,072; 131,072 |
| `private-adult` | `anthracite-org/magnum-v4-72b`, `meta-llama/llama-3.3-70b-instruct`, `nousresearch/hermes-3-llama-3.1-70b`, `meta-llama/llama-3.1-8b-instruct` | 32,768; 131,072; 131,072; 131,072 |

Pass `{ contentIntent: 'erotic' }` to keep only the models that permit it
(Magnum and Hermes 3 70B).

### Fallback chain

A failed `mature` or `private-adult` call walks
`buildPolicyAwareFallbackChain(tier)`: the tier's ladder (private-adult keeps
the models that permit `erotic`; `llama-3.1-8b-instruct` is never a leg), then
the availability chain. The walk:

- drops the leg that names the model that just failed;
- runs two uncensored legs, and the next ranked model only in place of one that
  failed on availability or could not hold the request;
- after a model refusal, passes over the chain's own Claude legs, while legs the
  caller wrote run as written;
- runs each leg as named: a router on the call picks only the first model;
- skips any catalog model whose context window cannot hold the request
  (`checkContextFit`), the first model included, which is then never sent the
  turn. The check counts the output the provider will be asked for (a leg's
  `maxTokensHeadroom` and a `customModelParams.max_tokens` override included)
  and, on the prompt shim, the tool text it renders. With `planning` on, the
  planning call goes out before the check. A call that enables OpenRouter's
  context compression (`customModelParams: { plugins: [{ id: 'context-compression' }] }`)
  is sent as is: OpenRouter trims the prompt to the window.

### Refusals

A provider's content-policy error is retryable, so the fallback chain runs on it. A model that answers with a refusal in its text returns that text as the result: AgentOS does not read the reply for refusals, and [`PolicyAwareRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/PolicyAwareRouter.ts) does not retry. To retry on a refusal in the text, detect it in your code and call again with the next model of `createUncensoredModelCatalog().getFallbackLadder(tier)`.

## Image — uncensored generation and editing

Set `policyTier: 'mature'` or `'private-adult'` on either entry point:

```typescript
import { generateImage, editImage } from '@framers/agentos';

// Generate a portrait that keeps the face of a reference image
const portrait = await generateImage({
  prompt: 'Cleopatra in the palace, oil painting style',
  policyTier: 'mature',
  referenceImageUrl: 'https://cdn.example.com/cleopatra-anchor.png',
});

// Edit an existing avatar (e.g. outfit change) while preserving the face
const outfit = await editImage({
  image: existingAvatarBuffer,
  prompt: 'wearing formal court attire, seated on the throne',
  policyTier: 'mature',
  capabilities: ['face-consistency', 'img2img'],
});
```

### What a mature or private-adult image call does

1. Sets `providerOptions.replicate.disableSafetyChecker = true`, unless the
   call sets that field itself.
2. When the call names no `provider` and no `model`, picks a model with
   [`PolicyAwareImageRouter`](https://github.com/framerslab/agentos/blob/master/src/io/media/images/PolicyAwareImageRouter.ts) on the built-in catalog.
   `generateImage` asks for `'face-consistency'` when `referenceImageUrl`
   is supplied; `editImage` asks for `'img2img'`; an explicit
   `capabilities` list replaces either. A call that names a provider or a
   model keeps it.
3. Every catalog image model is on Replicate, so a routed call runs on
   Replicate and needs `REPLICATE_API_TOKEN` (or `apiKey`); without one it
   fails with `No API key for replicate`. `generateImage` keeps the other
   image providers whose keys are set as fallbacks, each on its own default
   model; `editImage` has no fallback.

Safe and standard tiers change none of this; they use whatever
`provider` / `model` the caller passes in (or env-detected defaults).

### Catalog entries (image)

Tier `mature` / `private-adult` routes to Replicate community models:

| Model                                   | Quality | Content permissions       | Capabilities                                 |
|-----------------------------------------|---------|---------------------------|----------------------------------------------|
| `lucataco/realvisxl-v4.0`               | high    | general, romantic, erotic | txt2img, img2img, photorealistic             |
| `stability-ai/sdxl`                     | high    | general, romantic, erotic, violent, horror | txt2img, img2img            |
| `zsxkib/instant-id`                     | medium  | general, romantic         | txt2img, **face-consistency**                |
| `lucataco/ip-adapter-faceid-sdxl`       | medium  | general, romantic, erotic | txt2img, img2img, **face-consistency**       |
| `lucataco/animate-diff`                 | medium  | general, romantic, violent | txt2img, video                              |
| `stability-ai/stable-video-diffusion`   | high    | general, romantic         | img2video, video                             |

`getPreferredImageModel(tier, capabilities)` keeps the models that list every
requested capability and returns the highest-quality one, table order
breaking ties: `lucataco/realvisxl-v4.0` with no capabilities or with
`img2img`, `zsxkib/instant-id` with `face-consistency` alone, and
`lucataco/ip-adapter-faceid-sdxl` with `face-consistency` and `img2img`.
`createUncensoredModelCatalog().getImageModels({ capabilities: ['face-consistency'] })`
returns the filtered list in table order.

### Outfit / costume editing

To change a character's clothes while preserving their face, pass the
source image and the `face-consistency` and `img2img` capabilities. The
router picks `lucataco/ip-adapter-faceid-sdxl`, the one catalog model that
lists both and permits erotic content.

```typescript
const lingerie = await editImage({
  image: cleopatraAvatarBuffer,
  prompt: 'wearing elegant lingerie, seductive pose, Egyptian palace setting',
  policyTier: 'mature',
  capabilities: ['face-consistency', 'img2img'],
  strength: 0.75,
});
```

Without `policyTier`, the call runs on the provider and model it names, or
on the env-detected image provider's default model, and Replicate's safety
checker keeps its default.

## Extending the catalog

`createUncensoredModelCatalog()` returns a fixed catalog. To add models,
wrap it in your own implementation of [`UncensoredModelCatalog`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/UncensoredModelCatalog.ts):

```typescript
import { editImage } from '@framers/agentos';
import {
  createUncensoredModelCatalog,
  PolicyAwareImageRouter,
  type CatalogEntry,
  type UncensoredModelCatalog,
} from '@framers/agentos/api';

const EXTRA_ENTRIES: CatalogEntry[] = [
  {
    modelId: 'your-org/your-nsfw-model',
    displayName: 'Custom Erotic SDXL',
    providerId: 'replicate',
    modality: 'image',
    quality: 'high',
    contentPermissions: ['general', 'romantic', 'erotic'],
    capabilities: ['txt2img', 'img2img', 'face-consistency'],
  },
];

function makeExtendedCatalog(): UncensoredModelCatalog {
  const base = createUncensoredModelCatalog();
  return {
    getTextModels: (f) => base.getTextModels(f),
    getImageModels: (f) => [...EXTRA_ENTRIES, ...base.getImageModels(f)],
    getFallbackLadder: (t, o) => base.getFallbackLadder(t, o),
    getPreferredTextModel: (t, i) => base.getPreferredTextModel(t, i),
    getPreferredImageModel: (t, caps) => {
      const preferred = EXTRA_ENTRIES.find(
        (e) => !caps || caps.every((c) => e.capabilities.includes(c)),
      );
      return preferred ?? base.getPreferredImageModel(t, caps);
    },
  };
}

const router = new PolicyAwareImageRouter(makeExtendedCatalog());
```

`generateImage` and `editImage` route on the built-in catalog and take no
router option. To use an extended catalog, resolve the model with your
router and pass it as `provider` and `model`, keeping `policyTier` so the
safety checker stays off:

```typescript
const pick = router.getPreferredProvider('mature', ['face-consistency', 'img2img']);

const edited = await editImage({
  image: avatarBuffer,
  prompt: 'wearing formal court attire',
  policyTier: 'mature',
  provider: pick?.providerId,
  model: pick?.modelId,
});
```

For text, pass the extended catalog to `new PolicyAwareRouter(...)`. The
policy fallback chain always runs on the built-in catalog.

## Environment variables

```
# Text: the uncensored fallback legs and PolicyAwareRouter's picks run on OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Images: every catalog image model runs on Replicate
REPLICATE_API_TOKEN=r8_...
```

Without `OPENROUTER_API_KEY`, the policy fallback chain has no uncensored
legs, and a model that `PolicyAwareRouter` picks fails with
`No API key for openrouter`. Without `REPLICATE_API_TOKEN`, a routed
`mature` or `private-adult` image call fails with `No API key for replicate`.

## Logging and telemetry

`generateText`, `generateImage` and `editImage` set the `llm.provider` and
`llm.model` attributes on their OpenTelemetry spans to the model the call
ran on, so a dashboard can count calls on the uncensored models by model
name. The spans carry no tier attribute.

## Related

- [IMAGE_GENERATION.md](./IMAGE_GENERATION.md) — general image API
- [IMAGE_EDITING.md](./IMAGE_EDITING.md) — edit / inpaint / outpaint modes
- [LLM_PROVIDERS.md](./LLM_PROVIDERS.md) — text provider matrix
- [CHARACTER_CONSISTENCY.md](./CHARACTER_CONSISTENCY.md) — face-reference workflow
