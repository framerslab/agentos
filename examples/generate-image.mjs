#!/usr/bin/env node

import { generateImage } from '../dist/index.js';

const model = process.env.AGENTOS_IMAGE_MODEL || 'openai:gpt-image-2.5-flare';

async function main() {
  console.log(`Using image model: ${model}`);

  const providerId = model.split(':', 1)[0];
  const result = await generateImage({
    model,
    prompt: 'A cinematic neon city skyline reflected in rain at night',
    outputFormat: 'png',
    negativePrompt: providerId === 'stability' || providerId === 'replicate'
      ? 'low detail, blurry, watermark'
      : undefined,
    providerOptions: providerId === 'stability'
      ? {
          stability: {
            stylePreset: 'photographic',
            seed: 42,
            cfgScale: 8,
          },
        }
      : providerId === 'replicate'
        ? {
            replicate: {
              outputQuality: 90,
              input: {
                go_fast: true,
              },
            },
          }
        : undefined,
  });

  console.log(`Provider: ${result.provider}`);
  console.log(`Images: ${result.images.length}`);
  if (result.text) {
    console.log(`Text: ${result.text}`);
  }

  const first = result.images[0];
  if (!first) return;

  if (first.base64) {
    console.log(`Base64 length: ${first.base64.length}`);
  } else if (first.url) {
    console.log(`URL: ${first.url}`);
  } else if (first.dataUrl) {
    console.log(`Data URL prefix: ${first.dataUrl.slice(0, 64)}...`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
