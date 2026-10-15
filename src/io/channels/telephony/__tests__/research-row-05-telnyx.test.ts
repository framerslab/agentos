import { describe, expect, it } from 'vitest';
import { TelnyxMediaStreamParser } from '../parsers/TelnyxMediaStreamParser.js';
describe('carrier Telnyx media', () => {
  it('keeps the released concrete binary return for an unconfigured instance', () => {
    const parser: TelnyxMediaStreamParser = new TelnyxMediaStreamParser();
    const output: Buffer = parser.formatOutgoing(Buffer.from([255]), 's');
    expect(output.readUInt8(0)).toBe(255);
    const carrier = new TelnyxMediaStreamParser({ protocol: 'carrier' });
    const wire: string = carrier.formatOutgoing(Buffer.from([255]), 's');
    expect(JSON.parse(wire).event).toBe('media');
  });
  it('reads nested call identity and payload independently of chunk number', () => {
    const p = new TelnyxMediaStreamParser({ protocol: 'carrier' });
    expect(p.parseIncoming(JSON.stringify({ event: 'start', stream_id: 'stream', start: { call_control_id: 'call', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }))).toMatchObject({ type: 'start', streamSid: 'stream', callSid: 'call' });
    expect(p.parseIncoming(JSON.stringify({ event: 'media', stream_id: 'stream', sequence_number: '4', media: { track: 'inbound', chunk: '2', timestamp: '20', payload: '/38=' } }))).toMatchObject({ type: 'audio', payload: Buffer.from([255, 127]), sequenceNumber: 4, mediaChunk: 2, timestampMs: 20 });
    expect(JSON.parse(String(p.formatOutgoing(Buffer.from([255]), 'stream')))).toEqual({ event: 'media', media: { payload: '/w==' } });
  });
  it('parses DTMF and marks, emits only carrier controls and validates format', () => {
    const p = new TelnyxMediaStreamParser({ protocol: 'carrier' });
    expect(p.parseIncoming('{"event":"dtmf","stream_id":"s","dtmf":{"digit":"5"}}')).toMatchObject({ type: 'dtmf', digit: '5' });
    expect(p.parseIncoming('{"event":"mark","stream_id":"s","mark":{"name":"m"}}')).toMatchObject({ type: 'mark', name: 'm' });
    expect(JSON.parse(p.formatClear('s')!)).toEqual({ event: 'clear' });
    expect(JSON.parse(p.formatMark('s', 'm')!)).toEqual({ event: 'mark', mark: { name: 'm' } });
    expect(() => p.parseIncoming('{"event":"start","stream_id":"s","start":{"call_control_id":"c","media_format":{"encoding":"OPUS","sample_rate":8000,"channels":1}}}')).toThrow('carrier media format');
    expect(p.parseIncoming('null')).toBeNull();
    expect(p.parseIncoming('{"event":"media","stream_id":"s","media":{"payload":"%%%"}}')).toBeNull();
  });
  it('retains explicitly selected legacy chunk and binary behavior', () => {
    const p = new TelnyxMediaStreamParser({ protocol: 'legacy' });
    expect(p.parseIncoming('{"event":"media","stream_id":"s","media":{"chunk":"/w=="}}')).toMatchObject({ payload: Buffer.from([255]) });
    expect(p.formatOutgoing(Buffer.from([255]), 's')).toEqual(Buffer.from([255]));
  });
});
