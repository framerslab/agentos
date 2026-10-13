import { describe, expect, it } from 'vitest';
import { TwilioMediaStreamParser } from '../parsers/TwilioMediaStreamParser.js';
import { twilioConversationTwiml } from '../twiml.js';
describe('carrier Twilio stream', () => {
  it('keeps the released concrete string return for an unconfigured instance', () => {
    const parser: TwilioMediaStreamParser = new TwilioMediaStreamParser();
    const output: string = parser.formatConnected('s');
    expect(output.toUpperCase()).toContain('CONNECTED');
    const carrier = new TwilioMediaStreamParser({ protocol: 'carrier' });
    const absent: null = carrier.formatConnected('s'); expect(absent).toBeNull();
  });
  it('places the credential in a Parameter and refuses query-bearing stream URLs', () => {
    const xml = twilioConversationTwiml('wss://example.test/media', '<opaque&value>', { protocol: 'carrier' });
    expect(xml).toContain('<Stream url="wss://example.test/media"><Parameter name="token" value="&lt;opaque&amp;value&gt;" /></Stream>');
    expect(xml).not.toContain('?token=');
    expect(() => twilioConversationTwiml('wss://example.test/media?q=1', 'value', { protocol: 'carrier' })).toThrow('stream URL');
    expect(() => twilioConversationTwiml('wss://example.test/media', 'a'.repeat(495), { protocol: 'carrier' })).toThrow('parameter length');
  });
  it('preserves custom parameters, numeric metadata and permitted control frames', () => {
    const p = new TwilioMediaStreamParser({ protocol: 'carrier' });
    expect(p.formatConnected('s')).toBeNull();
    expect(p.parseIncoming('{"event":"start","streamSid":"s","start":{"callSid":"c","customParameters":{"token":"opaque"},"mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1}}}')).toMatchObject({ metadata: { customParameters: { token: 'opaque' } } });
    expect(p.parseIncoming('{"event":"media","streamSid":"s","sequenceNumber":"3","media":{"track":"inbound","chunk":"1","timestamp":"0","payload":"/w=="}}')).toMatchObject({ sequenceNumber: 3, mediaChunk: 1, timestampMs: 0 });
    expect(JSON.parse(p.formatClear('s')!)).toEqual({ event: 'clear', streamSid: 's' });
    expect(JSON.parse(p.formatMark('s', 'm')!)).toEqual({ event: 'mark', streamSid: 's', mark: { name: 'm' } });
    expect(p.parseIncoming('{"event":"media","streamSid":"s","media":{"track":"outbound","payload":"/w=="}}')).toBeNull();
  });
  it('retains legacy URL and handshake behavior explicitly', () => {
    expect(twilioConversationTwiml('wss://example.test/media', 'old', { protocol: 'legacy' })).toContain('?token=old');
    expect(JSON.parse(new TwilioMediaStreamParser({ protocol: 'legacy' }).formatConnected('s')!)).toMatchObject({ event: 'connected' });
  });
});
