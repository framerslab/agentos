import { describe, expect, it, vi } from 'vitest';
import { TwilioVoiceProvider } from '../providers/twilio.js';
describe('speech XML escaping', () => {
  it('escapes text and attribute values independently', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const provider = new TwilioVoiceProvider({ accountSid: 'account', authToken: 'not-a-real-secret', fetchImpl: fetcher });
    await provider.playTts({ providerCallId: 'call', text: '<Hangup/> & "value"', voice: 'v"/><Hangup/>' });
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    const xml = new URLSearchParams(String(options.body)).get('Twiml');
    expect(xml).toBe('<Response><Say voice="v&quot;/&gt;&lt;Hangup/&gt;">&lt;Hangup/&gt; &amp; &quot;value&quot;</Say></Response>');
    expect(xml).not.toContain('<Hangup/>');
  });
  it('keeps raw XML only behind the documented compatibility option', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const provider = new TwilioVoiceProvider({ accountSid: 'account', authToken: 'not-a-real-secret', fetchImpl: fetcher, speechXml: 'legacy-raw' });
    await provider.playTts({ providerCallId: 'call', text: '<legacy/>' });
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get('Twiml')).toContain('<legacy/>');
  });
});
