import { describe, expect, it } from 'vitest';
import { resolveCognition } from '../gmiCognition.js';

describe('resolveCognition', () => {
  it('light by default: no memory, no sentiment, no metaprompts', () => {
    expect(resolveCognition({})).toEqual({ profile: 'light', memory: false, mechanisms: undefined, sentiment: false, metaprompts: false });
  });

  it('light with memory set keeps memory and runs every mechanism at its defaults', () => {
    expect(resolveCognition({ memory: true })).toMatchObject({ profile: 'light', memory: {}, mechanisms: {} });
  });

  it('full: memory, every mechanism, sentiment and every metaprompt preset', () => {
    expect(resolveCognition({ cognition: 'full' })).toEqual({ profile: 'full', memory: {}, mechanisms: {}, sentiment: true, metaprompts: 'all' });
  });

  it('full honours an explicit memory: false and an explicit mechanisms config', () => {
    expect(resolveCognition({ cognition: 'full', memory: false })).toMatchObject({ memory: false, mechanisms: undefined });
    expect(resolveCognition({ cognition: 'full', cognitiveMechanisms: { reconsolidation: { enabled: false } } })).toMatchObject({
      mechanisms: { reconsolidation: { enabled: false } },
    });
  });

  it('a CognitionConfig sets each switch', () => {
    expect(resolveCognition({ cognition: { memory: { types: ['episodic'] }, mechanisms: false, sentiment: true, metaprompts: ['frustration_recovery'] } })).toEqual({
      profile: 'custom', memory: { types: ['episodic'] }, mechanisms: undefined, sentiment: true, metaprompts: ['frustration_recovery'],
    });
  });

  it('metaprompts resolve to none without sentiment, because the presets answer sentiment events', () => {
    expect(resolveCognition({ cognition: { metaprompts: 'all' } })).toMatchObject({ sentiment: false, metaprompts: false });
  });

  it('rejects an unknown profile and an unknown metaprompt preset, naming them', () => {
    expect(() => resolveCognition({ cognition: 'heavy' as never })).toThrow(/unknown profile 'heavy'/);
    expect(() => resolveCognition({ cognition: { sentiment: true, metaprompts: ['frustration'] as never } })).toThrow(/unknown preset 'frustration'/);
  });
});
