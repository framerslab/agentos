/**
 * @fileoverview A capability call the broker refused or ended. The message
 * starts with the code; forged code sees it, and an effect record keeps it.
 * @module @framers/agentos/emergent/broker/refusal
 */
export class CapabilityRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CapabilityRefusal';
  }
}
