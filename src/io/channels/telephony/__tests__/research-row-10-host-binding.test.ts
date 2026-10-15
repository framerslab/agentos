import { expect, it, vi } from 'vitest';
import { CallManager, bindVoiceProvider, type VoiceProviderBinding } from '../CallManager.js';
import { TwilioVoiceProvider } from '../providers/twilio.js';
it('exposes one actual host manager and replaces the tool target explicitly', async () => {
  const config = { provider: { provider: 'mock' as const }, inboundPolicy: 'open' as const };
  const first = new CallManager(config); const second = new CallManager(config);
  const provider = new TwilioVoiceProvider({ accountSid: 'account', authToken: 'fixture', fetchImpl: vi.fn<typeof fetch>(async () => new Response('{"sid":"call"}')) });
  const binding: VoiceProviderBinding = bindVoiceProvider(provider, first);
  expect(binding.manager).toBe(first); expect(first.getProvider('twilio')).toBe(provider);
  binding.setManager(second); expect(binding.manager).toBe(second); expect(second.getProvider('twilio')).toBe(provider);
  const call = await binding.toolHandler.initiateCall('+15550000002', 'fixture', 'notify');
  expect(second.getCall(call.callId)).toBeDefined(); expect(first.getCall(call.callId)).toBeUndefined();
  expect(binding.toolHandler.getCallStatus(call.callId)).toBe(second.getCall(call.callId)); first.dispose(); second.dispose();
});
