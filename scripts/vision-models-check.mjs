/**
 * Runs the vision pipeline's local tiers end to end from the built package:
 * PaddleOCR and Tesseract.js read an invoice, TrOCR reads a handwritten line,
 * Florence-2 reads the invoice line by line with each line's box, and CLIP
 * embeds two images. Each model tier loads the Hugging Face Hub model it
 * names, about 3 GB in all, so this runs in a CI job of its own
 * (.github/workflows/vision-models.yml): the unit suite mocks the OCR
 * packages and transformers.js, and a result shape or a model id the code
 * does not match shows up only here.
 *
 * Usage, after `pnpm run build`: node scripts/vision-models-check.mjs
 */
import assert from 'node:assert/strict';

import { VisionPipeline } from '../dist/io/vision/index.js';

/** The sample images of the transformers.js documentation. */
const SAMPLES = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main';

/** The bytes of a sample image. */
async function sample(name) {
  const response = await fetch(`${SAMPLES}/${name}`);
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The cosine similarity of two vectors of the same length. */
function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / Math.sqrt(normA * normB);
}

/** Runs `step`, printing how long it took. */
async function timed(name, step) {
  const start = Date.now();
  const result = await step();
  console.log(`${name}: ${((Date.now() - start) / 1000).toFixed(1)} s`);
  return result;
}

const pipeline = new VisionPipeline({
  strategy: 'local-only',
  ocr: 'none',
  handwriting: true,
  documentAI: true,
  embedding: true,
});

try {
  // OCR: each engine reads the invoice, with a box for every region.
  const invoice = await sample('invoice.png');
  for (const ocr of ['paddle', 'tesseract']) {
    const reader = new VisionPipeline({ strategy: 'local-only', ocr });
    try {
      const result = await timed(`ocr (${ocr})`, () => reader.process(invoice, { tiers: ['ocr'] }));
      const regions = result.regions ?? [];
      console.log(`  ${regions.length} regions, confidence ${result.confidence.toFixed(2)}; text:`, JSON.stringify(result.text.slice(0, 120)));
      assert.match(result.text, /invoice/i);
      assert.ok(result.confidence > 0.5, `confidence ${result.confidence}`);
      assert.ok(regions.length >= 3, `${regions.length} regions`);
      for (const region of regions) {
        assert.ok(region.bbox.width > 0 && region.bbox.height > 0, `a region with a box: ${JSON.stringify(region)}`);
      }
    } finally {
      await reader.dispose();
    }
  }

  // TrOCR. The transformers.js documentation gives this line's text as
  // "Mr. Brown commented icily."
  const handwriting = await sample('handwriting.jpg');
  const read = await timed('handwriting', () =>
    pipeline.process(handwriting, { tiers: ['handwriting'], forceCategory: 'handwritten' }),
  );
  console.log('  text:', JSON.stringify(read.text));
  assert.equal(read.failedTiers, undefined, `a tier failed: ${JSON.stringify(read.failedTiers)}`);
  assert.deepEqual(read.tiers, ['handwriting']);
  assert.match(read.text, /brown/i);

  // Florence-2: the invoice's lines, each with a box inside the page.
  const layout = await timed('layout', () => pipeline.analyzeLayout(invoice));
  const [page] = layout.pages;
  console.log(`  ${page.blocks.length} lines on a ${page.width} x ${page.height} page; the first:`);
  for (const block of page.blocks.slice(0, 5)) console.log('   ', JSON.stringify(block.content), JSON.stringify(block.bbox));
  assert.equal(layout.pages.length, 1);
  assert.ok(page.width > 0 && page.height > 0, 'the page has a size');
  assert.ok(page.blocks.length >= 3, `${page.blocks.length} lines`);
  for (const block of page.blocks) {
    const { x, y, width, height } = block.bbox;
    assert.equal(block.type, 'text');
    assert.ok(
      width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= page.width + 1 && y + height <= page.height + 1,
      `a box inside the page: ${JSON.stringify(block)}`,
    );
  }
  assert.match(page.blocks.map((block) => block.content).join('\n'), /invoice/i);

  // CLIP: 512 finite numbers per image, and two unlike images unlike each other.
  const cats = await sample('cats.jpg');
  const catsEmbedding = await timed('embedding', () => pipeline.embed(cats));
  const handwritingEmbedding = await pipeline.embed(handwriting);
  for (const embedding of [catsEmbedding, handwritingEmbedding]) {
    assert.equal(embedding.length, 512);
    assert.ok(embedding.every(Number.isFinite), 'every number is finite');
  }
  const similarity = cosine(catsEmbedding, handwritingEmbedding);
  console.log(`  cosine(cats, handwriting) = ${similarity.toFixed(3)}`);
  assert.ok(similarity < 0.95, `two unlike images embed apart: ${similarity}`);

  console.log('The OCR, handwriting, layout and embedding tiers run.');
} finally {
  await pipeline.dispose();
}
