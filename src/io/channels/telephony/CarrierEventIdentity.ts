import { createHash } from 'node:crypto';
import type { NormalizedCallEvent, VoiceProviderName } from './types.js';
/** Verified carrier/account context; occurrence identifies repeatable informational events. */
export interface CarrierEventContext { provider: VoiceProviderName; account: string; occurrence?: string; requestId?: string }
/** Stable semantic ids independent of receipt time, retry signature nonce and body key ordering. */
export function stableCarrierEvents(events: NormalizedCallEvent[], context: CarrierEventContext): NormalizedCallEvent[] {
  return events.map((event) => {
    if (!event.providerCallId || !context.account) throw new Error('carrier identity missing');
    if (event.kind === 'call-dtmf' && !context.occurrence) throw new Error('DTMF occurrence identity required');
    const occurrence = event.kind === 'call-dtmf' ? context.occurrence : '';
    const digest = createHash('sha256').update(JSON.stringify([context.provider, context.account, event.providerCallId, event.kind, occurrence])).digest('hex');
    return { ...event, provider: context.provider, providerRequestId: context.requestId, eventId: `${context.provider}:v1:${digest}` };
  });
}
/** Reads one host-supplied callback occurrence key from the URL covered by carrier verification. */
export function callbackOccurrence(url: string): string | undefined {
  const values = new URL(url).searchParams.getAll('event_key');
  if (values.length !== 1 || !values[0] || values[0].length > 256) return undefined;
  return values[0];
}
