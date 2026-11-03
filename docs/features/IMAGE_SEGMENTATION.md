# Image Segmentation — Promptable Masks via SAM2 & GroundedSAM, Background Removal via BiRefNet

> Turn an image plus a prompt (text, point, box, or "segment everything") into
> pixel masks, hosted through Replicate. Masks drop straight into image editing
> and CLIP region search. `removeBackground()` cuts the subject out of an image
> onto a transparent PNG, hosted through fal's BiRefNet.

---

## Table of Contents

1. [Overview](#overview)
2. [segment() API](#segment-api)
3. [Prompt Modes](#prompt-modes)
4. [Result Shape](#result-shape)
5. [Provider Setup](#provider-setup)
6. [Consumer Round-Trips](#consumer-round-trips)
7. [Background Removal](#background-removal)
8. [Errors](#errors)
9. [Scope](#scope)

---

## Overview

`segment()` is a provider-agnostic factory. It accepts an image and exactly one
prompt, runs the appropriate model, and returns one [`SegmentMask`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/types.ts) per detected
region. Geometric prompts (point, box, automatic) route to SAM2; open-vocabulary
text prompts route to a GroundedSAM chain.

| Capability | Description |
|------------|-------------|
| **Text prompt** | "the chimney" → masks for matching regions (hosted GroundedSAM) |
| **Automatic** | "Segment everything" → masks for every salient region (hosted SAM2) |
| **Point prompt** | Foreground/background clicks (needs a coordinate-capable provider) |
| **Box prompt** | A bounding box → the tight mask inside it (needs a coordinate-capable provider) |
| **Mask convention** | White = object, black = background (drops into `editImage`) |

---

## segment() API

```typescript
import { segment } from '@framers/agentos';

const result = await segment({
  image: imageBuffer,           // Buffer | Uint8Array | file path
  prompt: 'the leather sofa',   // exactly one prompt mode
});

for (const m of result.masks) {
  console.log(m.bbox, m.score, m.label);
}
```

[`SegmentOptions`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/types.ts):

```typescript
interface SegmentOptions {
  image: Buffer | Uint8Array | string;
  provider?: 'replicate' | string;   // default 'replicate'
  model?: string;

  // exactly one prompt mode per call:
  prompt?: string;                                   // text -> GroundedSAM
  points?: Array<{ x: number; y: number; label?: 'foreground' | 'background' }>;
  box?: { x: number; y: number; width: number; height: number };
  automatic?: boolean;                               // "segment everything"

  maxMasks?: number;     // cap on returned masks (automatic/text can produce many)
  minScore?: number;     // confidence floor
  providerOptions?: Record<string, unknown>;
  userId?: string;
}
```

Exactly one prompt mode must be set. Setting zero or more than one throws
[`InvalidSegmentationPromptError`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/errors.ts).

---

## Prompt Modes

The hosted Replicate provider supports **text** (GroundedSAM) and **automatic**
(SAM2 "segment everything"). **Point** and **box** prompts are part of the API
surface for a coordinate-capable provider registered with
`registerSegmentationProvider()`; the Replicate provider throws [`SegmentationModeNotSupportedError`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/errors.ts) for them.

```typescript
// Text (open vocabulary) — GroundedSAM
await segment({ image, prompt: 'all the windows' });

// Automatic — every salient region, capped at 10 — SAM2
await segment({ image, automatic: true, maxMasks: 10 });

// Point / box — require a coordinate-capable provider (not hosted Replicate)
await segment({ image, points: [{ x: 320, y: 210, label: 'foreground' }] });
await segment({ image, box: { x: 40, y: 40, width: 200, height: 160 } });
```

---

## Result Shape

```typescript
interface SegmentMask {
  mask: Buffer;        // PNG; white = object, black = background
  bbox: { x: number; y: number; width: number; height: number };
  score: number;       // 0–1
  label?: string;      // grounding phrase for text prompts
  index: number;
}

interface SegmentationResult {
  masks: SegmentMask[];
  width: number;       // source image dimensions
  height: number;
  providerId: string;
  modelId: string;
  promptMode: 'text' | 'points' | 'box' | 'automatic';
  usage?: { totalMasks: number; totalCostUSD?: number };
  durationMs: number;
}
```

An empty `masks` array is a valid (non-error) result — nothing matched the
prompt or cleared `minScore`.

---

## Provider Setup

The Replicate provider reads `REPLICATE_API_TOKEN` from the environment.

```bash
export REPLICATE_API_TOKEN=r8_...
```

Defaults: text prompts use `schananas/grounded_sam`; automatic uses `meta/sam-2`.
Override per call or via provider options:

```typescript
await segment({
  image,
  automatic: true,
  model: 'meta/sam-2',
  providerOptions: { replicate: { pollIntervalMs: 1000, timeoutMs: 120000, input: { points_per_side: 32 } } },
});
```

Custom backends implement [`ISegmentationProvider`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/types.ts) and register via
`registerSegmentationProvider(id, provider)`.

---

## Consumer Round-Trips

Masks feed two existing AgentOS surfaces.

**Mask-guided editing** — replace the segmented region with `editImage`:

```typescript
import { segment, maskToEditMask, editImage } from '@framers/agentos';

const { masks } = await segment({ image, prompt: 'the floor' });
const mask = await maskToEditMask(masks, { target: 'object' });
const edited = await editImage({ image, mask, mode: 'inpaint', prompt: 'oak parquet flooring' });
```

`maskToEditMask` accepts one mask or many (unioned). `target: 'background'`
inverts so everything except the object is edited.

**Region cutout and search** — alpha-cut a sprite, then CLIP-embed it:

```typescript
import { segment, cropRegion, createVisionPipeline } from '@framers/agentos';

const { masks } = await segment({ image, automatic: true });
const vision = await createVisionPipeline({ strategy: 'local-only', embedding: true });

for (const m of masks) {
  const cutout = await cropRegion(image, m);     // transparent PNG of just that object
  const embedding = await vision.embed(cutout);  // number[]
  // upsert `embedding` into a vector store for "find similar region" search
}
```

---

## Background Removal

`removeBackground()` returns the subject of an image on a transparent
background. The built-in provider runs fal's BiRefNet v2 endpoint,
`fal-ai/birefnet/v2`, through fal's synchronous API: one
`POST https://fal.run/fal-ai/birefnet/v2`, answered with the cut-out.

```typescript
import fs from 'node:fs';
import { removeBackground } from '@framers/agentos';

// The cut-out's URL on fal's storage.
const { image } = await removeBackground({ image: 'https://example.com/hero.png' });
console.log(image.url, image.mimeType, image.width, image.height);

// The cut-out's bytes, and the matte used for the cut.
const { image: cut, mask } = await removeBackground({
  image: fs.readFileSync('hero.jpg'),
  output: 'buffer',
  returnMask: true,
});
fs.writeFileSync('hero-cut.png', cut.buffer!);
```

[`RemoveBackgroundOptions`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/types.ts):

```typescript
interface RemoveBackgroundOptions {
  image: string | Buffer | Uint8Array; // http(s) URL or base64 image data URL, or the bytes
  provider?: 'fal' | string;           // default 'fal'
  model?: string;                      // fal endpoint, default 'fal-ai/birefnet/v2'
  output?: 'url' | 'buffer';           // default 'url'
  format?: 'png' | 'webp';             // default 'png'
  returnMask?: boolean;                // default false
  timeoutMs?: number;                  // default 60000, download included
  signal?: AbortSignal;
  apiKey?: string;                     // instead of FAL_API_KEY
  baseUrl?: string;                    // default 'https://fal.run'
  providerOptions?: {
    fal?: {
      variant?: 'General Use (Light)' | 'General Use (Light 2K)' | 'General Use (Heavy)'
        | 'Matting' | 'Portrait' | 'General Use (Dynamic)';   // default 'General Use (Light)'
      operatingResolution?: '1024x1024' | '2048x2048' | '2304x2304'; // default '1024x1024'
      refineForeground?: boolean;      // default true
      input?: Record<string, unknown>; // extra request fields, e.g. { mask_only: true }
      maxResponseBytes?: number;       // default 64 MiB, the answer and a download each
    };
  };
}
```

**The image.** An `http(s)` URL, or a base64 image data URL (standard, padded
base64) whose bytes are PNG, JPEG, WebP or GIF, goes to fal as given; fal
fetches the URL itself. Bytes go as a data URL typed by their signature (PNG,
JPEG, WebP or GIF). Any other string, a local file path, raw base64 or a data
URL whose payload is malformed or not one of those formats among them, rejects
with `code: 'invalid_request'` before a request is made: read the file and
pass its bytes.

**The output.** With `output: 'url'` the result carries the cut-out's URL on
fal's storage. With `output: 'buffer'` the call asks fal to return the image
inline (`sync_mode`, which also keeps it out of fal's request history) and the
result carries `buffer` and `dataUrl`; when fal still answers with a URL, the
file is downloaded within the same `timeoutMs`, without the API key. With
`returnMask`, an answer without the matte rejects with `provider_failed`. fal's
answer and each download are read up to `maxResponseBytes` (64 MiB by
default), and past it the call rejects with `provider_failed`.

**Extra fields.** `providerOptions.fal.input` is merged into fal's request
after the typed options, so it can set any other field of the endpoint. The
call's image, the `output_mask` that `returnMask` sends and the `sync_mode`
that `output: 'buffer'` sends stand over it.

**The variant.** `General Use (Light)` is BiRefNet's original model and the
one fal recommends for most images. `General Use (Heavy)` is slower and more
accurate; `Portrait` is trained for portrait images and `Matting` for matting;
`General Use (Dynamic)` takes resolutions from 256x256 to 2304x2304, and
`2304x2304` runs on it alone.

```typescript
interface BackgroundRemovalImage {
  url?: string;      // on the provider's storage; absent when the image came back inline
  dataUrl?: string;  // with output 'buffer'
  buffer?: Buffer;   // with output 'buffer'
  mimeType: string;  // 'image/png' or 'image/webp'
  width?: number;
  height?: number;
  fileSize?: number;
}

interface BackgroundRemovalResult {
  image: BackgroundRemovalImage;   // the subject on a transparent background
  mask?: BackgroundRemovalImage;   // with returnMask
  providerId: string;
  modelId: string;
  durationMs: number;
}
```

The fal provider reads `FAL_API_KEY`, the variable the other fal providers
read; a comma-separated list rotates. `apiKey` and `baseUrl` on the call
give it a provider of its own, never the one built from `FAL_API_KEY`; that
provider is kept for the next call with the same key and URL (the 32 most
recent), so a call's own key list rotates across calls too. fal does not retry a synchronous request,
so a caller that wants to keep the source image when the cut fails catches
the error and goes on with it.

The providers and their registry are also exported from the
`@framers/agentos/io/segmentation` subpath. Custom backends implement [`IBackgroundRemovalProvider`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/types.ts) and register via
`registerBackgroundRemovalProvider(id, provider)`; `removeBackground({ provider: id })`
then hands them the normalized request (the image as a URL or data URL, every
default filled in).

---

## Errors

| Error | When |
|-------|------|
| `InvalidSegmentationPromptError` | Zero or more than one prompt mode supplied |
| `SegmentationModeNotSupportedError` | The provider does not support the resolved mode |
| [`SegmentationProviderError`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/errors.ts) | Provider/network failure (`code: 'provider_failed'`), poll or call timeout (`code: 'timeout'`), or a request refused (`code: 'invalid_request'`): a malformed model id, an image `removeBackground()` cannot send, or fal's 400, 413 or 422 answer. A failed HTTP answer carries its `status`. |

A caller's `signal` ends `removeBackground()` with the signal's reason.

---

## Scope

Included: the hosted Replicate provider, with **text** (GroundedSAM) and **automatic**
(SAM2) prompts, plus the `maskToEditMask` and `cropRegion` bridges; and
`removeBackground()` on fal's BiRefNet v2.

Not in this surface: coordinate (point/box) prompting, which needs a
coordinate-capable provider; a local/offline SAM provider; in-browser WebGPU
segmentation; and video / cross-frame tracking.

---

## Related Documentation

- [Image Editing](./IMAGE_EDITING.md) — consumes segmentation masks for inpainting
- [Vision Pipeline](./VISION_PIPELINE.md) — OCR, layout, and CLIP embeddings
- [Image Generation](./IMAGE_GENERATION.md) — provider-agnostic generation
