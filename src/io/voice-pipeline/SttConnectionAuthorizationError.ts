/**
 * @module voice-pipeline/SttConnectionAuthorizationError
 *
 * The refusal a host's `SttConnectionHooks` gives a hosted transcription
 * socket. It imports nothing, so the browser-safe `StreamingSTTChain` can tell
 * it from a provider outage.
 */

/** A host accounting refusal, not a vendor outage or permission to try another vendor. */
export class SttConnectionAuthorizationError extends Error {
  constructor() {
    super('STT connection authorization refused');
    this.name = 'SttConnectionAuthorizationError';
  }
}
