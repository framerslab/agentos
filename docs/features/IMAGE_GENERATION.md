# Image Generation — Provider-Agnostic Visual Generation

> Generate images from text prompts across 8 built-in providers with a single API.

---

## Table of Contents

1. [Overview](#overview)
2. [generateImage() API](#generateimage-api)
3. [Provider Reference](#provider-reference)
   - [OpenAI](#openai)
   - [Stability AI](#stability-ai)
   - [Replicate](#replicate)
   - [OpenRouter](#openrouter)
   - [Local Stable Diffusion](#local-stable-diffusion)
   - [BFL, fal and MiniMax](#bfl-fal-and-minimax)
4. [Provider Options Passthrough](#provider-options-passthrough)
5. [Local Setup (A1111 and ComfyUI)](#local-setup-a1111-and-comfyui)
6. [Custom Image Provider](#custom-image-provider)
7. [Usage Tracking](#usage-tracking)

---

## Overview

`generateImage()` is provider-agnostic: call it the same way whichever backend serves it, and switch providers by changing `provider`.

**Built-in providers** (`listImageProviderFactories()` lists them):

| Provider | ID | Key Env Var | Default model |
|----------|----|-------------|---------------|
| Replicate | `replicate` | `REPLICATE_API_TOKEN` | `black-forest-labs/flux-1.1-pro` |
| fal | `fal` | `FAL_API_KEY` | `fal-ai/flux/dev` |
| Black Forest Labs | `bfl` | `BFL_API_KEY` | `flux-pro-1.1` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-image-1` |
| Stability AI | `stability` | `STABILITY_API_KEY` | `stable-diffusion-xl-1024-v1-0` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | none: pass `model` |
| Stable Diffusion Local | `stable-diffusion-local` | `STABLE_DIFFUSION_LOCAL_BASE_URL` | `v1-5-pruned-emaonly` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` | `image-01` |

Ollama serves no image generation: `provider: 'ollama'` throws, since no image provider is registered under that id.

**Provider choice and fallback.** With `provider` (or a `provider:model` string in `model`), that provider serves the call. With neither, `generateImage()` takes the image model of a global default set with `setDefaultProvider()`, then the first provider whose key is in the environment, in the table's order (`providerPreferences` reorders or filters that chain). Either way, the other providers with keys in the environment become fallbacks: when the chosen provider fails, the next one is tried with its default model.

**Mature content:** pass `policyTier: 'mature'` or `'private-adult'` and
`generateImage` reroutes through the uncensored catalog (Replicate
community models, face-consistency aware) and turns off Replicate's
safety checker. See [UNCENSORED_CONTENT.md](./UNCENSORED_CONTENT.md)
for the full API and catalog.

---

## generateImage() API

```typescript
import { generateImage } from '@framers/agentos';

const result = await generateImage({
  // Required
  prompt:   'A futuristic city at sunset with flying cars and neon lights, photorealistic.',

  // Optional
  provider:       'openai',
  model:          'gpt-image-1',      // provider default if omitted
  size:           '1024x1024',        // or aspectRatio: '16:9'
  n:              1,
  outputFormat:   'png',              // 'png' | 'jpeg' | 'webp'
  quality:        'high',             // provider-specific quality tier
  seed:           42,                 // providers with seeds
  negativePrompt: 'blurry, text, watermark',  // providers with negative prompts

  // Provider-specific options (see per-provider sections)
  providerOptions: {},
});

// Result shape
console.log(result.images[0].url ?? result.images[0].dataUrl); // URL or data URL, as the provider returns it
console.log(result.images[0].mimeType);  // 'image/png'
console.log(result.model);               // model used
console.log(result.provider);            // provider used
console.log(result.usage?.totalImages);  // 1
```

Each image is a `GeneratedImage`: `url`, `dataUrl`, `base64`, `mimeType`, `revisedPrompt` and `providerMetadata`, each set when the provider returns it.

### Common Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | Text description of the image (required) |
| `provider` | `string` | Provider ID; auto-detected when omitted |
| `model` | `string` | Model ID, or `provider:model`; the provider default if omitted |
| `n` | `number` | Number of images |
| `size` | `string` | Dimensions as `WxH` |
| `aspectRatio` | `string` | `'1:1'`, `'16:9'`, `'9:16'`, `'4:3'`, etc. |
| `quality` | `string` | Provider-specific quality tier |
| `background` | `string` | Background mode, where the provider supports it |
| `outputFormat` | `string` | `'png'`, `'jpeg'`, `'webp'` |
| `outputCompression` | `number` | Compression level for lossy formats |
| `responseFormat` | `string` | Whether the provider returns URLs or base64 |
| `seed` | `number` | Seed for reproducible generation |
| `negativePrompt` | `string` | What to exclude |
| `referenceImageUrl` | `string` | Reference image for face consistency (asks the mature-tier router for `'face-consistency'`) |
| `providerOptions` | `object` | Options keyed by provider ID |
| `providerPreferences` | `object` | Reorders or filters the auto-detected provider chain |
| `policyTier`, `capabilities` | | Mature-tier routing |
| `apiKey`, `baseUrl` | `string` | Credentials and endpoint override |
| `usageLedger` | `object` | Records the call's usage ([Usage Tracking](#usage-tracking)) |

---

## Provider Reference

### OpenAI

```typescript
const image = await generateImage({
  provider: 'openai',
  model:    'gpt-image-1',
  prompt:   'A minimal logo for a tech startup, flat design, blue and white.',
  size:     '1024x1024',
  providerOptions: {
    openai: {
      moderation: 'low',     // 'low' | 'auto'
      // style: 'vivid' | 'natural', extraBody: fields sent as they are
    },
  },
});
```

**Default model:** `gpt-image-1` through `generateImage()`. **Env var:** `OPENAI_API_KEY`.

---

### Stability AI

```typescript
const image = await generateImage({
  provider:        'stability',
  model:           'stable-image-core',   // or 'stable-image-ultra', 'sd3-medium', 'sd3.5-large', ...
  prompt:          'An art deco travel poster for a moon colony, vintage style.',
  negativePrompt:  'text, watermark, low quality',
  aspectRatio:     '1:1',
  providerOptions: {
    stability: {
      stylePreset: 'illustration',
      cfgScale:    8,                // classifier-free guidance scale
      steps:       30,
    },
  },
});
```

The model picks the endpoint: `core`/`stable-image-core` and any id the provider does not know go to `stable-image/generate/core`, `ultra`/`stable-image-ultra` to `generate/ultra`, and the SD3 family (`sd3`, `sd3-medium`, `sd3-large`, `sd3-large-turbo`, `sd3.5-medium`, `sd3.5-large`, `sd3.5-large-turbo`) to `generate/sd3`; `providerOptions.stability.engine` overrides the model for that choice. The default model, `stable-diffusion-xl-1024-v1-0`, is not in that table, so it is served by the core endpoint.

**Env var:** `STABILITY_API_KEY`. **Options:** `engine`, `negativePrompt`, `seed`, `stylePreset`, `cfgScale`, `steps`, `samples`, `strength`, `aspectRatio`, `outputFormat`, `extraFields`.

---

### Replicate

```typescript
const image = await generateImage({
  provider:    'replicate',
  model:       'black-forest-labs/flux-1.1-pro',
  prompt:      'A product photo of a titanium watch on polished black stone.',
  aspectRatio: '1:1',
  providerOptions: {
    replicate: {
      outputQuality: 90,
      outputFormat:  'webp',
      input: {
        safety_tolerance: 2,         // model inputs sent as they are
      },
    },
  },
});
```

**Default model:** `black-forest-labs/flux-1.1-pro`. **Env var:** `REPLICATE_API_TOKEN`. **Options:** `wait`, `webhook`, `webhookEventsFilter`, `seed`, `negativePrompt`, `numOutputs`, `aspectRatio`, `outputFormat`, `outputQuality`, `disableSafetyChecker`, `goFast`, `megapixels`, `input`, `extraBody`, `referenceImageUrl`, `controlImage`, `controlType` (`canny`, `depth` or `pose`).

---

### OpenRouter

OpenRouter generates images through its chat completions endpoint with image output, so the call names a model that returns images; OpenRouter has no default image model here.

```typescript
const image = await generateImage({
  provider: 'openrouter',
  model:    process.env.OPENROUTER_IMAGE_MODEL!,   // an OpenRouter model with image output
  prompt:   'Abstract geometric art, primary colors, Mondrian style.',
  providerOptions: {
    openrouter: {
      // imageConfig: merged into the request's image_config
      // provider, transforms, extraBody: OpenRouter request fields, sent as they are
    },
  },
});
```

**Env var:** `OPENROUTER_API_KEY`. **Options:** `imageConfig`, `provider`, `transforms`, `extraBody`.

---

### Local Stable Diffusion

Run Stable Diffusion locally against an Automatic1111 (A1111) or ComfyUI server.

```typescript
const image = await generateImage({
  provider: 'stable-diffusion-local',
  model:    'v1-5-pruned-emaonly',   // model checkpoint name
  prompt:   'A brutalist house in dense fog, dramatic lighting.',
  negativePrompt: 'blurry, low quality, text',
  seed:     1234,
  baseUrl:  'http://localhost:7860',   // or set STABLE_DIFFUSION_LOCAL_BASE_URL
  providerOptions: {
    'stable-diffusion-local': {
      width:   512,
      height:  512,
      steps:   25,
      sampler: 'DPM++ 2M Karras',
      cfgScale: 7,
      hrFix:   true,
      denoisingStrength: 0.45,
    },
  },
});
```

**Default model:** `v1-5-pruned-emaonly`. **Env var:** `STABLE_DIFFUSION_LOCAL_BASE_URL` (required: without it or `baseUrl` the call throws). **Options:** `steps`, `cfgScale`, `seed`, `sampler`, `negativePrompt`, `width`, `height`, `batchSize`, `controlnet`, `loras`, `hrFix`, `denoisingStrength`.

---

### BFL, fal and MiniMax

- **Black Forest Labs** (`bfl`, `BFL_API_KEY`): FLUX models such as `flux-pro-1.1` (default), `flux-pro-1.1-ultra` and `flux-dev`.
- **fal** (`fal`, `FAL_API_KEY`): default `fal-ai/flux/dev`.
- **MiniMax** (`minimax`, `MINIMAX_API_KEY`): default `image-01`; options `promptOptimizer`, `width`, `height`. See [MiniMax images](https://github.com/framerslab/agentos/blob/master/docs/providers/minimax-images.md).

---

## Provider Options Passthrough

`providerOptions` is keyed by provider ID, and each provider reads only its own key, so options for several providers can sit side by side:

```typescript
const image = await generateImage({
  provider: 'stability',
  model:    'stable-image-core',
  prompt:   '...',
  providerOptions: {
    // Only the 'stability' key is read here
    stability: { stylePreset: 'photographic' },
    openai:    { style: 'vivid' },
    replicate: { outputQuality: 80 },
  },
});
```

That keeps provider-specific settings in place when a call falls back to another provider, or when you switch with the `provider` field alone.

---

## Local Setup (A1111 and ComfyUI)

### Automatic1111 WebUI

```bash
# Clone and install
git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui
cd stable-diffusion-webui

# Download a model checkpoint (example: SD 1.5)
mkdir -p models/Stable-diffusion
wget -O models/Stable-diffusion/v1-5-pruned-emaonly.safetensors \
  https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors

# Launch with API enabled
./webui.sh --api --listen

# Server starts at http://localhost:7860
```

Set the env var:

```bash
export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:7860
```

### ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI
pip install -r requirements.txt

# Place model checkpoints in models/checkpoints/
python main.py --port 7860

export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:7860
```

The provider detects the backend when it initializes: it probes A1111's model list, then ComfyUI's `/system_stats`. On ComfyUI it builds a minimal text-to-image workflow and submits it to `/prompt`; image edits and upscales need an A1111 server ([Image Editing](./IMAGE_EDITING.md)).

---

## Custom Image Provider

Register any image backend not covered by the built-in set:

```typescript
import {
  generateImage,
  registerImageProviderFactory,
  type IImageProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from '@framers/agentos';

// myImageAPI stands for your image service's client.
declare const myImageAPI: { generate(input: { prompt: string; model?: string }): Promise<{ imageUrl: string }> };

class MyImageProvider implements IImageProvider {
  readonly providerId = 'my-provider';
  isInitialized = false;
  defaultModelId = 'my-default-model';

  async initialize(config: Record<string, unknown>): Promise<void> {
    if (typeof config.defaultModelId === 'string') this.defaultModelId = config.defaultModelId;
    this.isInitialized = true;
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const response = await myImageAPI.generate({
      prompt: request.prompt,
      model:  request.modelId,
    });

    return {
      created:    Math.floor(Date.now() / 1000),
      modelId:    request.modelId ?? this.defaultModelId,
      providerId: this.providerId,
      images: [{ url: response.imageUrl, mimeType: 'image/png' }],
      usage: { totalImages: 1 },
    };
  }
}

// Register the factory
registerImageProviderFactory('my-provider', () => new MyImageProvider());

// Use it: a custom provider has no entry in the default-model table, so pass the model
const image = await generateImage({
  provider: 'my-provider',
  model:    'my-default-model',
  prompt:   'A product photo on white background.',
});
```

---

## Usage Tracking

`usageLedger` records each call's tokens and cost to the usage ledger; `getRecordedAgentOSUsage()` reads them back as totals:

```typescript
import { generateImage, getRecordedAgentOSUsage } from '@framers/agentos';

await generateImage({
  provider: 'openai',
  prompt:   'A banner image for our launch.',
  usageLedger: {
    enabled:   true,
    sessionId: 'launch-campaign',
  },
});

const usage = await getRecordedAgentOSUsage({
  enabled:   true,
  sessionId: 'launch-campaign',
});

console.log(usage.calls);      // 1
console.log(usage.costUSD);    // the cost the provider reported, 0 when it reports none
```

The ledger records `promptTokens`, `completionTokens`, `totalTokens` and `costUSD`; the image count is on the result's `usage.totalImages`.

---

## Related Guides

- [HIGH_LEVEL_API.md](../getting-started/HIGH_LEVEL_API.md) — full `generateImage()` API reference
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — automated blog publisher example with image generation
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — installation and environment setup
