# Image Editing — Img2Img, Inpainting & Upscaling

> Edit, upscale, and create variations of existing images across multiple providers with a unified API.

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

AgentOS provides three image editing APIs that work across all supported
providers. Unlike [Image Generation](./IMAGE_GENERATION.md) which creates from
scratch, these APIs operate on existing images:

| API | Purpose |
|-----|---------|
| `editImage()` | Img2img, inpainting, outpainting — modify an existing image |
| `upscaleImage()` | Super-resolution: 2x or 4x upscale with detail enhancement |
| `variateImage()` | Create N variations of an image while preserving composition |

All three accept a `Buffer`, `Uint8Array`, or file path as input and return
the same `ImageResult` shape used by `generateImage()`.

**Mature edits:** `editImage` accepts a `policyTier` option. Pass
`'mature'` or `'private-adult'` to route through an uncensored
face-consistency model (IP-Adapter FaceID SDXL by default, SDXL as
fallback) with the Replicate safety filter disabled automatically. Use
`capabilities: ['face-consistency', 'img2img']` when preserving an
existing character's identity matters. See
[UNCENSORED_CONTENT.md](./UNCENSORED_CONTENT.md).

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
  image: imageBuffer,        // Buffer | Uint8Array | string (file path)
  prompt: 'Make it a sunset scene with warm golden lighting',

  // Optional
  provider: 'openai',        // openai | stability | replicate | stable-diffusion-local
  model: 'gpt-image-1',     // Provider-specific model override
  mask: maskBuffer,          // Mask for inpainting (white = edit, black = keep)
  strength: 0.75,            // How much to transform (0.0 = identical, 1.0 = full regeneration)
  size: '1024x1024',         // Output dimensions
  negativePrompt: 'blurry, low quality',  // What to avoid (Stability, SD Local)
  seed: 42,                  // Reproducible output (provider-dependent)
  output: 'base64',          // 'base64' | 'url' (default varies by provider)
});

// Result shape
console.log(result.images[0].base64);   // Base64-encoded image data
console.log(result.images[0].url);      // Temporary URL (cloud providers)
console.log(result.provider);            // Which provider was used
console.log(result.model);              // Which model was used
console.log(result.usage);              // Token/cost tracking
```

### Strength Parameter

The `strength` parameter controls the balance between the source image and the
prompt. It is supported by all providers, though the exact behavior varies:

| Strength | Behavior |
|----------|----------|
| `0.0` | Identical to input (no transformation) |
| `0.1–0.3` | Subtle adjustments — color grading, minor touch-ups |
| `0.4–0.6` | Moderate changes — style transfer, lighting changes |
| `0.7–0.9` | Major transformation — composition preserved, content regenerated |
| `1.0` | Full regeneration guided by prompt (source used only for composition) |

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
  provider: 'stability',     // stability | replicate | stable-diffusion-local
  scale: 4,                  // 2 | 4 (default: 2)
  model: 'esrgan-v1-x2plus', // Provider-specific upscale model
  output: 'base64',
});

// 4x upscaled image
const upscaled = result.images[0];
console.log(`Upscaled to ${upscaled.width}x${upscaled.height}`);
```

### Upscale Models by Provider

| Provider | Models | Max Scale |
|----------|--------|-----------|
| Stability AI | `esrgan-v1-x2plus`, `stable-diffusion-x4-latent-upscaler` | 4x |
| Replicate | `real-esrgan`, `swinir` | 4x |
| Local SD (A1111) | `ESRGAN_4x`, `R-ESRGAN 4x+`, `SwinIR_4x` | 4x |
| Local SD (ComfyUI) | Any upscale model loaded in your workflow | 4x |

---

## variateImage() API

```typescript
import { variateImage } from '@framers/agentos';

// Stand-in for the seed bytes whose variations you want to generate.
declare const imageBuffer: Buffer;

const result = await variateImage({
  // Required
  image: imageBuffer,

  // Optional
  provider: 'openai',
  n: 3,                       // Number of variations (default: 1, max varies by provider)
  size: '1024x1024',
  strength: 0.6,              // How different each variation should be
});

// Multiple variations returned
for (const variant of result.images) {
  console.log(variant.url || `base64: ${variant.base64?.length} chars`);
}
```

---

## Provider Matrix

| Feature | OpenAI | Stability AI | Replicate | Local SD (A1111) | Local SD (ComfyUI) |
|---------|--------|-------------|-----------|------------------|---------------------|
| **Env Var** | `OPENAI_API_KEY` | `STABILITY_API_KEY` | `REPLICATE_API_TOKEN` | `STABLE_DIFFUSION_LOCAL_BASE_URL` | `STABLE_DIFFUSION_LOCAL_BASE_URL` |
| **Img2Img** | Yes | Yes | Yes | Yes | Yes |
| **Inpainting** | Yes | Yes | Yes | Yes | Yes |
| **Outpainting** | Yes | Yes | Via model | Yes | Yes |
| **Upscaling** | No | Yes | Yes | Yes | Yes |
| **Variations** | Yes | Yes | Yes | No | No |
| **Strength** | Yes | Yes | Yes | Yes | Yes |
| **Negative Prompt** | No | Yes | Model-dependent | Yes | Yes |
| **Seed** | No | Yes | Yes | Yes | Yes |
| **Cost Tier** | $$$ | $$ | $$ | Free | Free |
| **Latency** | ~3–8s | ~3–6s | ~5–15s | ~2–10s | ~2–10s |

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
  strength: 0.9,
  provider: 'openai',
});
```

**Mask format:** PNG with the same dimensions as the source image. White pixels
(`#FFFFFF`) mark the area to regenerate; black pixels (`#000000`) mark areas to
preserve. Partial transparency (grayscale) controls blending at the boundary.

---

## Outpainting

Extend an image beyond its original borders:

```typescript
import { editImage } from '@framers/agentos';

// Extend the image to the right
const result = await editImage({
  image: originalBuffer,
  prompt: 'Continue the landscape with rolling hills and a distant village',
  // Outpainting is achieved by providing a larger canvas with the original
  // image placed at an offset, and a mask covering the new area
  mask: outpaintMask,     // White where the extension should go
  size: '1536x1024',      // Wider than the original
  provider: 'stability',
});
```

---

## Upscaling

Increase image resolution with detail enhancement:

```typescript
import { upscaleImage } from '@framers/agentos';
import { readFileSync, writeFileSync } from 'node:fs';

const lowRes = readFileSync('./thumbnail-256x256.jpg');

// 4x upscale: 256x256 -> 1024x1024
const result = await upscaleImage({
  image: lowRes,
  scale: 4,
  provider: 'stability',
});

if (result.images[0].base64) {
  writeFileSync('./upscaled-1024x1024.png', Buffer.from(result.images[0].base64, 'base64'));
}
```

---

## Options Reference

### editImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| Uint8Array \| string` | **required** | Source image (buffer or file path) |
| `prompt` | `string` | **required** | What to generate / how to transform |
| `provider` | `string` | Auto-detect | Image provider ID |
| `model` | `string` | Provider default | Model override |
| `mask` | `Buffer \| Uint8Array \| string` | — | Inpainting mask (white = edit area) |
| `strength` | `number` | `0.75` | Transformation strength (0.0–1.0) |
| `size` | `string` | `'1024x1024'` | Output dimensions (`WxH`) |
| `negativePrompt` | `string` | — | Content to avoid (Stability, SD Local) |
| `seed` | `number` | Random | Reproducibility seed |
| `output` | `'base64' \| 'url'` | Provider default | Return format |

### upscaleImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| Uint8Array \| string` | **required** | Source image |
| `provider` | `string` | Auto-detect | Upscale provider ID |
| `scale` | `2 \| 4` | `2` | Upscale factor |
| `model` | `string` | Provider default | Upscale model override |
| `output` | `'base64' \| 'url'` | Provider default | Return format |

### variateImage() Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `image` | `Buffer \| Uint8Array \| string` | **required** | Source image |
| `provider` | `string` | Auto-detect | Provider ID |
| `n` | `number` | `1` | Number of variations (max varies by provider) |
| `size` | `string` | Original size | Output dimensions |
| `strength` | `number` | `0.6` | How different each variation should be |
| `output` | `'base64' \| 'url'` | Provider default | Return format |

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

A1111 exposes `/sdapi/v1/img2img` and `/sdapi/v1/extra-single-image`
endpoints. AgentOS calls these directly.

### ComfyUI

```bash
# Start ComfyUI
cd ComfyUI
python main.py --listen

# Set environment variable
export STABLE_DIFFUSION_LOCAL_BASE_URL=http://localhost:8188
export STABLE_DIFFUSION_LOCAL_BACKEND=comfyui  # Tell AgentOS to use ComfyUI API
```

ComfyUI uses workflow-based execution. AgentOS ships with default img2img and
upscale workflows. You can override them by placing custom workflow JSON files
in `~/.agentos/comfyui-workflows/`.

---

## Custom Provider

Register a custom image editing provider:

```typescript
import { registerImageProvider } from '@framers/agentos';

registerImageProvider({
  id: 'my-provider',
  name: 'My Image Provider',
  capabilities: {
    edit: true,
    upscale: true,
    variate: false,
    inpaint: true,
  },

  async edit(request) {
    // Call your API
    const response = await fetch('https://my-api.com/edit', {
      method: 'POST',
      body: JSON.stringify({ image: request.image, prompt: request.prompt }),
    });
    const data = await response.json();
    return {
      images: [{ base64: data.result, width: 1024, height: 1024 }],
      provider: 'my-provider',
      model: 'custom-v1',
    };
  },

  async upscale(request) {
    // ...
  },
});
```

---

## Related Documentation

- [Image Generation](./IMAGE_GENERATION.md) — Generate images from text prompts
- [Multimodal RAG](./MULTIMODAL_RAG.md) — Image + audio retrieval-augmented generation
- [Vision Pipeline](./VISION_PIPELINE.md) — OCR and image understanding
- [High-Level API](./HIGH_LEVEL_API.md) — Full API reference
