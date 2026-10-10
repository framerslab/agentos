# Vision Pipeline: OCR, Image Understanding and Embeddings

[`VisionPipeline`](https://github.com/framerslab/agentos/blob/master/src/io/vision/VisionPipeline.ts) runs an image through up to five tiers: OCR (PaddleOCR or Tesseract.js), handwriting recognition (TrOCR), document layout (Florence-2), a cloud vision model called through `generateText()`, and an image embedding (CLIP). [`createVisionPipeline()`](https://github.com/framerslab/agentos/blob/master/src/io/vision/index.ts) builds a pipeline from the packages installed and the API keys in the environment.

Every tier runs against the current releases of the packages it names: `ppu-paddle-ocr` 6.6.1, `tesseract.js` 7.0.0 and `@huggingface/transformers` 3.8.1. [Limitations](#limitations) lists what the pipeline does not do.

---

## Quick Start

```typescript
import { createVisionPipeline } from '@framers/agentos';
import { readFileSync } from 'node:fs';

// Needs an OCR package (npm install tesseract.js) for 'progressive'.
const vision = await createVisionPipeline({ strategy: 'progressive' });

const result = await vision.process(readFileSync('./document.png'));
console.log(result.text);        // text of the tier with the highest confidence
console.log(result.confidence);  // that tier's confidence, 0-1
console.log(result.category);    // 'printed-text' | 'handwritten' | 'document-layout' | 'photograph' | 'mixed' | ...
console.log(result.tiers);       // tiers that ran, e.g. ['ocr', 'cloud-vision']
console.log(result.tierResults); // each tier's text, confidence and duration

await vision.dispose();
```

The other methods each run one tier:

```typescript
const text = await vision.extractText(image);      // OCR tier, returns a string
const layout = await vision.analyzeLayout(image);  // Florence-2 tier, returns a DocumentLayout
const vector = await vision.embed(image);          // CLIP tier, returns number[]

// Cloud tier only: a description of the image plus the text it shows.
const described = await vision.process(image, { tiers: ['cloud-vision'] });
```

`image` is a `Buffer`, a file path, an `http(s)` URL or a data URL. Preprocessing applies to a `Buffer` only. A file path works for the local tiers only: the cloud tier sends a string to the provider as the image URL, and a provider cannot read a path on your machine. Pass a local file as a `Buffer` when the cloud tier can run. The local tiers fetch an `http(s)` URL string themselves, and nothing checks where it points: for a URL from a model or a user, read it with `imageToBuffer(url, { untrusted: true })` (see [Image Editing](./IMAGE_EDITING.md)) and pass the `Buffer`.

---

## Tiers

| Tier (`VisionTier`) | What runs | Needs | Confidence it reports |
|---|---|---|---|
| `ocr` | PaddleOCR (`ppu-paddle-ocr`) or Tesseract.js (`tesseract.js`, English), per the `ocr` option | the package | PaddleOCR: the mean of the region confidences. Tesseract.js: the page confidence divided by 100 |
| `handwriting` | TrOCR, `Xenova/trocr-base-handwritten` (Microsoft's checkpoint converted to ONNX), Transformers.js `image-to-text` task | `@huggingface/transformers` and `handwriting: true` | 0.75 when it returns text, else 0 |
| `document-ai` | Florence-2, `onnx-community/Florence-2-base-ft`, loaded as a model and a processor and run with the `<OCR_WITH_REGION>` task | `@huggingface/transformers` and `documentAI: true` | 0.8 when it returns text, else 0 |
| `cloud-vision` | `generateText()` with the image and a fixed prompt: describe the image, extract all visible text, name the kind of content | `cloudProvider` | 0.95, fixed |
| `embedding` | CLIP, `Xenova/clip-vit-base-patch32`, Transformers.js `image-feature-extraction` task: 512 numbers in the space of CLIP's text embeddings | `@huggingface/transformers` and `embedding: true` | none; fills `result.embedding` |

`result.text` and `result.confidence` come from the tier with the highest confidence, so a cloud result (0.95) wins over every local tier that ran. `result.regions` holds that tier's text regions. The Florence-2 tier reads the image line by line: `result.layout` holds one page the size of the image, with a `text` block for each line and the line's bounding box in the image's pixels, and the tier's text is the lines in reading order. It does not label headings, tables or figures.

A tier that was due to run and failed, such as an OCR engine that could not start or a model that did not load, is left out of `result.tiers` and listed in `result.failedTiers` with its error, and the run goes on with the other tiers: an OCR failure leaves the category `mixed`, so both model tiers run, and the cloud tier after them as the strategy allows. `process()` throws only when no tier gave a result, naming each failure. `dispose()` waits for calls in progress, and concurrent first calls share one load of each engine.

Each local model tier downloads its model from the Hugging Face Hub on first use and caches it: about 1.3 GB for TrOCR, 1.1 GB for Florence-2 and 350 MB for CLIP's vision tower, in fp32, the precision Transformers.js loads by default in Node. The [Vision models](https://github.com/framerslab/agentos/blob/master/.github/workflows/vision-models.yml) CI job runs the three tiers from the built package against these models every week and on every change to the vision code.

The cloud tier sends a `Buffer` as a data URL whose media type comes from the image's first bytes (PNG, JPEG, GIF or WebP); a string goes to the provider as given.

---

## Strategies

| Strategy | `ocr` | `handwriting`, `document-ai` | `cloud-vision` | `embedding` |
|---|---|---|---|---|
| `progressive` (default) | always | when the OCR confidence is below the threshold and the category calls for the tier | when the best local confidence is below the threshold | when enabled |
| `local-only` | always | when the category calls for the tier | never | when enabled |
| `cloud-only` | never | never | always | when enabled |
| `parallel` | always | when the category calls for the tier | always | when enabled |

- The threshold is `confidenceThreshold`, default `0.7`. In `progressive`, an OCR result at or above it ends the run.
- The text tiers run one after another. Only the embedding tier runs alongside them. `parallel` runs the `local-only` sequence and then the cloud tier.
- The cloud tier runs only when `cloudProvider` is set; `cloud-only` without one throws.
- The handwriting tier runs for the categories `handwritten` and `mixed`; the document tier for `document-layout` and `mixed`.
- A handwriting, document or embedding tier that fails is skipped. A cloud tier that fails is skipped when a local tier produced a result; otherwise `process()` throws, as it does when the OCR tier fails.

`process(image, { tiers: [...] })` runs the listed tiers instead of the strategy's sequence, whatever the `handwriting`, `documentAI` and `embedding` flags say; the handwriting and document tiers still need a matching category.

---

## Content Category

The category comes from the OCR result, checked in this order:

| Condition | Category |
|---|---|
| no OCR result | `mixed` |
| confidence above 0.85 | `printed-text` |
| confidence below 0.5 and at least one single-character region | `handwritten` |
| more than 20 regions | `document-layout` |
| confidence below 0.6 and fewer than 5 regions | `photograph` |
| anything else | `mixed` |

`diagram` and `screenshot` are never detected; they come only from `forceCategory`:

```typescript
const result = await vision.process(image, { forceCategory: 'handwritten' });
```

`forceCategory` sets the reported category and routes the handwriting and document tiers. In `progressive` the OCR tier still runs first, and an OCR result at or above the threshold still ends the run. To run TrOCR alone, pass `{ tiers: ['handwriting'] }`.

---

## createVisionPipeline() Options

`createVisionPipeline(config?)` takes a partial [`VisionPipelineConfig`](https://github.com/framerslab/agentos/blob/master/src/io/vision/types.ts). A field left out is filled in by detection: the optional packages installed, and the API keys in the environment. `new VisionPipeline(config)` detects nothing: its `handwriting`, `documentAI` and `embedding` default to off and its `ocr` to `'paddle'`.

```typescript
interface VisionPipelineConfig {
  /** How the tiers combine. Default: 'progressive'. */
  strategy: 'progressive' | 'local-only' | 'cloud-only' | 'parallel';

  /** OCR engine. Detected: 'paddle' when ppu-paddle-ocr is installed, else 'tesseract' when tesseract.js is, else 'none'. */
  ocr?: 'paddle' | 'tesseract' | 'none';

  /** TrOCR handwriting, Florence-2 document layout and CLIP embeddings. Detected: on when @huggingface/transformers is installed. */
  handwriting?: boolean;
  documentAI?: boolean;
  embedding?: boolean;

  /**
   * Cloud vision provider, a provider id generateText() knows ('openai',
   * 'anthropic', 'gemini', 'openrouter', ...). Detected: 'openai' when
   * OPENAI_API_KEY is set, else 'anthropic' (ANTHROPIC_API_KEY), else 'gemini'
   * (GEMINI_API_KEY, or GOOGLE_API_KEY, which detection passes as the key),
   * else 'openrouter' (OPENROUTER_API_KEY); unset and undetected, there is no
   * cloud tier. Gemini does not fetch image URLs, so give it a Buffer or a
   * data URL.
   */
  cloudProvider?: string;
  /** Cloud model. Default: the provider's default text model. */
  cloudModel?: string;
  /** Key for the cloud provider. Default: its environment variable (OPENAI_API_KEY and so on). */
  cloudApiKey?: string;
  /** Base URL for the cloud provider, such as a proxy. */
  cloudBaseUrl?: string;

  /** Confidence below which 'progressive' runs the next tier. Default: 0.7. */
  confidenceThreshold?: number;

  /** Applied with sharp to a Buffer before any tier runs. Without sharp installed, the image passes unchanged. */
  preprocessing?: {
    grayscale?: boolean;
    resize?: { maxWidth?: number; maxHeight?: number };  // scales down only
    sharpen?: boolean;
    normalize?: boolean;
  };
}
```

---

## VisionResult Shape

```typescript
interface VisionResult {
  text: string;                 // text of the winning tier
  confidence: number;           // confidence of the winning tier, 0-1
  category: ContentCategory;    // 'printed-text' | 'handwritten' | 'document-layout' | 'photograph' | 'diagram' | 'screenshot' | 'mixed'
  tiers: VisionTier[];          // tiers that ran: 'ocr' | 'handwriting' | 'document-ai' | 'embedding' | 'cloud-vision'
  tierResults: TierResult[];    // one entry per text tier that produced a result, in run order
  embedding?: number[];         // CLIP output, when the embedding tier ran
  layout?: DocumentLayout;      // { pages: [{ pageNumber, width, height, blocks }] }, when Florence-2 ran
  regions?: TextRegion[];       // text regions of the winning tier
  failedTiers?: FailedTier[];   // tiers that were due to run and failed, each { tier, error }; absent when none did
  durationMs: number;           // wall-clock time of process()
}

interface TierResult {
  tier: VisionTier;
  provider: string;             // 'paddle', 'tesseract', 'trocr', 'florence-2', or the cloud provider id
  text: string;
  confidence: number;
  durationMs: number;
  regions?: TextRegion[];
}

interface FailedTier {
  tier: VisionTier;
  error: string;                // the error's message
}

interface TextRegion {
  text: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
}
```

---

## Indexing Images for Retrieval

The multimodal indexer describes an image with a vision provider, embeds the description with your text embedding manager and stores it with `modality: 'image'`; `search()` embeds a text query the same way. [`createMultimodalIndexerFromResolver()`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/multimodal/createMultimodalIndexerFromResolver.ts) wraps a pipeline as that vision provider, so the indexed text is `process(image).text`.

```typescript
import { createVisionPipeline } from '@framers/agentos';
import {
  createMultimodalIndexerFromResolver,
  type IEmbeddingManager,
  type IVectorStore,
} from '@framers/agentos/cognition/rag';
import { readFileSync } from 'node:fs';

declare const embeddingManager: IEmbeddingManager; // your text embedding manager
declare const vectorStore: IVectorStore;           // your initialized vector store

const visionPipeline = await createVisionPipeline({ strategy: 'cloud-only', cloudProvider: 'openai' });
const indexer = createMultimodalIndexerFromResolver({ visionPipeline, embeddingManager, vectorStore });

await indexer.indexImage({ image: readFileSync('./receipt.jpg'), metadata: { source: 'upload' } });
const hits = await indexer.search('receipt total');
```

Pass the pipeline through this factory (or as `visionProvider: new PipelineVisionProvider(pipeline)`), not as `new MultimodalIndexer({ visionPipeline })`: that constructor path fails in the published ES module build. The indexer sends a `Buffer` to the pipeline as a data URL labelled `image/png`, so the pipeline skips preprocessing, and a provider that checks the label against the bytes (Anthropic does) rejects a JPEG.

`agent()` accepts a `rag` field (including `rag.multimodal.images`) and does not read it.

See [Multimodal RAG](../memory/MULTIMODAL_RAG.md) for the indexing design.

---

## Installation

```bash
npm install tesseract.js     # OCR tier, or ppu-paddle-ocr (with onnxruntime-node), which detection prefers
npm install sharp            # only for preprocessing
```

`@huggingface/transformers` is an optional dependency of `@framers/agentos` and installs with it unless optional dependencies are skipped. Transformers.js downloads model weights from the Hugging Face Hub the first time a tier loads them.

The cloud tier reads the provider's key from its environment variable: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (with `cloudProvider: 'gemini'`) or `OPENROUTER_API_KEY`, unless `cloudApiKey` is set.

---

## Limitations

- **No OCR package.** `createVisionPipeline()` then sets `ocr: 'none'`: `process()` skips the OCR tier and goes on to the model and cloud tiers, while `extractText()` and a `process(image, { tiers })` call whose list names only `'ocr'` throw `OCR is set to "none" but OCR tier was requested.`
- **Layout labels.** The Florence-2 tier gives every line as a `text` block; it does not label headings, tables, figures, lists or code.
- **CLIP text.** The pipeline embeds images only; it has no method that embeds text into the CLIP space.

---

## Related Documentation

- [Image Generation](./IMAGE_GENERATION.md): generate images from text
- [Image Editing](./IMAGE_EDITING.md): edit, upscale and vary images
- [Image Segmentation](./IMAGE_SEGMENTATION.md): pixel masks via SAM2 / GroundedSAM
- [Multimodal RAG](../memory/MULTIMODAL_RAG.md): image and audio retrieval
- [High-Level API](../getting-started/HIGH_LEVEL_API.md): API reference
