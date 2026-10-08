# Image Segmentation — Promptable Masks via SAM2 & GroundedSAM

> Turn an image plus a prompt (text, point, box, or "segment everything") into
> pixel masks, hosted through Replicate. Masks drop straight into image editing
> and CLIP region search.

---

## Table of Contents

1. [Overview](#overview)
2. [segment() API](#segment-api)
3. [Prompt Modes](#prompt-modes)
4. [Result Shape](#result-shape)
5. [Provider Setup](#provider-setup)
6. [Consumer Round-Trips](#consumer-round-trips)
7. [Errors](#errors)
8. [Scope](#scope)

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

## Errors

| Error | When |
|-------|------|
| `InvalidSegmentationPromptError` | Zero or more than one prompt mode supplied |
| `SegmentationModeNotSupportedError` | The provider does not support the resolved mode |
| [`SegmentationProviderError`](https://github.com/framerslab/agentos/blob/master/src/io/segmentation/errors.ts) | Provider/network failure (`code: 'provider_failed'`), poll timeout (`code: 'timeout'`), or malformed model id (`code: 'invalid_request'`) |

---

## Scope

Included: the hosted Replicate provider, with **text** (GroundedSAM) and **automatic**
(SAM2) prompts, plus the `maskToEditMask` and `cropRegion` bridges.

Not in this surface: coordinate (point/box) prompting, which needs a
coordinate-capable provider; a local/offline SAM provider; in-browser WebGPU
segmentation; and video / cross-frame tracking.

---

## Related Documentation

- [Image Editing](./IMAGE_EDITING.md) — consumes segmentation masks for inpainting
- [Vision Pipeline](./VISION_PIPELINE.md) — OCR, layout, and CLIP embeddings
- [Image Generation](./IMAGE_GENERATION.md) — provider-agnostic generation
