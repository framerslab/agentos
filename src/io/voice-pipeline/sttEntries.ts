/**
 * @module voice-pipeline/sttEntries
 * The entries a speech-to-text chain is built from, `<vendor>:<model>`, and their parser. No run-time import, so the
 * browser entry carries it.
 */

/** The vendors an entry of `createSttChain` may name. */
export const STT_CHAIN_VENDORS = ['openai', 'deepgram', 'elevenlabs'] as const;

/** One vendor of {@link STT_CHAIN_VENDORS}. */
export type SttChainVendor = (typeof STT_CHAIN_VENDORS)[number];

/** An entry read by {@link parseSttEntry}. */
export interface SttEntry {
  vendor: SttChainVendor;
  model: string;
}

/**
 * Reads `<vendor>:<model>`.
 *
 * @throws {RangeError} For another shape, a vendor not in {@link STT_CHAIN_VENDORS}, or a model with a space.
 */
export function parseSttEntry(entry: string): SttEntry {
  const match = /^([a-z]+):([A-Za-z0-9._-]+)$/.exec(entry);
  const vendor = match?.[1] as SttChainVendor | undefined;
  if (!match || vendor === undefined || !STT_CHAIN_VENDORS.includes(vendor)) {
    throw new RangeError(`parseSttEntry: "${entry}" is not <vendor>:<model> with a vendor of ${STT_CHAIN_VENDORS.join(', ')}`);
  }
  return { vendor, model: match[2]! };
}
