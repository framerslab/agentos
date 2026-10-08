# Image Generation — Provider-Agnostic Visual Generation

> Generate images from text prompts across 5 providers with a single unified API.

---

## Table of Contents

1. [Overview](#overview)
2. [generateImage() API](#generateimage-api)
3. [Provider Reference](#provider-reference)
   - [OpenAI (gpt-image-1)](#openai-gpt-image-1)
   - [Stability AI](#stability-ai)
   - [Replicate](#replicate)
   - [OpenRouter](#openrouter)
   - [Local Stable Diffusion](#local-stable-diffusion)
4. [Provider Options Passthrough](#provider-options-passthrough)
5. [Local Setup (A1111 and ComfyUI)](#local-setup-a1111-and-comfyui)
6. [Custom Image Provider](#custom-image-provider)
7. [Usage Tracking](#usage-tracking)

---

## Overview

`generateImage()` is a provider-agnostic factory. Call it the same way
regardless of which backend you use — switch providers by changing `provider`
without touching application code.

**Supported providers:**

| Provider | ID | Key Env Var | Best For |
|----------|----|-------------|---------|
| OpenAI | `openai` | `OPENAI_API_KEY` | Photorealistic, DALL-E quality |
| Stability AI | `stability` | `STABILITY_API_KEY` | Art styles, SDXL models |
| Replicate | `replicate` | `REPLICATE_API_TOKEN` | FLUX, community models |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Model routing, fallback |
| Stable Diffusion Local | `stable-diffusion-local` | `STABLE_DIFFUSION_LOCAL_BASE_URL` | Privacy, no API cost |
| Ollama | `ollama` | `OLLAMA_BASE_URL` | Local, offline |

**Mature content:** pass `policyTier: 'mature'` or `'private-adult'` and
`generateImage` reroutes through the uncensored catalog (Replicate
community models, face-consistency aware) and disables the provider
safety filter automatically. See
[UNCENSORED_CONTENT.md](./UNCENSORED_CONTENT.md) for the full API and
catalog.

---

## generateImage() API

```typescript
import { generateImage } from '@framers/agentos';

const result = await generateImage({
  // Required
  provider: 'openai',
  prompt:   'A futuristic city at sunset with flying cars and neon lights, photorealistic.',

  // Optional
  model:          'gpt-image-1',      // provider default if omitted
  negativePrompt: 'blurry, text, watermark',
  width:          1024,
  height:         1024,
  aspectRatio:    '16:9',             // alternative to width/height
  numImages:      1,
  outputFormat:   'png',              // 'png' | 'jpeg' | 'webp'
  quality:        'hd',               // provider-specific quality tier
  seed:           42,                 // for reproducibility
  steps:          30,                 // diffusion steps (local/Stability)

  // Provider-specific options (see per-provider sections)
  providerOptions: {},
});

// Result shape
console.log(result.images[0].url);       // URL or base64 data URI
console.log(result.images[0].mimeType);  // 'image/png'
console.log(result.images[0].width);     // actual width
console.log(result.images[0].height);    // actual height
console.log(result.modelId);             // model used
console.log(result.providerId);          // provider used
console.log(result.usage.totalImages);   // 1
```

### Common Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `provider` | `string` | Provider ID (required) |
| `prompt` | `string` | Text description of the image (required) |
| `model` | `string` | Model ID — uses provider default if omitted |
| `negativePrompt` | `string` | What to exclude (Stability, Replicate, local) |
| `width` | `number` | Image width in pixels |
| `height` | `number` | Image height in pixels |
| `aspectRatio` | `string` | `'1:1'`, `'16:9'`, `'9:16'`, `'4:3'`, etc. |
| `numImages` | `number` | Number of images to generate (default: 1) |
| `outputFormat` | `string` | `'png'` (default), `'jpeg'`, `'webp'` |
| `quality` | `string` | Quality tier (`'standard'`, `'hd'`) |
| `seed` | `number` | Seed for reproducible generation |
| `steps` | `number` | Diffusion steps (local models, default: 20–50) |

---

## Provider Reference

### OpenAI (gpt-image-1)

```typescript
const image = await generateImage({
  provider: 'openai',
  model:    'gpt-image-1',  // or 'dall-e-3', 'dall-e-2'
  prompt:   'A minimal logo for a tech startup, flat design, blue and white.',
  quality:  'hd',
  size:     '1024x1024',    // OpenAI uses size instead of width/height
  providerOptions: {
    openai: {
      style:            'vivid',    // 'vivid' | 'natural'
      responseFormat:   'url',      // 'url' | 'b64_json'
    },
  },
});
```

**Default model:** `gpt-image-1`
**Env var:** `OPENAI_API_KEY`
**Supported sizes:** `256x256`, `512x512`, `1024x1024`, `1024x1792`, `1792x1024`

---

### Stability AI

```typescript
const image = await generateImage({
  provider:        'stability',
  model:           'stable-image-core',   // or 'stable-diffusion-xl-1024-v1-0', 'sd3'
  prompt:          'An art deco travel poster for a moon colony, vintage style.',
  negativePrompt:  'text, watermark, low quality',
  width:           1024,
  height:          1024,
  steps:           30,
  providerOptions: {
    stability: {
      stylePreset: 'illustration',   // 'photographic' | 'illustration' | 'digital-art' | ...
      seed:        42,
      cfgScale:    8,                // classifier-free guidance scale
      sampler:     'K_DPMPP_2M',
    },
  },
});
```

**Default model:** `stable-image-core`
**Env var:** `STABILITY_API_KEY`
**Style presets:** `photographic`, `illustration`, `digital-art`, `anime`, `comic-book`, `fantasy-art`, `line-art`, `modeling-compound`, `neon-punk`, `origami`, `pixel-art`, `tile-texture`

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
        go_fast:          true,
        safety_tolerance: 2,
      },
    },
  },
});
```

**Default model:** `black-forest-labs/flux-1.1-pro`
**Env var:** `REPLICATE_API_TOKEN`
**Popular models:**
- `black-forest-labs/flux-schnell` — fast, lower quality
- `black-forest-labs/flux-1.1-pro` — high quality
- `stability-ai/sdxl` — SDXL via Replicate
- `bytedance/sdxl-lightning-4step` — 4-step fast generation

---

### OpenRouter

OpenRouter can route image generation requests to multiple backends:

```typescript
const image = await generateImage({
  provider: 'openrouter',
  model:    'openai/gpt-image-1',   // or 'stability-ai/stable-image-core'
  prompt:   'Abstract geometric art, primary colors, Mondrian style.',
  providerOptions: {
    openrouter: {
      route: 'fallback',   // try next model if primary fails
    },
  },
});
```

**Default model:** `openai/gpt-image-1`
**Env var:** `OPENROUTER_API_KEY`

---

### Local Stable Diffusion

Run Stable Diffusion locally with no API costs. Supports both Automatic1111
(A1111) and ComfyUI WebUI APIs.

```typescript
const image = await generateImage({
  provider: 'stable-diffusion-local',
  model:    'v1-5-pruned-emaonly',   // model checkpoint name
  prompt:   'A brutalist house in dense fog, dramatic lighting.',
  negativePrompt: 'blurry, low quality, text',
  width:    512,
  height:   512,
  steps:    25,
  seed:     1234,
  baseUrl:  'http://localhost:7860',   // or set STABLE_DIFFUSION_LOCAL_BASE_URL
  providerOptions: {
    'stable-diffusion-local': {
      samplerName:    'DPM++ 2M Karras',
      cfgScale:       7,
      restoreFaces:   false,
      hiresUpscaler:  'R-ESRGAN 4x+',
      hiresSteps:     10,
      denoisingStrength: 0.45,
    },
  },
});
```

**Default model:** `v1-5-pruned-emaonly`
**Env var:** `STABLE_DIFFUSION_LOCAL_BASE_URL` (default: `http://localhost:7860`)

---

## Provider Options Passthrough

Every provider accepts a `providerOptions` object keyed by provider ID.
Unknown keys are silently ignored — safe to set options for multiple providers:

```typescript
const image = await generateImage({
  provider: 'stability',
  model:    'stable-image-core',
  prompt:   '...',
  providerOptions: {
    // Only the 'stability' key is used; others are ignored
    stability: { stylePreset: 'photographic' },
    openai:    { style: 'vivid' },    // ignored when provider != 'openai'
    replicate: { outputQuality: 80 }, // ignored when provider != 'replicate'
  },
});
```

This pattern lets you pre-configure options for all providers and switch
with just a single `provider` field change.

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
# Launch
python main.py --port 7860

export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:7860
```

AgentOS uses the A1111-compatible `/sdapi/v1/txt2img` endpoint.
ComfyUI requires the A1111 API compatibility layer or a custom provider
(see below).

### Ollama with Image Model

```bash
ollama pull stable-diffusion
export OLLAMA_BASE_URL=http://localhost:11434
```

```typescript
const image = await generateImage({
  provider: 'ollama',
  model:    'stable-diffusion',
  prompt:   'A cozy reading nook with warm lamplight.',
});
```

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

class MyImageProvider implements IImageProvider {
  readonly providerId    = 'my-provider';
  readonly isInitialized = false;
  readonly defaultModelId = 'my-default-model';

  async initialize(): Promise<void> {
    // Connect to your image service
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
      images: [
        {
          url:      response.imageUrl,
          mimeType: 'image/png',
          width:    request.width ?? 1024,
          height:   request.height ?? 1024,
        },
      ],
      usage: { totalImages: 1 },
    };
  }
}

// Register the factory
registerImageProviderFactory('my-provider', () => new MyImageProvider());

// Use it
const image = await generateImage({
  provider: 'my-provider',
  model:    'my-default-model',
  prompt:   'A product photo on white background.',
});
```

---

## Usage Tracking

Track image generation usage across providers:

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

console.log(usage.totalImages);     // 1
console.log(usage.estimatedCost);   // e.g., 0.04
```

---

## Related Guides

- [HIGH_LEVEL_API.md](../getting-started/HIGH_LEVEL_API.md) — full `generateImage()` API reference
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — automated blog publisher example with image generation
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — installation and environment setup
