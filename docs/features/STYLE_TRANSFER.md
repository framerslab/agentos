# Style Transfer — Image-Guided Aesthetic Translation

> `transferStyle()` turns a prompt and an image into a new image on Flux Redux or an img2img provider. Which of the two images it sends depends on the provider.

---

## Overview

`transferStyle()` takes a source image (`image`), a style reference image (`styleReference`) and a prompt. It picks a provider and sends one of the two images:

- **Flux Redux on Replicate** (the first choice when `REPLICATE_API_TOKEN` is set): the style reference and the prompt. The source image is not sent, so the output is a variation of the reference steered by the prompt.
- **An img2img provider** (Fal, Stability, OpenAI, or Replicate with another model): the source image, the prompt and `strength`. The style reference is not sent, so the style comes from the prompt alone.
- **A provider without image editing**: the prompt with "Apply the visual style and aesthetic of the reference." appended, and no image.

Describe the target style in the prompt in every case: on the img2img path the prompt is the only carrier of the style.

## `transferStyle()` API

```typescript
import { transferStyle } from '@framers/agentos';

const result = await transferStyle({
  image: './photo.jpg',
  styleReference: './monet-waterlilies.jpg',
  prompt: 'Impressionist oil painting, visible brushstrokes, warm golden light',
  strength: 0.7,
});

console.log(result.images[0].url ?? result.images[0].dataUrl);
console.log(result.provider);  // 'replicate' when REPLICATE_API_TOKEN is set
console.log(result.model);     // 'black-forest-labs/flux-redux-dev'
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image` | `string \| Buffer` | **required** | Source image (file path, URL, data URI, or Buffer). Sent on the img2img path only. |
| `styleReference` | `string \| Buffer` | **required** | Style reference image. Sent on the Flux Redux path only. |
| `prompt` | `string` | **required** | Text guiding the output; the description of the style on the img2img path |
| `strength` | `number` | `0.7` | img2img strength: how far the output may move from the source image (0 keeps it, 1 replaces it). Not sent on the Flux Redux path, and the OpenAI provider does not send it. |
| `provider` | `string` | auto-detect | Override provider selection |
| `model` | `string` | provider default | Override model selection |
| `size` | `string` | — | Output dimensions (e.g. `'1024x1024'`) |
| `negativePrompt` | `string` | — | Content to avoid |
| `seed` | `number` | — | Reproducibility seed |
| `policyTier` | `string` | — | Accepted and not read: it does not change the provider routing below |
| `providerOptions` | `object` | — | Provider-specific options passed through |
| `apiKey` | `string` | the provider's env var | Key for the provider named by `provider` or a prefixed `model` (`openai:gpt-image-1`); refused without one |
| `baseUrl` | `string` | provider default | Base URL for the provider |

## Provider Routing

When no provider is named, `transferStyle()` takes the first provider whose key is set:

| Priority | Env var | Provider | Model | What is sent |
|----------|---------|----------|-------|--------------|
| 1 | `REPLICATE_API_TOKEN` | Replicate | `black-forest-labs/flux-redux-dev` | Style reference + prompt |
| 2 | `FAL_API_KEY` | Fal | `fal-ai/flux/dev` | Source image + prompt + `strength` |
| 3 | `STABILITY_API_KEY` | Stability | `stable-image-core` | Source image + prompt + `strength` |
| 4 | `OPENAI_API_KEY` | OpenAI | `gpt-image-1` | Source image + prompt (edit endpoint) |

## Examples

```typescript
// Photograph → anime style (on an img2img provider, the prompt carries the style)
const anime = await transferStyle({
  provider: 'stability',
  image: './portrait-photo.jpg',
  styleReference: './ghibli-frame.png',
  prompt: 'Studio Ghibli anime style, cel shading, vibrant colors',
  strength: 0.75,
});

// A variation of a reference look (Flux Redux sends the reference, not the photo)
const variation = await transferStyle({
  provider: 'replicate',
  model: 'black-forest-labs/flux-redux-dev',
  image: './landscape.jpg',
  styleReference: './pixel-art-reference.png',
  prompt: '16-bit pixel art of a mountain landscape, limited palette',
});
```

## Related

- [Image Generation](./IMAGE_GENERATION.md) — Text-to-image generation
- [Image Editing](./IMAGE_EDITING.md) — Img2img, inpainting, upscaling
- [Character Consistency](./CHARACTER_CONSISTENCY.md) — Face-preserving generation
