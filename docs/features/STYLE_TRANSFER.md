# Style Transfer — Image-Guided Aesthetic Translation

> Apply the visual style of one image to another using `transferStyle()`, backed by Flux Redux and cross-provider img2img.

---

## Overview

`transferStyle()` takes a source image and a style reference image, then produces an output that combines the content of the source with the visual aesthetic of the reference. This is useful for:

- Converting photographs to specific art styles (oil painting, anime, pixel art)
- Applying a brand's visual identity to generated content
- Creating consistent visual themes across a set of images

## `transferStyle()` API

```typescript
import { transferStyle } from '@framers/agentos';

const result = await transferStyle({
  image: './photo.jpg',
  styleReference: './monet-waterlilies.jpg',
  prompt: 'Impressionist oil painting, visible brushstrokes, warm golden light',
  strength: 0.7,
});

console.log(result.images[0].url);
console.log(result.provider);  // 'replicate'
console.log(result.model);     // 'black-forest-labs/flux-redux-dev'
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image` | `string \| Buffer` | **required** | Source image (file path, URL, data URI, or Buffer) |
| `styleReference` | `string \| Buffer` | **required** | Reference image whose style to apply |
| `prompt` | `string` | **required** | Text guiding the transfer direction |
| `strength` | `number` | `0.7` | How much reference style to apply (0 = unchanged, 1 = full transfer) |
| `provider` | `string` | auto-detect | Override provider selection |
| `model` | `string` | provider default | Override model selection |
| `size` | `string` | — | Output dimensions (e.g. `'1024x1024'`) |
| `negativePrompt` | `string` | — | Content to avoid |
| `seed` | `number` | — | Reproducibility seed |
| `policyTier` | `string` | — | Content policy tier for provider routing |
| `apiKey` | `string` | the provider's env var | Key for the provider named, or for the one auto-detected |
| `baseUrl` | `string` | provider default | Base URL for the provider |

## Provider Routing

When no provider is specified, `transferStyle()` auto-detects the best available provider from environment variables:

| Priority | Provider | Model | How It Works |
|----------|----------|-------|-------------|
| 1 | Replicate | Flux Redux Dev | Purpose-built for image-guided generation. Style reference as primary input. |
| 2 | Fal | Flux Dev | img2img with style description in prompt |
| 3 | Stability | stable-image-core | img2img with strength parameter |
| 4 | OpenAI | gpt-image-1 | editImage with descriptive prompt |

Replicate with Flux Redux produces the best results for style transfer because the model was trained specifically for image-conditioned generation.

## Strength Guide

| Range | Effect | Use Case |
|-------|--------|----------|
| 0.1–0.3 | Subtle color grading, minor texture shifts | Brand color overlays |
| 0.4–0.6 | Moderate style influence, composition preserved | "In the style of" variations |
| 0.7–0.8 | Strong style transfer, content recognizable | Art style conversion |
| 0.9–1.0 | Near-complete adoption of reference aesthetic | Full aesthetic transformation |

## Examples

```typescript
// Photograph → anime style
const anime = await transferStyle({
  image: './portrait-photo.jpg',
  styleReference: './ghibli-frame.png',
  prompt: 'Studio Ghibli anime style, cel shading, vibrant colors',
  strength: 0.75,
});

// Photograph → pixel art
const pixel = await transferStyle({
  image: './landscape.jpg',
  styleReference: './pixel-art-reference.png',
  prompt: '16-bit pixel art, limited palette, retro game aesthetic',
  strength: 0.8,
});

// Apply brand visual identity
const branded = await transferStyle({
  image: './product-photo.jpg',
  styleReference: './brand-style-guide.png',
  prompt: 'Clean, modern, brand-consistent visual treatment',
  strength: 0.5,
});
```

## Related

- [Image Generation](./IMAGE_GENERATION.md) — Text-to-image generation
- [Image Editing](./IMAGE_EDITING.md) — Img2img, inpainting, upscaling
- [Character Consistency](./CHARACTER_CONSISTENCY.md) — Face-preserving generation
