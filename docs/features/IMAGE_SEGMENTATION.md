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
prompt, runs the appropriate model, and returns one `SegmentMask` per detected
region. Geometric prompts (point, box, automatic) route to SAM2; open-vocabulary
text prompts route to a GroundedSAM chain.

| Capability | Description |
|------------|-------------|
| **Text prompt** | "the chimney" → masks for matching regions (GroundedSAM) |
| **Point prompt** | Foreground/background clicks → a mask for the indicated object |
| **Box prompt** | A bounding box → the tight mask inside it |
| **Automatic** | "Segment everything" → masks for every salient region |
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

`SegmentOptions`:

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
`InvalidSegmentationPromptError`.

---

## Prompt Modes

```typescript
// Text (open vocabulary)
await segment({ image, prompt: 'all the windows' });

// Point — foreground click at (320, 210)
await segment({ image, points: [{ x: 320, y: 210, label: 'foreground' }] });

// Box
await segment({ image, box: { x: 40, y: 40, width: 200, height: 160 } });

// Automatic — every salient region, capped at 10
await segment({ image, automatic: true, maxMasks: 10 });
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

Override the model per call or via provider options:

```typescript
await segment({
  image,
  box: { x: 0, y: 0, width: 256, height: 256 },
  model: 'meta/sam-2',
  providerOptions: { replicate: { pollIntervalMs: 1000, timeoutMs: 120000 } },
});
```

Custom backends implement `ISegmentationProvider` and register via
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
const vision = await createVisionPipeline({ strategy: 'local-only', tier1: { enableCLIP: true } });

for (const m of masks) {
  const cutout = await cropRegion(image, m);     // transparent PNG of just that object
  const { embedding } = await vision.embed(cutout);
  // upsert `embedding` into a vector store for "find similar region" search
}
```

---

## Errors

| Error | When |
|-------|------|
| `InvalidSegmentationPromptError` | Zero or more than one prompt mode supplied |
| `SegmentationModeNotSupportedError` | The provider does not support the resolved mode |
| `SegmentationProviderError` | Provider/network failure (`code: 'provider_failed'`) or poll timeout (`code: 'timeout'`) |

---

## Scope

Shipped: hosted Replicate provider (SAM2 + GroundedSAM), the four prompt modes,
and the two consumer bridges.

Not in this surface: a local/offline SAM provider, in-browser WebGPU
segmentation, and video / cross-frame tracking.

---

## Related Documentation

- [Image Editing](./IMAGE_EDITING.md) — consumes segmentation masks for inpainting
- [Vision Pipeline](./VISION_PIPELINE.md) — OCR, layout, and CLIP embeddings
- [Image Generation](./IMAGE_GENERATION.md) — provider-agnostic generation
