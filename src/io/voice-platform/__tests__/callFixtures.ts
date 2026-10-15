import { VoiceCallSchema, VoiceCallLimitsSchema } from '../contracts/index.js';
import type { StoredVoiceCall } from '../stores/types.js';
import { createAgent, voiceCall } from './contractFixtures.js';

/** Neutral persisted fixture shared by lifecycle, credential and meter tests. */
export function storedCall(): StoredVoiceCall {
  return {
    call: VoiceCallSchema.parse(voiceCall), limits: VoiceCallLimitsSchema.parse(createAgent.limits),
    clientOrigin: 'https://client.example.test', proofKeyThumbprint: 'a'.repeat(43),
    transport: 'websocket', participantId: 'participant-a', reservationRef: null,
    preparationStep: 0, cleanupStep: 0, action: null, contentFenced: false,
    credentialGeneration: 1, nextTransportEpoch: 0, reportSequence: 0, reportHash: null,
    acknowledgedAt: 1000, leaseExpiresAt: null, disconnectedAt: null,
    lastUserSpeechAt: null, completedTurns: 0, endingAt: null, terminalFailed: false, fence: null,
  };
}
