import { z } from 'zod';
import { checkedRequest, hostedEgressPolicy, localEgressPolicy, type AddressLookup, type EgressConnector } from '../../../safety/egress/CheckedEgress.js';
import { requireVoiceScope, type VoiceScopeContext } from '../VoiceScopeContext.js';
/** Positive stop evidence; a socket close or timeout alone cannot construct this value. */
export interface VoiceStopEvidence { stopped: true; evidenceRef: string }
/** Fixed tool registration. Schemas are closed objects; code and URLs are never accepted from model output. */
export interface VoiceToolRegistration {
  ref: string; scopeId: string; providerId: string; url: string; description: string;
  input: z.ZodObject; output: z.ZodObject; credentialRef?: string;
  fence(scope: VoiceScopeContext, operationId: string): Promise<VoiceStopEvidence>;
}
/** Testable connection dependencies, still called only after destination checking. */
export interface VoiceNetworkDependencies { lookup?: AddressLookup; connector?: EgressConnector }
/** Registered HTTP tools for one authorized call's input and no shared runtime state. */
export class VoiceToolRegistry {
  private readonly entries: ReadonlyMap<string, VoiceToolRegistration>;
  constructor(entries: readonly VoiceToolRegistration[], private readonly network: VoiceNetworkDependencies = {}) {
    const map = new Map<string, VoiceToolRegistration>();
    for (const entry of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.ref) || !entry.scopeId || !entry.providerId || map.has(entry.ref) || entry.description.length > 1024 || typeof entry.fence !== 'function') throw new Error('tool registration refused');
      const input = entry.input.strict(); const output = entry.output.strict();
      z.toJSONSchema(input, { target: 'draft-2020-12' }); z.toJSONSchema(output, { target: 'draft-2020-12' });
      map.set(entry.ref, Object.freeze({ ...entry, input, output }));
    }
    this.entries = map;
  }
  private get(scope: VoiceScopeContext, ref: string): VoiceToolRegistration {
    requireVoiceScope(scope, scope.scopeId, scope.callId); const entry = this.entries.get(ref);
    if (!entry || entry.scopeId !== scope.scopeId || !scope.allowedToolRefs.includes(ref) || !scope.policy.providers.some((p) => p.providerId === entry.providerId && p.purposes.includes('reasoning') && (scope.policy.mode !== 'local' || p.locality === 'local'))) throw new Error('tool authority refused');
    return entry;
  }
  /** Captured schemas sent to the model. Foreign or missing registrations fail before inference. */
  definitions(scope: VoiceScopeContext): object[] {
    return scope.allowedToolRefs.map((ref) => { const entry = this.get(scope, ref); return { type: 'function', function: { name: entry.ref, description: entry.description, parameters: z.toJSONSchema(entry.input, { target: 'draft-2020-12' }) } }; });
  }
  /** Executes one schema-checked request; incomplete requests retain their stop-evidence obligation. */
  async execute(scope: VoiceScopeContext, ref: string, args: unknown, operationId: string, signal: AbortSignal): Promise<string> {
    const entry = this.get(scope, ref); const body = JSON.stringify(entry.input.parse(args));
    if (!operationId || Buffer.byteLength(body) > 32768) throw new Error('tool input bound'); signal.throwIfAborted();
    const key = entry.credentialRef ? await scope.credentials.resolve({ ...scope, providerId: entry.providerId, purpose: 'reasoning', credentialRef: entry.credentialRef, signal }) : undefined;
    if (entry.credentialRef && !key) throw new Error('tool credential missing');
    const abort = new AbortController(); const joined = AbortSignal.any([scope.signal, signal, abort.signal]); let complete = false;
    try {
      const answer = await checkedRequest({ url: entry.url, method: 'POST', body, signal: joined,
        headers: { 'content-type': 'application/json', 'x-operation-id': operationId, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        policy: (scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)({ timeoutMs: 10000, maxResponseBytes: 32768 }), ...this.network });
      joined.throwIfAborted(); requireVoiceScope(scope, entry.scopeId, scope.callId);
      if (answer.status !== 200) throw new Error('tool request refused');
      const result = JSON.stringify(entry.output.parse(JSON.parse(answer.body.toString('utf8')))); complete = true; return result;
    } finally {
      abort.abort();
      // eslint-disable-next-line no-unsafe-finally -- missing stop evidence replaces the request's own error, so an unfenced tool never reads as stopped
      if (!complete) { const evidence = await entry.fence(scope, operationId).catch(() => { throw new Error('tool fence incomplete'); }); if (evidence.stopped !== true || !evidence.evidenceRef) throw new Error('tool fence incomplete'); }
    }
  }
}
