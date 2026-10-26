/**
 * Cognitive substrate — GMI (Generalised Mind Instance) definitions,
 * persona overlays, sentiment tracking, and working memory.
 * @module agentos/cognitive_substrate
 */
export * from './IGMI.js';
export { GMI } from './GMI.js';
export { GMIManager } from './GMIManager.js';
export * from './GMIEvent.js';
export { SentimentTracker } from './SentimentTracker.js';
export { ConversationHistoryManager } from './ConversationHistoryManager.js';
export { MetapromptExecutor } from './MetapromptExecutor.js';
export { CognitiveMemoryBridge } from './CognitiveMemoryBridge.js';

export { NOTETAKER_PERSONA } from './personas/notetaker.js';
export {
  bandOf,
  renderPersonalitySection,
  OPERATOR_ONLY_TRAITS,
  type TraitBand,
  type PersonalityRegister,
} from './personas/personalityPrompt.js';
export { HEXACO_TRAIT_KEYS, normalizeHexacoTraits, type HexacoTraitKey } from './personas/hexaco.js';
export type { IPersonaDefinition } from './personas/IPersonaDefinition.js';
