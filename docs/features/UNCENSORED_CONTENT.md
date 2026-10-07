# Uncensored Content — First-Class Policy-Tier Routing

AgentOS ships uncensored generation as a first-class feature. Any high-level
API call that accepts a `policyTier` of `'mature'` or `'private-adult'`
automatically reroutes to a curated uncensored model and disables the
provider's default safety filter, so callers get working output without
wiring bespoke model IDs for every surface.

This document covers:

- Text generation (`generateText`, `generateObject`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts))
- Image generation (`generateImage`)
- Image editing (`editImage`)
- The underlying model catalog and how to extend it

## Policy tiers

| Tier             | Behaviour                                                                 |
|------------------|----------------------------------------------------------------------------|
| `safe`           | Family-friendly. Default censored providers. Refuses sexual/violent content. |
| `standard`       | Default for most sessions. Mild violence, romantic tension, no explicit content. |
| `mature`         | Routes to uncensored catalog. Sexual content, graphic violence, dark themes. |
| `private-adult`  | Routes to uncensored catalog. All legal fictional content.                |

Tiers are inclusive: every tier above `safe` allows the tiers below it. Two
content categories remain prohibited at every tier (including
`private-adult`): sexual content involving minors, and real-world
instructions for weapons, explosives, or poisons.

## Text — uncensored chat and structured output

Set `policyTier` on any text call. The [`PolicyAwareRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/PolicyAwareRouter.ts) picks from the
[`UncensoredModelCatalog`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/UncensoredModelCatalog.ts) (Magnum v4 72B, Llama 3.3 70B, Hermes 3 70B and Llama 3.1 8B on OpenRouter) and
bypasses the default OpenAI/Anthropic chain.

```typescript
import { generateText, PolicyAwareRouter, createUncensoredModelCatalog } from '@framers/agentos/api';

// Option 1 — explicit router (most control)
const router = new PolicyAwareRouter(
  createUncensoredModelCatalog(),
  undefined,
  undefined,
  'private-adult',
);
const result = await generateText({
  router,
  system: 'You are a confident adult character named Cleopatra.',
  prompt: 'Describe the scene the way you want me to see it.',
});

// Option 2 — route through a tier-aware agent
import { agent } from '@framers/agentos';
const a = agent({
  instructions: 'You are Cleopatra, confident and direct.',
  router: new PolicyAwareRouter(createUncensoredModelCatalog(), undefined, undefined, 'mature'),
});
const reply = await a.generate('Tell me about the court intrigue.');
```

### Catalog entries (text)

`createUncensoredModelCatalog().getFallbackLadder(tier)` returns each tier's
ranked OpenRouter text models; `getPreferredTextModel(tier)` is its first entry.

| Tier | Ranking, best first | Context windows |
|---|---|---|
| `mature` | `meta-llama/llama-3.3-70b-instruct`, `anthracite-org/magnum-v4-72b`, `nousresearch/hermes-3-llama-3.1-70b`, `meta-llama/llama-3.1-8b-instruct` | 131,072; 32,768; 131,072; 131,072 |
| `private-adult` | `anthracite-org/magnum-v4-72b`, `meta-llama/llama-3.3-70b-instruct`, `nousresearch/hermes-3-llama-3.1-70b`, `meta-llama/llama-3.1-8b-instruct` | 32,768; 131,072; 131,072; 131,072 |

Pass `{ contentIntent: 'erotic' }` to keep only the models that permit it
(Magnum and Hermes 3 70B). Safe/standard tiers ignore the router and use the
default provider chain.

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

### Refusal-retry

When a model still produces wellness-bot speak despite the tier
(happens with some OpenRouter routing hops), [`PolicyAwareRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/PolicyAwareRouter.ts) does not
retry on its own — refusal detection is the caller's responsibility. The
wilds-ai `CompanionOrchestrator` wraps this into a
`runRefusalRetry` helper that iterates the full uncensored catalog on
detection; cooperating apps can use the same pattern via
`createUncensoredModelCatalog().getFallbackLadder(tier)`.

## Image — uncensored generation and editing

Set `policyTier: 'mature'` or `'private-adult'` on either entry point:

```typescript
import { generateImage, editImage } from '@framers/agentos';

// Generate an uncensored portrait
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

### Automatic behaviour when policyTier is set

When `policyTier` is `'mature'` or `'private-adult'`, the API:

1. Routes through [`PolicyAwareImageRouter`](https://github.com/framerslab/agentos/blob/master/src/io/media/images/PolicyAwareImageRouter.ts) to pick a model from the
   uncensored catalog. `generateImage` infers `'face-consistency'` when
   `referenceImageUrl` is supplied; `editImage` defaults to `'img2img'`
   and honours explicit `capabilities` hints.
2. Sets `providerOptions.replicate.disableSafetyChecker = true` so the
   community model's own NSFW filter does not silently veto the prompt.
3. Initialises Replicate as the primary provider (Fal and
   `stable-diffusion-local` remain in the fallback chain).

Safe and standard tiers bypass all of this; they use whatever
`provider` / `model` the caller passes in (or env-detected defaults).

### Catalog entries (image)

Tier `mature` / `private-adult` routes to Replicate community models:

| Model                                   | Quality | Content permissions       | Capabilities                                 |
|-----------------------------------------|---------|---------------------------|----------------------------------------------|
| `lucataco/realvisxl-v4.0`               | high    | general, romantic, erotic | txt2img, img2img, photorealistic             |
| `stability-ai/sdxl`                     | high    | all                       | txt2img, img2img                             |
| `lucataco/ip-adapter-faceid-sdxl`       | medium  | general, romantic, erotic | txt2img, img2img, **face-consistency**       |
| `zsxkib/instant-id`                     | medium  | general, romantic         | txt2img, **face-consistency**                |
| `lucataco/animate-diff`                 | medium  | general, romantic, violent | txt2img, video                              |
| `stability-ai/stable-video-diffusion`   | high    | general, romantic         | img2video, video                             |

The catalog is sorted by `quality` and filtered by `capabilities`. Call
`createUncensoredModelCatalog().getImageModels({ capabilities: ['face-consistency'] })`
to inspect the filtered list at runtime.

### Outfit / costume editing (wardrobe_preview)

For the canonical "change a character's clothes while preserving their
face" use case, pass a reference image and the `face-consistency`
capability. The router picks `lucataco/ip-adapter-faceid-sdxl`, which is
trained precisely for this pattern and allows erotic content.

```typescript
const lingerie = await editImage({
  image: cleopatraAvatarBuffer,
  prompt: 'wearing elegant lingerie, seductive pose, Egyptian palace setting',
  policyTier: 'mature',
  capabilities: ['face-consistency', 'img2img'],
  strength: 0.75,
});
```

Without `policyTier`, this call routes to Flux Kontext Dev (or whatever
the caller configured), which refuses the prompt at the model-provider
level — no amount of `disable_safety_checker` changes that because Flux
Kontext's moderation is baked into the model weights.

## Extending the catalog

`createUncensoredModelCatalog()` returns an immutable catalog. To add
models, compose your own implementation of [`UncensoredModelCatalog`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/UncensoredModelCatalog.ts):

```typescript
import type { UncensoredModelCatalog, CatalogEntry } from '@framers/agentos';

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

Wire the extended router into `generateImage` / `editImage` by passing
`provider` and `model` resolved from `router.getPreferredProvider(...)`
explicitly — the high-level APIs currently embed
`createUncensoredModelCatalog()` as the default, but the routers
themselves are caller-owned objects.

## Environment variables

Uncensored routing requires credentials for the uncensored providers.
At least one of each is recommended:

```
# Text (at least one for mature/private-adult)
OPENROUTER_API_KEY=sk-or-...

# Image (Replicate is the primary uncensored host)
REPLICATE_API_TOKEN=r8_...

# Optional fallbacks
FAL_API_KEY=...
STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:7860
```

If no uncensored-capable credentials are set, the APIs fall back to
whatever censored provider is configured and the tier has no effect.

## Logging and telemetry

Both `generateImage` and `editImage` emit OpenTelemetry spans with
`llm.provider` and `llm.model` attributes. When policy-aware routing
kicks in, the resolved provider/model reflect the uncensored choice,
so dashboards can filter by `tier` and spot hits on the uncensored
path.

## Related

- [IMAGE_GENERATION.md](./IMAGE_GENERATION.md) — general image API
- [IMAGE_EDITING.md](./IMAGE_EDITING.md) — edit / inpaint / outpaint modes
- [LLM_PROVIDERS.md](./LLM_PROVIDERS.md) — text provider matrix
- [CHARACTER_CONSISTENCY.md](./CHARACTER_CONSISTENCY.md) — face-reference workflow
