import { describe, it, expect } from 'vitest';
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
    expect(signEnvelope('whsec_test', 'msg_test', 1_700_000_000_000, '{}')).toBe('v1,' + 'uWC3AFWoQk5Au2iJm3gz8XsD4RMCB1Ma2MPcnH2M9Js=');
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
});
