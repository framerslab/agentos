/**
 * @module voice-pipeline/sttEntries
 * The entries a speech-to-text chain is built from, `<vendor>:<model>`, and their parser. No run-time import, so the
 * browser entry carries it.
 *
 * Without a registry the parser reads the built-in vendors of `createSttChain`; given the vendors a host registered,
 * it reads those alone, as `createRegisteredSttChain` does. A vendor is a lower-case letter followed by up to 63
 * lower-case letters, digits or `-`; a model is 1 to 128 letters, digits, `.`, `_` or `-`.
 */

/** Built-in vendors of the legacy convenience constructor. */
export const STT_CHAIN_VENDORS = ['openai', 'deepgram', 'elevenlabs'] as const;

/** A built-in vendor, unchanged for existing exhaustive switches. */
export type SttChainVendor = (typeof STT_CHAIN_VENDORS)[number];

/** Parsed built-in entry. */
export interface SttEntry {
  /** One of {@link STT_CHAIN_VENDORS}. */
  vendor: SttChainVendor;
  /** The model the entry names. */
  model: string;
}

/** Parsed explicitly registered entry; this type makes no built-in provider claim. */
export interface RegisteredSttEntry {
  /** One of the vendors the parser was given. */
  vendor: string;
  /** The model the entry names. */
  model: string;
}

/**
 * Reads a built-in entry without consulting process state.
 *
 * @param entry - `<vendor>:<model>`, such as `openai:gpt-4o-transcribe`.
 * @returns The vendor and the model.
 * @throws {RangeError} For another shape, a vendor not in {@link STT_CHAIN_VENDORS}, or a model with a space or
 *   longer than 128 characters.
 */
export function parseSttEntry(entry: string): SttEntry;
/**
 * Reads only a vendor explicitly registered by the host.
 *
 * @param entry - `<vendor>:<model>`, such as `local-stt:base-en`.
 * @param registeredVendors - The vendors the host registered; no other vendor is read, a built-in one included.
 * @returns The vendor and the model.
 * @throws {RangeError} For another shape, a vendor not in `registeredVendors`, or a model with a space or longer
 *   than 128 characters.
 */
export function parseSttEntry(entry: string, registeredVendors: readonly string[]): RegisteredSttEntry;
export function parseSttEntry(entry: string, registeredVendors: readonly string[] = STT_CHAIN_VENDORS): RegisteredSttEntry {
  const match = /^([a-z][a-z0-9-]{0,63}):([A-Za-z0-9._-]{1,128})$/.exec(entry);
  // The message leaves the entry out: an entry can come from a host's configuration or from a caller.
  if (!match || !registeredVendors.includes(match[1]!)) throw new RangeError('parseSttEntry: entry must name a registered vendor and model');
  return { vendor: match[1]!, model: match[2]! };
}
