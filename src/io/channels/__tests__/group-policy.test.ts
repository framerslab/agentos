import { describe, it, expect } from 'vitest';
import { evaluateGroupPolicy, type GroupPolicyInput } from '../group-policy.js';
import type { GroupPolicy } from '../types.js';

const base: GroupPolicyInput = {
  isGroup: true,
  senderId: 'u1',
  senderIsBot: false,
  mentions: undefined,
  supportsMentions: false,
  botUserId: 'bot-self',
  bindingOwnerUserId: 'owner-1',
};

const policy = (over: Partial<GroupPolicy> = {}): GroupPolicy => ({
  activation: 'always',
  ...over,
});

describe('evaluateGroupPolicy', () => {
  it('DMs bypass group policy entirely', () => {
    const r = evaluateGroupPolicy(policy({ activation: 'owner-only' }), { ...base, isGroup: false });
    expect(r.verdict).toBe('allow');
  });

  it('no policy given: allow (legacy behavior), but bot senders still drop by default', () => {
    expect(evaluateGroupPolicy(undefined, base).verdict).toBe('allow');
    expect(evaluateGroupPolicy(undefined, { ...base, senderIsBot: true })).toEqual({
      verdict: 'drop',
      reason: 'bot-loop-protection',
    });
  });

  it('self-echo always drops', () => {
    const r = evaluateGroupPolicy(policy(), { ...base, senderId: 'bot-self' });
    expect(r).toEqual({ verdict: 'drop', reason: 'self-echo' });
  });

  it('botLoopProtection: false lets bot senders through', () => {
    const r = evaluateGroupPolicy(policy({ botLoopProtection: false }), { ...base, senderIsBot: true });
    expect(r.verdict).toBe('allow');
  });

  it('denyFrom wins over allowFrom', () => {
    const p = policy({ allowFrom: ['u1'], denyFrom: ['u1'] });
    expect(evaluateGroupPolicy(p, base)).toEqual({ verdict: 'drop', reason: 'deny-list' });
  });

  it('allowFrom excludes unlisted senders', () => {
    const p = policy({ allowFrom: ['u2'] });
    expect(evaluateGroupPolicy(p, base)).toEqual({ verdict: 'drop', reason: 'not-on-allow-list' });
  });

  it('mention activation: mentioned allows, unmentioned drops', () => {
    const p = policy({ activation: 'mention' });
    const ctx = { ...base, supportsMentions: true };
    expect(evaluateGroupPolicy(p, { ...ctx, mentions: ['bot-self'] }).verdict).toBe('allow');
    expect(evaluateGroupPolicy(p, { ...ctx, mentions: [] })).toEqual({
      verdict: 'drop',
      reason: 'mention-required',
    });
  });

  it('mention activation on an adapter without mention support drops with a distinct reason', () => {
    const p = policy({ activation: 'mention' });
    expect(evaluateGroupPolicy(p, { ...base, supportsMentions: false })).toEqual({
      verdict: 'drop',
      reason: 'mention-gating-unsupported',
    });
  });

  it('owner-only: binding owner and policy.ownerIds allow; others drop', () => {
    const p = policy({ activation: 'owner-only', ownerIds: ['u9'] });
    expect(evaluateGroupPolicy(p, { ...base, senderId: 'owner-1' }).verdict).toBe('allow');
    expect(evaluateGroupPolicy(p, { ...base, senderId: 'u9' }).verdict).toBe('allow');
    expect(evaluateGroupPolicy(p, base)).toEqual({ verdict: 'drop', reason: 'owner-only' });
  });

  it('owner-only with no owner configured anywhere drops all with owner-unconfigured', () => {
    const p = policy({ activation: 'owner-only' });
    expect(evaluateGroupPolicy(p, { ...base, bindingOwnerUserId: undefined })).toEqual({
      verdict: 'drop',
      reason: 'owner-unconfigured',
    });
  });
});
