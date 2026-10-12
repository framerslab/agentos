/**
 * @file styleTransfer.ts
 * What the providers' style transfers share: the prompt an editing model is
 * sent, the check of the two images' formats, and the refusal of a model a
 * provider's style transfer cannot run.
 *
 * OpenAI's edits endpoint and the FLUX.2 models change images by instruction
 * and take no strength, so a style transfer sends them an instruction that
 * names the two images, then the caller's prompt. `strength` picks the
 * instruction, as `variance` picks the prompt of OpenAI's variations: below
 * 0.5 a light restyle that keeps most of the source's own colours, otherwise
 * a full one.
 */

import { IMAGE_PART_TYPES, imagePartType, type ImagePartType } from './blobPart.js';

/** The strength a style transfer uses when the call gives none. */
export const STYLE_TRANSFER_DEFAULT_STRENGTH = 0.7;

/** How a model is told which image is which: by index for FLUX.2, in words for OpenAI. */
export interface StyleTransferImageNames {
  /** The image to restyle, sent first. */
  source: string;
  /** The image whose style is applied, sent second. */
  style: string;
}

/** FLUX.2's names: "point to other reference images by their index number" (https://replicate.com/black-forest-labs/flux-2-pro). */
export const INDEXED_IMAGE_NAMES: StyleTransferImageNames = { source: 'image 1', style: 'image 2' };

/** OpenAI's names, in the order the images are sent. */
export const ORDINAL_IMAGE_NAMES: StyleTransferImageNames = { source: 'the first image', style: 'the second image' };

/**
 * The instruction alone, for a strength from 0 to 1 (default 0.7).
 *
 * @param strength - How much of the reference's style to apply.
 * @param names - How the model is told which image is which.
 */
export function styleTransferInstruction(strength: number | undefined, names: StyleTransferImageNames): string {
  const { source, style } = names;
  return (strength ?? STYLE_TRANSFER_DEFAULT_STRENGTH) < 0.5
    ? `Restyle ${source} lightly after ${style}: keep ${source}'s subject, composition, pose and most of its own colours, and take ${style}'s texture, brushwork and lighting.`
    : `Restyle ${source} in the style of ${style}: keep ${source}'s subject, composition and pose, and take ${style}'s palette, brushwork, texture, lighting and medium.`;
}

/**
 * The prompt for a style transfer on an editing model: the instruction, then
 * the caller's prompt when it has text.
 *
 * @param prompt - The caller's prompt.
 * @param strength - How much of the reference's style to apply.
 * @param names - How the model is told which image is which.
 */
export function styleTransferPrompt(prompt: string, strength: number | undefined, names: StyleTransferImageNames): string {
  const instruction = styleTransferInstruction(strength, names);
  const text = prompt.trim();
  return text ? `${instruction} ${text}` : instruction;
}

/**
 * The formats of the two images, checked against those a provider takes.
 *
 * @param provider - The provider's name, for the error.
 * @param accepted - The formats it takes, by media type.
 * @param image - The source.
 * @param styleImage - The style reference.
 * @returns Each image's format.
 * @throws {Error} When either image is not a PNG, JPEG, WebP or GIF, or is a
 *   format the provider does not take.
 */
export function styleTransferImageTypes(
  provider: string,
  accepted: readonly ImagePartType['mimeType'][],
  image: Buffer,
  styleImage: Buffer,
): { image: ImagePartType; style: ImagePartType } {
  const check = (bytes: Buffer, which: string): ImagePartType => {
    const type = imagePartType(bytes);
    if (!type || !accepted.includes(type.mimeType)) {
      const formats = accepted.map((mimeType) => IMAGE_PART_TYPES[mimeType].name).join(', ');
      throw new Error(
        `${provider}'s style transfer takes ${formats}; the ${which} is ${type ? type.name : 'not a JPEG, PNG, WebP or GIF image'}.`,
      );
    }
    return type;
  };
  return { image: check(image, 'source'), style: check(styleImage, 'style reference') };
}

/**
 * The error for a model outside a provider's style-transfer models.
 *
 * @param provider - The provider's name.
 * @param model - The model the call named.
 * @param models - The models it runs, the default first.
 * @param custom - What a custom base URL takes instead, as the provider has it.
 */
export function styleTransferModelError(
  provider: string,
  model: string,
  models: readonly string[],
  custom = 'A custom baseUrl takes any model name.',
): Error {
  return new Error(`${provider}'s style transfer runs on ${models.join(', ')} (${models[0]} by default); ${model} is not one of them. ${custom}`);
}
