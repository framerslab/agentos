# Image Editing — Img2Img, Inpainting & Upscaling

> Edit, upscale, and create variations of existing images across providers with one API.

---

## Table of Contents

1. [Overview](#overview)
2. [editImage() API](#editimage-api)
3. [upscaleImage() API](#upscaleimage-api)
4. [variateImage() API](#variateimage-api)
5. [Provider Matrix](#provider-matrix)
6. [Img2Img (Style Transfer)](#img2img-style-transfer)
7. [Inpainting](#inpainting)
8. [Outpainting](#outpainting)
9. [Upscaling](#upscaling)
10. [Options Reference](#options-reference)
11. [Local Setup (A1111 & ComfyUI)](#local-setup-a1111--comfyui)
12. [Custom Provider](#custom-provider)
13. [Related Documentation](#related-documentation)

---

## Overview

AgentOS provides three image editing APIs. Unlike [Image Generation](./IMAGE_GENERATION.md), which creates from scratch, they operate on existing images:

| API | Purpose |
|-----|---------|
| `editImage()` | Img2img and inpainting: modify an existing image |
| `upscaleImage()` | Super-resolution: 2x or 4x upscale |
| `variateImage()` | Create N variations of an image |

Each takes the image as a `Buffer` or a string: a base64 data URL, a raw base64 string, a local file path, or an HTTP(S) URL. `editImage()` and `variateImage()` return `{ images, provider, model, usage }` and `upscaleImage()` returns `{ image, provider, model, usage }`, where each image is a `GeneratedImage` (`url`, `dataUrl`, `base64`, `mimeType`, `revisedPrompt` and `providerMetadata`, each set when the provider returns it). A provider that does not implement an operation throws `ImageEditNotSupportedError`, `ImageUpscaleNotSupportedError` or `ImageVariationNotSupportedError`.

**Mature edits:** `editImage` accepts a `policyTier` option. With `'mature'` or `'private-adult'`, Replicate's safety checker is turned off, and when the call pins neither `provider` nor `model`, the edit moves to the uncensored catalog's preferred Replicate model for its `capabilities` (default `['img2img']`). Pass `capabilities: ['face-consistency', 'img2img']` when preserving an existing character's identity matters. A mature edit has no fallback model. See [UNCENSORED_CONTENT.md](./UNCENSORED_CONTENT.md).

---

## editImage() API

```typescript
import { editImage } from '@framers/agentos';

// Stand-ins. Replace `imageBuffer` and `maskBuffer` with the actual image
// bytes (e.g. `await fs.readFile('./photo.png')`) you want to edit.
declare const imageBuffer: Buffer;
declare const maskBuffer: Buffer;

const result = await editImage({
  // Required
  image: imageBuffer,        // Buffer | string (data URL, base64, file path or URL)
  prompt: 'Make it a sunset scene with warm golden lighting',

  // Optional
  provider: 'stability',     // openai | stability | replicate | fal | stable-diffusion-local
  model: 'sd3-medium',       // Provider-specific model override
  mask: maskBuffer,          // Mask for inpainting (white = edit, black = keep)
  strength: 0.75,            // How much to transform (0.0 = identical, 1.0 = full regeneration)
  negativePrompt: 'blurry, low quality',  // What to avoid
  seed: 42,                  // Reproducible output
});

// Result shape
console.log(result.images[0].base64 ?? result.images[0].url);
console.log(result.provider);            // Which provider was used
console.log(result.model);              // Which model was used
console.log(result.usage);              // { costUSD? }
```

`mode` (`'img2img' | 'inpaint' | 'outpaint'`) is recorded on the call's trace span; no provider reads it. A provider inpaints when a `mask` is passed.

### Strength Parameter

`strength` controls the balance between the source image and the prompt. Stability, Replicate, fal and the local A1111 provider pass it on; OpenAI's edit endpoint has no strength control and ignores it.

| Strength | Behavior |
|----------|----------|
| `0.0` | Identical to input (no transformation) |
| `0.1–0.3` | Subtle adjustments: color grading, minor touch-ups |
| `0.4–0.6` | Moderate changes: style transfer, lighting changes |
| `0.7–0.9` | Major transformation: composition kept, content regenerated |
| `1.0` | Full regeneration guided by the prompt |

---

## upscaleImage() API

```typescript
import { upscaleImage } from '@framers/agentos';

// Stand-in for the bytes you want to upscale.
declare const imageBuffer: Buffer;

const result = await upscaleImage({
  // Required
  image: imageBuffer,

  // Optional
  provider: 'replicate',     // stability | replicate | stable-diffusion-local
  scale: 4,                  // 2 | 4 (default: 2)
  // width / height: explicit target dimensions, which take precedence over scale
});

const upscaled = result.image;
console.log(upscaled.url ?? `${upscaled.base64?.length} base64 chars`);
```

### Upscalers by Provider

| Provider | What it calls | Scale |
|----------|---------------|-------|
| Stability AI | the `stable-image/upscale/conservative` endpoint, with a target width of `width`, else 512 × `scale`, else 2048 | width-based |
| Replicate | `nightmareai/real-esrgan` unless `model` names another | 2x or 4x |
| Local SD (A1111) | `/sdapi/v1/extra-single-image` with the `R-ESRGAN 4x+` upscaler | `scale`, or `width`/`height` |

OpenAI and fal do not upscale.

---

## variateImage() API

Only the OpenAI provider implements variations.

```typescript
import { variateImage } from '@framers/agentos';

// Stand-in for the seed bytes whose variations you want to generate.
declare const imageBuffer: Buffer;

const result = await variateImage({
  // Required
  image: imageBuffer,

  // Optional
  provider: 'openai',
  n: 3,                       // Number of variations (default: 1)
  size: '1024x1024',
});

for (const variant of result.images) {
  console.log(variant.url || `base64: ${variant.base64?.length} chars`);
}
```

`variance` (0 to 1, default 0.5) is accepted for providers with a strength control; OpenAI's variations endpoint has none, so it has no effect there.

---

## Provider Matrix

| Feature | OpenAI | Stability AI | Replicate | fal | Local SD (A1111) |
|---------|--------|-------------|-----------|-----|------------------|
| **Env Var** | `OPENAI_API_KEY` | `STABILITY_API_KEY` | `REPLICATE_API_TOKEN` | `FAL_API_KEY` | `STABLE_DIFFUSION_LOCAL_BASE_URL` |
| **Img2Img** | Yes | Yes | Yes | Yes | Yes |
| **Inpainting (mask)** | Yes | Yes | Yes | Yes | Yes |
| **Upscaling** | No | Yes | Yes | No | Yes |
| **Variations** | Yes | No | No | No | No |
| **Strength** | No | Yes | Yes | Yes | Yes |
| **Negative Prompt** | No | Yes | Yes | Yes | Yes |
| **Seed** | No | Yes | Yes | Yes | Yes |
| **`size`** | Yes | No | No | No | Yes |
| **`n`** | Yes | No | Yes | Yes | Yes |

A local server running ComfyUI serves text-to-image only; edits and upscales go to the A1111 endpoints.

---

## Img2Img (Style Transfer)

Transform the style of an image while preserving its composition:

```typescript
import { editImage } from '@framers/agentos';
import { readFileSync } from 'node:fs';

const photo = readFileSync('./photo.jpg');

// Convert a photograph to oil painting style
const oilPainting = await editImage({
  image: photo,
  prompt: 'Oil painting in the style of Monet, impressionist brushstrokes, warm palette',
  strength: 0.65,
  provider: 'stability',
});

// Convert to anime style
const anime = await editImage({
  image: photo,
  prompt: 'Anime illustration, Studio Ghibli style, vibrant colors',
  strength: 0.7,
  provider: 'stability',
});
```

---

## Inpainting

Edit specific regions of an image using a mask. Masks can be generated
automatically with [Image Segmentation](./IMAGE_SEGMENTATION.md) (`maskToEditMask`)
instead of hand-painted:

```typescript
import { editImage } from '@framers/agentos';
import { readFileSync } from 'node:fs';

const image = readFileSync('./room.jpg');
const mask = readFileSync('./mask.png');  // White = area to edit

// Replace the masked area with new content
const result = await editImage({
  image,
  mask,
  prompt: 'A large bookshelf filled with colorful books',
  provider: 'openai',
});
```

**Mask format:** a PNG with the same dimensions as the source image. White pixels
(`#FFFFFF`) mark the area to regenerate; black pixels (`#000000`) mark areas to
preserve. How a provider treats gray values at the boundary is the provider's own.

---

## Outpainting

No provider extends a canvas by itself. To outpaint, place the original on a larger canvas, mask the new area, and inpaint:

```typescript
import { editImage } from '@framers/agentos';

// Stand-ins: the original placed on a wider canvas, and a mask that is
// white where the extension should go.
declare const paddedCanvas: Buffer;
declare const outpaintMask: Buffer;

const result = await editImage({
  image: paddedCanvas,
  mask: outpaintMask,
  prompt: 'Continue the landscape with rolling hills and a distant village',
  provider: 'stability',
});
```

---

## Upscaling

Increase image resolution:

```typescript
import { upscaleImage } from '@framers/agentos';
import { readFileSync, writeFileSync } from 'node:fs';

const lowRes = readFileSync('./thumbnail-256x256.jpg');

// 4x upscale: 256x256 -> 1024x1024
const result = await upscaleImage({
  image: lowRes,
  scale: 4,
  provider: 'stable-diffusion-local',
});

if (result.image.base64) {
  writeFileSync('./upscaled-1024x1024.png', Buffer.from(result.image.base64, 'base64'));
}
```

---

## Options Reference

### editImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| string` | **required** | Source image (Buffer, data URL, base64, file path or URL) |
| `prompt` | `string` | **required** | What to generate / how to transform |
| `provider` | `string` | Auto-detect | Image provider ID |
| `model` | `string` | Provider default | Model override (`provider:model` also accepted) |
| `mask` | `Buffer \| string` | — | Inpainting mask (white = edit area) |
| `mode` | `'img2img' \| 'inpaint' \| 'outpaint'` | — | Recorded on the trace span; providers do not read it |
| `strength` | `number` | Provider default | Transformation strength (0.0–1.0) |
| `size` | `string` | Provider default | Output dimensions (`WxH`; OpenAI and local A1111) |
| `negativePrompt` | `string` | — | Content to avoid |
| `seed` | `number` | Random | Reproducibility seed |
| `n` | `number` | Provider default | Number of output images |
| `policyTier` | `'safe' \| 'standard' \| 'mature' \| 'private-adult'` | — | Mature tiers route through the uncensored catalog |
| `capabilities` | `string[]` | `['img2img']` | Capabilities a mature-tier model must have |
| `apiKey`, `baseUrl` | `string` | Env vars | Credentials and endpoint override |
| `providerOptions` | `object` | — | Provider-specific options |
| `usageLedger` | `object` | — | Usage ledger options |

### upscaleImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| string` | **required** | Source image |
| `provider` | `string` | Auto-detect | Upscale provider ID |
| `model` | `string` | Provider default | Upscale model override |
| `scale` | `2 \| 4` | `2` (Replicate, A1111) | Upscale factor; Stability uses a 2048-pixel width when neither `scale` nor `width` is set |
| `width`, `height` | `number` | — | Target dimensions; they take precedence over `scale` |
| `apiKey`, `baseUrl`, `providerOptions`, `usageLedger` | | | As for `editImage()` |

### variateImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| string` | **required** | Source image |
| `provider` | `string` | Auto-detect | Provider ID |
| `model` | `string` | Provider default | Model override |
| `n` | `number` | `1` | Number of variations |
| `variance` | `number` | `0.5` | How different each variation should be; OpenAI ignores it |
| `size` | `string` | Provider default | Output dimensions |
| `apiKey`, `baseUrl`, `providerOptions` | | | As for `editImage()` |

---

## Local Setup (A1111 & ComfyUI)

### Automatic1111 (A1111) Web UI

```bash
# Start the A1111 server with API enabled
cd stable-diffusion-webui
./webui.sh --api --listen

# Set environment variable
export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:7860
```

AgentOS calls A1111's `/sdapi/v1/img2img` for edits and `/sdapi/v1/extra-single-image` for upscales.

### ComfyUI

```bash
# Start ComfyUI
cd ComfyUI
python main.py --listen

export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:8188
```

The local provider detects the backend when it initializes: it probes A1111's model list first, then ComfyUI's `/system_stats`. On ComfyUI it runs text-to-image through a minimal built-in workflow; edits and upscales use the A1111 endpoints, so they need an A1111 server.

---

## Custom Provider

Register a factory for your own provider with `registerImageProviderFactory(providerId, factory)`. The factory returns an `IImageProvider`; `editImage`, `upscaleImage` and `variateImage` are optional methods, and the high-level API throws the matching not-supported error when one is missing:

```typescript
import { registerImageProviderFactory } from '@framers/agentos';
import type { IImageProvider, ImageEditRequest, ImageGenerationResult } from '@framers/agentos';

class MyImageProvider implements IImageProvider {
  readonly providerId = 'my-provider';
  readonly defaultModelId = 'custom-v1';
  isInitialized = false;

  async initialize(_config: Record<string, unknown>): Promise<void> {
    this.isInitialized = true;
  }

  async generateImage(): Promise<ImageGenerationResult> {
    throw new Error('my-provider edits only');
  }

  async editImage(request: ImageEditRequest): Promise<ImageGenerationResult> {
    const response = await fetch('https://my-api.example/edit', {
      method: 'POST',
      body: JSON.stringify({ image: request.image.toString('base64'), prompt: request.prompt }),
    });
    const data = (await response.json()) as { result: string };
    return {
      created: Math.floor(Date.now() / 1000),
      modelId: request.modelId,
      providerId: this.providerId,
      images: [{ base64: data.result, mimeType: 'image/png' }],
    };
  }
}

registerImageProviderFactory('my-provider', () => new MyImageProvider());
```

---

## Related Documentation

- [Image Generation](./IMAGE_GENERATION.md) — Generate images from text prompts
- [Multimodal RAG](../memory/MULTIMODAL_RAG.md) — Image + audio retrieval-augmented generation
- [Vision Pipeline](./VISION_PIPELINE.md) — OCR and image understanding
- [High-Level API](../getting-started/HIGH_LEVEL_API.md) — Full API reference
