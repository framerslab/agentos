import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MemoryStore } from '../../cognition/memory/retrieval/store/MemoryStore.js';
import type { MemoryTrace } from '../../cognition/memory/core/types.js';
import { resolveSelfImprovementSessionKey } from '../../cognition/emergent/sessionScope.js';
import { captureVoiceScope, requireVoiceScope, voiceNamespace, type VoiceScopeContext, type VoiceScopeIdentity } from './VoiceScopeContext.js';
const optionsSchema = z.strictObject({ topK: z.number().int().min(1).max(100).optional() });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Existing MemoryStore methods, supplied over per-call backing resources by the host. */
export type VoiceMemoryStore = Pick<MemoryStore, 'store' | 'query'>;
/** Read and write adapter. Cross-call links, arbitrary sources and broader retrieval options are refused. */
export class ScopedVoiceMemory {
  readonly namespace: string;
  private readonly scope: VoiceScopeContext;
  constructor(scope: VoiceScopeContext, private readonly store?: VoiceMemoryStore) { this.scope = captureVoiceScope(scope); this.namespace = voiceNamespace(this.scope); }
  private check(identity: VoiceScopeIdentity): void { requireVoiceScope(this.scope, identity?.scopeId, identity?.callId); }
  private id(id: string): string { return `${this.namespace}_${createHash('sha256').update(id).digest('hex')}`; }
  /** Accepts only this call's thread trace; ids are namespaced before reaching MemoryStore's id-only cache. */
  async write(identity: VoiceScopeIdentity, trace: MemoryTrace): Promise<void> {
    this.check(identity);
    if (!trace || trace.scope !== 'thread' || trace.scopeId !== this.scope.callId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trace.id) || trace.associatedTraceIds.length || trace.provenance.contradictedBy?.length || trace.entities.length || trace.structuredData || Buffer.byteLength(trace.content) > 32768) throw new Error('memory boundary refused');
    if (!this.store) throw new Error('voice memory disabled');
    const value = copy(trace); value.id = this.id(trace.id); value.scopeId = this.namespace;
    await this.store.store(value); this.check(identity);
  }
  /** Pins the only query scope and validates every returned trace before content is exposed. */
  async query(identity: VoiceScopeIdentity, text: string, options: { topK?: number } = {}): Promise<MemoryTrace[]> {
    this.check(identity); const parsed = optionsSchema.parse(options);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) throw new Error('memory query bound');
    if (!this.store) return [];
    const result = await this.store.query(text, { valence: 0, arousal: 0, dominance: 0 }, { scopes: [{ scope: 'thread', scopeId: this.namespace }], topK: parsed.topK ?? 20, hyde: false, neutralMood: true });
    this.check(identity);
    const traces = result.scored;
    if (result.partial.length || traces.some((trace) => trace.scope !== 'thread' || trace.scopeId !== this.namespace || !trace.id.startsWith(`${this.namespace}_`))) throw new Error('memory boundary refused');
    return copy(traces);
  }
}
/** Calls the existing session-key helper with a mandatory captured id, so its global fallback is unreachable. */
export function voiceSessionKey(scope: VoiceScopeContext, identity: VoiceScopeIdentity = scope): string {
  requireVoiceScope(scope, identity.scopeId, identity.callId);
  const namespace = voiceNamespace(scope);
  return resolveSelfImprovementSessionKey({ gmiId: namespace, personaId: namespace, userContext: { userId: scope.principal.principalId }, sessionData: { sessionId: namespace }, signal: scope.signal });
}
