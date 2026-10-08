/**
 * @module @framers/agentos/io/voice-pipeline/browser
 *
 * The voice pipeline's browser entry: modules that import no Node built-in
 * and no package, so a browser bundle can take them. The Node entry,
 * `@framers/agentos/io/voice-pipeline`, carries all of this as well.
 *
 * @example
 * ```typescript
 * import { parseSttEntry } from '@framers/agentos/io/voice-pipeline/browser';
 *
 * parseSttEntry('openai:gpt-4o-mini-transcribe'); // { vendor: 'openai', model: 'gpt-4o-mini-transcribe' }
 * ```
 */

// The entries a speech-to-text chain is built from, and their parser; sttEntries.ts imports nothing.
export { STT_CHAIN_VENDORS, parseSttEntry, type SttChainVendor, type SttEntry } from './sttEntries.js';
