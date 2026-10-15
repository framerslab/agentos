import { describe, expect, it } from 'vitest';
import { PlivoMediaStreamParser } from '../parsers/PlivoMediaStreamParser.js';
import { plivoStreamXml } from '../twiml.js';
describe('carrier Plivo stream', () => {
  it('declares PCMU in XML and matches the playAudio content type and numeric rate', () => {
    expect(plivoStreamXml('wss://example.test/media', { protocol: 'carrier' })).toContain('contentType="audio/x-mulaw;rate=8000"');
    const p = new PlivoMediaStreamParser({ protocol: 'carrier' });
    expect(JSON.parse(p.formatOutgoing(Buffer.from([255]), 's'))).toEqual({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: '/w==' } });
    expect(p.parseIncoming('{"event":"start","start":{"callId":"c","streamId":"s","mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000}}}')).toMatchObject({ type: 'start', callSid: 'c', streamSid: 's' });
    expect(p.parseIncoming('{"event":"media","streamId":"s","media":{"track":"inbound","chunk":2,"timestamp":"1000","payload":"/w=="}}')).toMatchObject({ type: 'audio', mediaChunk: 2, timestampMs: 1000 });
  });
  it('handles DTMF, played checkpoints and clear without forwarding pipeline JSON', () => {
    const p = new PlivoMediaStreamParser({ protocol: 'carrier' });
    expect(p.parseIncoming('{"event":"dtmf","streamId":"s","dtmf":{"digit":"#"}}')).toMatchObject({ type: 'dtmf', digit: '#' });
    expect(p.parseIncoming('{"event":"playedStream","streamId":"s","name":"m"}')).toMatchObject({ type: 'mark', name: 'm' });
    expect(JSON.parse(p.formatMark('s', 'm')!)).toEqual({ event: 'checkpoint', streamId: 's', name: 'm' });
    expect(JSON.parse(p.formatClear('s')!)).toEqual({ event: 'clearAudio', streamId: 's' });
    expect(() => p.parseIncoming('{"event":"start","start":{"callId":"c","streamId":"s","mediaFormat":{"encoding":"audio/x-l16","sampleRate":8000}}}')).toThrow('carrier media format');
  });
  it('retains legacy snake-case parsing and undeclared output explicitly', () => {
    const p = new PlivoMediaStreamParser({ protocol: 'legacy' });
    expect(p.parseIncoming('{"event":"start","stream_id":"s","call_uuid":"c"}')).toMatchObject({ callSid: 'c' });
    expect(JSON.parse(p.formatOutgoing(Buffer.from([255]), 's'))).toEqual({ event: 'playAudio', media: { payload: '/w==' } });
    expect(plivoStreamXml('wss://example.test/media', { protocol: 'legacy' })).not.toContain('contentType');
  });
});
