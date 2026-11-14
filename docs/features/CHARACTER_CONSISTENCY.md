# Character Consistency — Face-Preserving Image Generation

> Generate images that maintain a consistent character identity across multiple outputs using reference images and face embeddings.

---

## Overview

Character consistency lets you anchor generated images to a reference face or character, ensuring the same person appears across portraits, expressions, full-body shots, and scene illustrations. AgentOS supports three levels of consistency via the `consistencyMode` parameter:

| Mode | Strength | Use Case |
|------|----------|----------|
| `'strict'` | 0.85–0.9 | Avatar expression sheets, emotion variants. Face must match exactly. |
| `'balanced'` | 0.6 | Full-body shots, different angles. Recognizable but allows natural variation. |
| `'loose'` | 0.3 | "Inspired by" generations. Style/mood carries over, face may drift. |

## Provider Support

| Provider | Mechanism | Models |
|----------|-----------|--------|
| **Replicate** | Pulid (strict, when no model is set), Flux image input with `image_strength` (balanced/loose); Flux 2 and Kontext models take the reference as their input image | `zsxkib/pulid` (pinned version), `black-forest-labs/flux-dev` |
| **Fal** | IP-Adapter (`ip_adapter_scale` 0.9 / 0.6 / 0.3); Flux 2 models use their `/edit` endpoint and Kontext models their `image_url` | `fal-ai/flux/dev` |
| **SD-Local** | ControlNet + IP-Adapter extension | Any SD 1.5 / SDXL checkpoint |
| OpenAI | Not supported: the reference is ignored, with a `console.debug` note | — |
| Stability | Not supported: the reference is ignored, with a `console.debug` note | — |

## Basic Usage

```typescript
import { generateImage } from '@framers/agentos';

// Generate a consistent expression variant
const result = await generateImage({
  provider: 'replicate',
  prompt: 'Portrait of the character smiling warmly, soft lighting',
  referenceImageUrl: 'https://storage.example.com/character-neutral.png',
  consistencyMode: 'strict',
});
```

When `consistencyMode` is `'strict'` and no model is explicitly set, Replicate selects a pinned version of `zsxkib/pulid`. Without `consistencyMode`, the mode is `'balanced'`.

## Fields Reference

### `referenceImageUrl`

URL or base64 data URI of the reference character image. Each provider maps this to its native mechanism:

- **Replicate (Pulid):** `main_face_image` input
- **Replicate (standard Flux):** `image` input with `image_strength`
- **Replicate (Flux 2 / Kontext):** `input_images` / `input_image`
- **Fal:** `ip_adapter_image` body field (`image_urls` on Flux 2 `/edit`, `image_url` on Kontext)
- **SD-Local:** ControlNet `input_image` with IP-Adapter preprocessor

### `faceEmbedding`

Optional 512-dimensional vector from InsightFace or equivalent. `generateImage()` passes it to the provider request, and no built-in provider reads it. Drift detection is done by [`AvatarPipeline`](https://github.com/framerslab/agentos/blob/master/src/io/media/avatar/AvatarPipeline.ts): it computes the anchor embedding from the neutral portrait at its `face_embedding` stage, compares each expression-sheet and additional-angle image with it by cosine similarity, and draws an image below `driftGuard.faceSimilarity` (default 0.6) again, up to `driftGuard.maxRegenerationAttempts` draws in all (default 3). A request's `acceptanceCheck` replaces this check, and then no embedding is computed ([Caller-owned checks, emotions and angles](#caller-owned-checks-emotions-and-angles)).

### `consistencyMode`

Controls how aggressively the provider preserves the reference identity:

```typescript
// Strict — for expression sheets where faces must match
await generateImage({
  prompt: 'Character looking angry, dramatic lighting',
  referenceImageUrl: neutralPortrait,
  consistencyMode: 'strict',  // Pulid auto-selected on Replicate
});

// Balanced — for full-body shots
await generateImage({
  prompt: 'Full body shot of the character walking through a market',
  referenceImageUrl: neutralPortrait,
  consistencyMode: 'balanced',
});

// Loose — for "inspired by" mood pieces
await generateImage({
  prompt: 'Abstract portrait in the style of the character',
  referenceImageUrl: neutralPortrait,
  consistencyMode: 'loose',
});
```

## AvatarPipeline Integration

The [`AvatarPipeline`](https://github.com/framerslab/agentos/blob/master/src/io/media/avatar/AvatarPipeline.ts) uses consistency modes per stage:

| Stage | Mode | What it does |
|-------|------|--------------|
| `neutral_portrait` | none | Generates the anchor portrait |
| `face_embedding` | none | Extracts the anchor embedding from the portrait |
| `expression_sheet` | `'strict'` | One image per emotion with the portrait as reference, drift-checked and regenerated |
| `animated_emotes` | none | One image per emotion from the prompt alone, with no reference image and no drift check |
| `full_body` | `'balanced'` | One image with the portrait as reference, not drift-checked |
| `additional_angles` | `'balanced'` | One image per angle with the portrait as reference, drift-checked and regenerated |

Without `stages`, the pipeline runs the first five. `additional_angles` runs only when `stages` names it.

```typescript
import { AvatarPipeline } from '@framers/agentos/io/media/avatar';

const pipeline = new AvatarPipeline(faceService, imageGenerator);
const result = await pipeline.generate({
  characterId: 'hero_001',
  identity: {
    displayName: 'Kael Stormwind',
    ageBand: 'young_adult',
    faceDescriptor: 'sharp jawline, green eyes, short dark hair, small scar above left eyebrow',
  },
  generationConfig: {
    baseModel: 'black-forest-labs/flux-dev',
    provider: 'replicate',
  },
  stages: ['neutral_portrait', 'face_embedding', 'expression_sheet', 'full_body'],
});
```

### Caller-owned checks, emotions and angles

```typescript
const result = await pipeline.generate({
  characterId: 'hero_001',
  identity,
  generationConfig: { baseModel: 'black-forest-labs/flux-dev', provider: 'replicate' },
  stages: ['neutral_portrait', 'expression_sheet', 'additional_angles'],
  emotions: ['neutral', 'happy', 'determined'],
  angles: ['side view, facing left', 'from behind, full figure'],
  driftGuard: { maxRegenerationAttempts: 2 },
  acceptanceCheck: async ({ referenceUrl, candidateUrl, stage, label, attempt }) => {
    const sameCharacter = await myJudge(referenceUrl, candidateUrl);
    return sameCharacter ? { accepted: true } : { accepted: false, reason: 'a different face' };
  },
});
```

- `acceptanceCheck` replaces the embedding drift check. It runs on every image drawn against the portrait: the expression sheet, the additional angles and the full-body image (the portrait itself and the animated emotes are not checked). The pipeline then extracts and compares no face embedding: the `face_embedding` stage is recorded as `skipped` and the result has no `driftReport`. A refused image is drawn again, up to `driftGuard.maxRegenerationAttempts` draws in all (the first included; 0 counts as 1); when every attempt is refused, that job alone fails with the check's last `reason` and its image is left out of the identity package, while the other jobs go on. A check that throws fails its job with the error's message, and the job keeps the draws made in `attempts` and the check's last verdict. The identity package's `driftGuard` records the attempt limit drawn under, 1 for a value below 1 or NaN. An emotion in `emotions` is a key of its own in `expressionSheet` and `animatedEmotes`, `__proto__` included. Each job's `acceptance` holds the check's last verdict.
- `emotions` replaces the default emotion set (`AVATAR_EMOTIONS`: neutral, happy, sad, angry, surprised, flirty, fearful) for the expression sheet and the animated emotes. An emotion left out of the list is never drawn, a repeated one is drawn once, and `neutral` in the expression sheet reuses the portrait.
- `angles` replaces the default viewpoints (`AVATAR_ANGLES`: three-quarter view, profile view). Each angle's words are appended to the portrait prompt as written. `anchors.additionalAngles` lists the accepted images in the order of `angles`, and each job's label, `angle:<words>`, names the angle it drew.
- Every call to the image generator carries `stage` and `label` in its options (`expression_sheet` and `expression:happy`, for example), so one generator function can route each stage to its own provider or model and account for each image.
- Every call for an image the pipeline may draw again (the expression sheet, the additional angles, and the full-body image under an acceptance check) also carries `attempt`, starting at 1. A generator that sends a fixed `seed` varies it by `attempt` (`seed + attempt - 1`, for example); with the same seed and the same inputs, a provider returns the refused image again on every redraw.

## Choosing the Right Mode

- **Avatars and expression sheets:** Always `'strict'`. The face is the product.
- **Scene illustrations with known characters:** `'balanced'`. Character should be recognizable but the scene composition matters more.
- **Style exploration and mood boards:** `'loose'`. The reference influences the vibe, not the pixels.
- **No reference at all:** Omit `referenceImageUrl` entirely. The fields are fully optional.

## Related

- [Image Generation](./IMAGE_GENERATION.md) — Provider-agnostic generation API
- [Style Transfer](./STYLE_TRANSFER.md) — Transfer visual aesthetics between images
- [Image Editing](./IMAGE_EDITING.md) — Img2img, inpainting, upscaling
