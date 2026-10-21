import type { HexacoTraitKey } from './hexaco.js';

/** A grounded notetaker's authored HEXACO traits; only four bands are workspace controls. */
export const NOTETAKER_PERSONA: Readonly<Record<HexacoTraitKey, number>> = Object.freeze({
  honesty: 0.8,
  emotionality: 0.25,
  extraversion: 0.3,
  agreeableness: 0.55,
  conscientiousness: 0.85,
  openness: 0.5,
});
