/**
 * @file index.ts
 * Barrel export for the avatar generation pipeline.
 */

export { AvatarPipeline, type ImageGeneratorFn, type ImageGeneratorOptions } from './AvatarPipeline.js';

export type {
  AvatarAcceptanceCheck,
  AvatarAcceptanceCheckArgs,
  AvatarAcceptanceVerdict,
  AvatarGenerationStage,
  AvatarGenerationRequest,
  AvatarGenerationJob,
  DriftAuditReport,
  AvatarGenerationResult,
} from './types.js';

export {
  AVATAR_ANGLES,
  AVATAR_EMOTIONS,
  type AvatarEmotion,
  buildAnglePrompt,
  buildPortraitPrompt,
  buildExpressionPrompt,
  buildEmotePrompt,
} from './prompts.js';
