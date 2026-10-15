import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, it, expect } from 'vitest';
import { SealedSecretError } from '../../../../core/llm/auth/sealing.js';
import { envelopeHeaders, hashWorkerToken, mintWorkerToken, SecretBox, signEnvelope, verifyEnvelope, workerTokenMatches } from '../signing.js';

const secret = 'not-a-real-secret';

describe('the outbound envelope', () => {
  it('signs id, timestamp and payload, and verifies inside the window', () => {
    const payload = '{"type":"bot:done","runId":"r1"}';
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, payload);
    expect(headers['x-webhook-id']).toBe('msg_1');
    expect(headers['x-webhook-timestamp']).toBe('1700000000000');
    expect(headers['x-webhook-signature']).toBe(signEnvelope(secret, 'msg_1', 1_700_000_000_000, payload));
    expect(verifyEnvelope(secret, headers, payload, 1_700_000_000_000 + 60_000)).toEqual({ valid: true });
    expect(verifyEnvelope(secret, headers, payload, 1_700_000_000_000 + 301_000).valid).toBe(false);
    expect(verifyEnvelope(secret, headers, payload + ' ', 1_700_000_000_000).valid).toBe(false);
    expect(verifyEnvelope('other', headers, payload, 1_700_000_000_000).valid).toBe(false);
    expect(verifyEnvelope(secret, { ...headers, 'x-webhook-signature': 'v1,AAAA' }, payload, 1_700_000_000_000).valid).toBe(false);
  });
  it('takes the header names a host gives it', () => {
    const names = { id: 'acme-hook-id', timestamp: 'acme-hook-ts', signature: 'acme-hook-sig' };
    const headers = envelopeHeaders(secret, 'msg_2', 1_700_000_000_000, '{}', names);
    expect(Object.keys(headers).sort()).toEqual(['acme-hook-id', 'acme-hook-sig', 'acme-hook-ts']);
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000, { names })).toEqual({ valid: true });
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000).valid).toBe(false); // the default names are not there
  });
  it('matches the vector every receiver can check', () => {
    expect(signEnvelope('whsec_test', 'msg_test', 1_700_000_000_000, '{}')).toBe('v1,' + '9ZqX9AeXhOn09zJoK16s/EjlvxkvRUT9ukb9stxQ79w=');
  });
  it('refuses the future side of the window and accepts its exact boundary', () => {
    const now = 1_700_000_000_000;
    expect(verifyEnvelope(secret, envelopeHeaders(secret, 'msg_1', now + 300_000, '{}'), '{}', now)).toEqual({ valid: true });
    expect(verifyEnvelope(secret, envelopeHeaders(secret, 'msg_1', now + 300_001, '{}'), '{}', now)).toEqual({ valid: false, error: 'outside the window' });
  });
  it('refuses an unknown version even with the correct MAC', () => {
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, '{}');
    headers['x-webhook-signature'] = headers['x-webhook-signature'].replace(/^v1,/, 'v2,');
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000)).toEqual({ valid: false, error: 'signature mismatch' });
  });
  it('refuses a non-numeric timestamp', () => {
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, '{}');
    headers['x-webhook-timestamp'] = 'not-a-time';
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000)).toEqual({ valid: false, error: 'bad timestamp' });
  });
  it('refuses a NaN clock or window', () => {
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, '{}');
    expect(verifyEnvelope(secret, headers, '{}', NaN)).toEqual({ valid: false, error: 'outside the window' });
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000, { windowMs: NaN })).toEqual({ valid: false, error: 'outside the window' });
  });
  it('refuses to sign with an empty secret', () => {
    expect(() => signEnvelope('', 'msg_1', 1_700_000_000_000, '{}')).toThrow('empty envelope secret');
    expect(() => envelopeHeaders('', 'msg_1', 1_700_000_000_000, '{}')).toThrow('empty envelope secret');
  });
  it('refuses an empty verification secret even with a correct MAC', () => {
    const mac = createHmac('sha256', '').update('msg_1.1700000000000.{}').digest('base64');
    const headers = { 'x-webhook-id': 'msg_1', 'x-webhook-timestamp': '1700000000000', 'x-webhook-signature': `v1,${mac}` };
    expect(verifyEnvelope('', headers, '{}', 1_700_000_000_000)).toEqual({ valid: false, error: 'empty envelope secret' });
  });
  it('refuses every non-digit timestamp form even when it represents the signed time', () => {
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, '{}');
    for (const timestamp of [' 1700000000000', '+1700000000000', '1700000000000.0', '1.7e12', '0x18bcfe56800', '1700000000000\n']) {
      expect(verifyEnvelope(secret, { ...headers, 'x-webhook-timestamp': timestamp }, '{}', 1_700_000_000_000)).toEqual({ valid: false, error: 'bad timestamp' });
    }
  });
  it('authenticates the timestamp header literally, including a leading zero', () => {
    const headers = envelopeHeaders(secret, 'msg_1', 1_700_000_000_000, '{}');
    headers['x-webhook-timestamp'] = '01700000000000';
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000)).toEqual({ valid: false, error: 'signature mismatch' });
    const mac = createHmac('sha256', secret).update('msg_1.01700000000000.{}').digest('base64');
    headers['x-webhook-signature'] = `v1,${mac}`;
    expect(verifyEnvelope(secret, headers, '{}', 1_700_000_000_000)).toEqual({ valid: true });
  });
});

describe('the worker token', () => {
  it('mints 43 url-safe characters, hashes to 64 hex, and compares in constant time', () => {
    const t = mintWorkerToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashWorkerToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(workerTokenMatches(t, hashWorkerToken(t))).toBe(true);
    expect(workerTokenMatches(t + 'x', hashWorkerToken(t))).toBe(false);
    expect(workerTokenMatches('', hashWorkerToken(t))).toBe(false);
  });
  it('matches nothing against a stored value that is not 64 hex digits, even one that starts with the hash', () => {
    const t = mintWorkerToken();
    expect(workerTokenMatches(t, `${hashWorkerToken(t)}zz`)).toBe(false);
    expect(workerTokenMatches(t, hashWorkerToken(t).toUpperCase())).toBe(true); // hex in upper case is still the hash
  });
});

describe('SecretBox', () => {
  it('seals and opens, refuses a tampered text and a wrong key', () => {
    const key = Buffer.alloc(32, 7);
    const box = new SecretBox(key);
    const sealed = box.seal('https://meet.google.com/abc-defg-hij');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.open(sealed)).toBe('https://meet.google.com/abc-defg-hij');
    expect(box.seal('x')).not.toBe(box.seal('x'));
    expect(box.open(box.seal(''))).toBe('');
    // The last character carries the tag's last two bits, so changing it between these values always changes the tag.
    expect(() => box.open(sealed.slice(0, -1) + (sealed.endsWith('A') ? 'Q' : 'A'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(31)).seal('x')).toThrow(RangeError);
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed)).toThrow();
  });
  it('keeps its own copy of the key', () => {
    const key = Buffer.alloc(32, 7);
    const box = new SecretBox(key);
    const sealed = box.seal('https://meet.google.com/abc-defg-hij');
    key.fill(0); // the host wipes its buffer
    expect(box.open(sealed)).toBe('https://meet.google.com/abc-defg-hij');
    expect(new SecretBox(Buffer.alloc(32, 7)).open(box.seal('x'))).toBe('x');
  });
  it('opens a text only with the context it was sealed with', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const sealed = box.seal('https://meet.google.com/abc-defg-hij', 'r1');
    expect(box.open(sealed, 'r1')).toBe('https://meet.google.com/abc-defg-hij');
    expect(() => box.open(sealed, 'r2')).toThrow(SealedSecretError); // moved to another run's row
    expect(() => box.open(sealed)).toThrow(SealedSecretError);
  });
  it('redacts its JSON form, including when held by another object', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    expect(JSON.stringify(box)).toBe('"[SecretBox redacted]"');
    expect(JSON.stringify({ box })).toBe('{"box":"[SecretBox redacted]"}');
  });
  it('prints a redacted marker under util.inspect, as console.log does, never the key bytes', () => {
    const box = new SecretBox(Buffer.alloc(32, 7), { previousKeys: [Buffer.alloc(32, 8)] });
    expect(inspect(box)).toBe('[SecretBox redacted]');
    expect(inspect({ box }, { depth: 5 })).toBe('{ box: [SecretBox redacted] }');
  });
});

describe('SecretBox key rotation', () => {
  it('tries previous keys in order, copies them and seals only with the current key', () => {
    const oldest = Buffer.alloc(32, 7);
    const previous = Buffer.alloc(32, 8);
    const current = Buffer.alloc(32, 9);
    const oldText = new SecretBox(oldest).seal('oldest', 'r1');
    const previousText = new SecretBox(previous).seal('previous', 'r1');
    const previousKeys = [previous, oldest];
    const box = new SecretBox(current, { previousKeys });
    current.fill(0);
    previous.fill(0);
    oldest.fill(0);
    previousKeys.length = 0;
    expect(box.open(oldText, 'r1')).toBe('oldest');
    expect(box.open(previousText, 'r1')).toBe('previous');
    const fresh = box.seal('current', 'r1');
    expect(fresh.startsWith('v1.box.')).toBe(true);
    expect(new SecretBox(Buffer.alloc(32, 9)).open(fresh, 'r1')).toBe('current');
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(fresh, 'r1')).toThrow(SealedSecretError);
    expect(() => new SecretBox(Buffer.alloc(32, 7)).open(fresh, 'r1')).toThrow(SealedSecretError);
    expect(() => new SecretBox(Buffer.alloc(32, 9)).open(oldText, 'r1')).toThrow(SealedSecretError);
    expect(JSON.stringify(box)).toBe('"[SecretBox redacted]"');
    expect(JSON.stringify({ box })).toBe('{"box":"[SecretBox redacted]"}');
  });
  it('keeps context and tamper checks when trying previous keys', () => {
    const old = new SecretBox(Buffer.alloc(32, 7));
    const box = new SecretBox(Buffer.alloc(32, 9), { previousKeys: [Buffer.alloc(32, 8), Buffer.alloc(32, 7)] });
    const sealed = old.seal('old', 'r1');
    expect(() => box.open(sealed, 'r2')).toThrow(SealedSecretError);
    expect(() => box.open(sealed)).toThrow(SealedSecretError);
    const tampered = sealed.slice(0, -1) + (sealed.endsWith('A') ? 'Q' : 'A');
    expect(() => box.open(tampered, 'r1')).toThrow(SealedSecretError);
    expect(() => box.open('not-sealed', 'r1')).toThrow(SealedSecretError);
    expect(() => box.open(sealed.replace('v1.box.', 'v1.other.'), 'r1')).toThrow(SealedSecretError);
    expect(() => box.open(new SecretBox(Buffer.alloc(32, 6)).seal('unknown', 'r1'), 'r1')).toThrow(SealedSecretError);
  });
  it('validates every previous key and still permits the one-argument constructor', () => {
    expect(() => new SecretBox(Buffer.alloc(32), { previousKeys: [Buffer.alloc(31)] })).toThrow(RangeError);
    expect(() => new SecretBox(Buffer.alloc(32), { previousKeys: [Buffer.alloc(32), Buffer.alloc(33)] })).toThrow(RangeError);
    expect(() => new SecretBox(Buffer.alloc(31), { previousKeys: [Buffer.alloc(32)] })).toThrow(RangeError);
    const box = new SecretBox(Buffer.alloc(32, 9));
    expect(box.open(box.seal('', 'r1'), 'r1')).toBe('');
  });
});
