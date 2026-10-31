# Style Transfer — Image-Guided Aesthetic Translation

> `transferStyle()` restyles a source image after a style reference. It sends the provider both images: Replicate and Fal on FLUX.2, Stability on its style-transfer endpoint, OpenAI on two-image edits.

---

## Overview

`transferStyle()` takes a source image (`image`), a style reference image (`styleReference`) and a prompt, and sends all three to the provider. The source keeps its subject and composition; the reference gives the palette, brushwork, texture, lighting and medium.

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
console.log(result.model);     // 'black-forest-labs/flux-2-pro'
```

A provider without a call that takes both images is refused. For a variation of the reference alone use [`variateImage()`](./IMAGE_EDITING.md), and to change the source by a prompt alone use [`editImage()`](./IMAGE_EDITING.md).

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image` | `string \| Buffer` | **required** | Source image (file path, URL, data URI, or Buffer) |
| `styleReference` | `string \| Buffer` | **required** | Style reference image (file path, URL, data URI, or Buffer) |
| `prompt` | `string` | **required** | Text guiding the result; it may be empty |
| `strength` | `number` | `0.7` | How much of the reference's style to apply, 0 to 1 (see [Strength](#strength)) |
| `provider` | `string` | auto-detect | Provider override |
| `model` | `string` | the provider's default below | A model the provider's style transfer runs (see [Providers](#providers)) |
| `size` | `string` | — | Output dimensions (e.g. `'1024x1024'`); sent to OpenAI only |
| `negativePrompt` | `string` | — | Content to avoid; sent to Stability only |
| `seed` | `number` | — | Reproducibility seed; OpenAI takes none |
| `policyTier` | `string` | — | Accepted and not read: it does not change the provider routing below |
| `providerOptions` | `object` | — | Provider-specific options (see [Providers](#providers)) |
| `apiKey` | `string` | the provider's env var | Key for the provider named by `provider` or a prefixed `model` (`openai:gpt-image-2.5-sunburst`); refused without one |
| `baseUrl` | `string` | the provider's env var, then its default | Base URL for the provider named by `provider` or a prefixed `model`; refused without one, like `apiKey`. An empty or whitespace-only value is unset and needs neither |

## Provider routing

When no provider is named, `transferStyle()` takes the first provider whose key is set:

| Priority | Env var | Provider | Default model |
|----------|---------|----------|---------------|
| 1 | `REPLICATE_API_TOKEN` | Replicate | `black-forest-labs/flux-2-pro` |
| 2 | `FAL_API_KEY` | Fal | `fal-ai/flux-2-pro/edit` |
| 3 | `STABILITY_API_KEY` | Stability | `stable-image-style-transfer` (the endpoint takes no model) |
| 4 | `OPENAI_API_KEY` | OpenAI | `gpt-image-2.5-sunburst` |

The provider picked this way reads its base URL from its own variable when one is set (`REPLICATE_BASE_URL`, `FAL_BASE_URL`, `STABILITY_BASE_URL`, `OPENAI_BASE_URL`). A `baseUrl` in the call needs a named provider, as `apiKey` does, so neither reaches a provider the environment chose. An empty or whitespace-only `baseUrl` is unset: it names no endpoint, so it needs no provider, and the provider picked this way reads its own variable as it does with none.

With `provider` named and no `model`, the call runs on that provider's default above. The global default model (`setDefaultProvider`) is not used for a style transfer: it is a generation default. A known `provider:` prefix on `model` wins over `provider`.

## Providers

| Provider | Models | Formats | Sent | Not sent |
|----------|--------|---------|------|----------|
| Replicate | `black-forest-labs/flux-2-pro`, `flux-2-max`, `flux-2-flex`, `flux-2-dev` | JPEG, PNG, GIF, WebP | `input_images` [source, reference], the instruction and the prompt, `aspect_ratio: 'match_input_image'`, `seed`, `output_format` and `output_quality` from `providerOptions.replicate` | `strength` as a value, `negativePrompt`, `size` |
| Fal | `fal-ai/flux-2-pro/edit`, `flux-2-max/edit`, `flux-2-flex/edit`, `flux-2/edit` (a name without `/edit` gets it) | JPEG, PNG, WebP | `image_urls` [source, reference], the instruction and the prompt, `seed` | `strength` as a value, `negativePrompt`, `size`, `output_format`: each endpoint's defaults apply (`auto` and JPEG on pro, max and flex; PNG on `flux-2/edit`) |
| Stability | the style-transfer endpoint (`/v2beta/stable-image/control/style-transfer`) | JPEG, PNG, WebP | `init_image` (source), `style_image` (reference), `prompt`, `negative_prompt`, `seed`, `style_strength`, `composition_fidelity` and `change_strength` from `providerOptions.stability` (`compositionFidelity`, `changeStrength`), `output_format` | `size`, a model |
| OpenAI | the GPT Image models (`gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`, `chatgpt-image-latest` and their dated snapshots) | PNG, WebP, JPEG | two `image[]` parts on `/images/edits`, source first, the instruction and the prompt, `model`, `size` | `strength` as a value, `negativePrompt`, `seed` |

Stability's answer is one image of 1 MP at the source's aspect ratio, at 8 credits.

Refused before the request:

- A model outside the provider's list. On a custom endpoint (a base URL that is not the provider's own), OpenAI and Fal take any name and Replicate any `owner/name`. Stability's endpoint takes no model, so it refuses every name but `stable-image-style-transfer`, on any endpoint. Replicate refuses a pinned version (`owner/name:version`) on any endpoint.
- A provider without a two-image call, before its key or base URL is looked for.
- An image whose format the provider does not take, and bytes that are not a JPEG, PNG, WebP or GIF image.
- On Replicate, a `providerOptions.input` that sets `prompt`, `input_images`, `image` or `input_image`, and any `providerOptions.extraBody`: the call sends its own prompt and its two images.
- Stability: a request over 10 MiB, a prompt or negative prompt over 10,000 characters, a seed outside 0 to 4,294,967,294, `compositionFidelity` outside 0 to 1, `changeStrength` outside 0.1 to 1.
- OpenAI: an image of 50 MB or more, and a prompt over 32,000 characters with the instruction.

The limits that need an image's dimensions are left to the provider, which refuses before it bills: Stability's 64 to 16,383 pixels a side, 4,096 to 9,437,184 pixels and aspect 1:2.5 to 2.5:1, and Replicate's 9 megapixels in all.

## Strength

On Stability, `strength` is sent as `style_strength`: 0 leaves the source as it is, 1 applies the reference fully.

OpenAI and FLUX.2 take no strength. They are sent an instruction that names the two images (`image 1` and `image 2` for FLUX.2, `the first image` and `the second image` for OpenAI), then the prompt:

- below 0.5: *Restyle image 1 lightly after image 2: keep image 1's subject, composition, pose and most of its own colours, and take image 2's texture, brushwork and lighting.*
- from 0.5: *Restyle image 1 in the style of image 2: keep image 1's subject, composition and pose, and take image 2's palette, brushwork, texture, lighting and medium.*

So on those models `strength` chooses between two instructions, and 0 still restyles.

## Examples

```typescript
// Photograph to anime, on Stability's style-transfer endpoint
const anime = await transferStyle({
  provider: 'stability',
  image: './portrait-photo.jpg',
  styleReference: './anime-frame.png',
  prompt: 'Anime illustration, cel shading, vibrant colors',
  strength: 0.75,
  providerOptions: { stability: { compositionFidelity: 0.95 } },
});

// A landscape in a pixel-art reference's look, on FLUX.2 Max
const pixelArt = await transferStyle({
  provider: 'replicate',
  model: 'black-forest-labs/flux-2-max',
  image: './landscape.jpg',
  styleReference: './pixel-art-reference.png',
  prompt: '16-bit pixel art, limited palette',
});
```

## Related

- [Image Generation](./IMAGE_GENERATION.md) — Text-to-image generation
- [Image Editing](./IMAGE_EDITING.md) — Img2img, inpainting, upscaling, variations
- [Character Consistency](./CHARACTER_CONSISTENCY.md) — Face-preserving generation
