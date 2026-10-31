/**
 * @file config.test.ts
 * The learning option resolved into switches, the mode a turn runs in once the process switches apply, and what a
 * self-modification tool reads about its turn: the learner and the mode a GMI puts on the call, and the refusal it
 * gives, in the order the freeze, the mode, the learner. A `null` option or field reads as unset; a memory tool that
 * writes refuses only on a freeze, the run-time freeze it reads at the call included.
 */
import { describe, expect, it } from 'vitest';
import { processIsFrozen, resolveLearning, resolveLearningConfig, resolveTurnMode } from '../config';
import { memoryWriteRefusal, readToolLearningContext, refusedSelfChange, selfChangeRefusal } from '../toolContext';

describe('the learning option', () => {
  it('is off unless set, takes the profile for true, and lets a config override each switch', () => {
    expect(resolveLearning(undefined, 'full')).toBeUndefined();
    expect(resolveLearning(false, 'full')).toBeUndefined();
    expect(resolveLearning(true, 'light')).toEqual({ mode: 'on', traits: false, lessons: false, skills: false });
    expect(resolveLearning(true, 'custom')).toEqual({ mode: 'on', traits: false, lessons: false, skills: false });
    expect(resolveLearning(true, 'full')).toEqual({ mode: 'on', traits: true, lessons: true, skills: true });
    expect(resolveLearning({ mode: 'off', lessons: false }, 'full')).toEqual({ mode: 'off', traits: true, lessons: false, skills: true });
    expect(resolveLearning({ traits: true }, 'light')).toEqual({ mode: 'on', traits: true, lessons: false, skills: false });
  });

  it('names the field of a config that is not valid', () => {
    expect(() => resolveLearningConfig({ mode: 'sideways' as never }, 'light')).toThrow(/learning\.mode: unknown mode 'sideways'/);
    expect(() => resolveLearningConfig({ lessons: 'yes' as never }, 'light')).toThrow(/learning\.lessons must be true or false/);
    expect(() => resolveLearningConfig({ namespace: 42 as never }, 'light')).toThrow(/learning\.namespace must be a string/);
    expect(() => resolveLearningConfig({ anonymousUserIds: 'guest' as never }, 'light')).toThrow(/learning\.anonymousUserIds must be a list of strings/);
    expect(() => resolveLearningConfig({ agentKey: '  ' }, 'light')).toThrow(/learning\.agentKey must not be blank/);
    expect(() => resolveLearning([] as never, 'light')).toThrow(/learning: use true, false or a LearningConfig/);
  });
});

describe('the mode a turn runs in', () => {
  it('is the configured mode unless a process switch is set to 1', () => {
    expect(resolveTurnMode('on', {})).toEqual({ mode: 'on', setBy: 'config' });
    expect(resolveTurnMode('frozen', {})).toEqual({ mode: 'frozen', setBy: 'config' });
    expect(resolveTurnMode('off', {})).toEqual({ mode: 'off', setBy: 'config' });
    expect(resolveTurnMode('on', { AGENTOS_LEARNING_FREEZE: '1' })).toEqual({ mode: 'frozen', setBy: 'AGENTOS_LEARNING_FREEZE' });
    expect(resolveTurnMode('off', { AGENTOS_LEARNING_FREEZE: '1' })).toEqual({ mode: 'off', setBy: 'config' });
    expect(resolveTurnMode('frozen', { AGENTOS_LEARNING_OFF: '1' })).toEqual({ mode: 'off', setBy: 'AGENTOS_LEARNING_OFF' });
    expect(resolveTurnMode('on', { AGENTOS_LEARNING_FREEZE: '1', AGENTOS_LEARNING_OFF: '1' })).toEqual({ mode: 'off', setBy: 'AGENTOS_LEARNING_OFF' });
    expect(resolveTurnMode('on', { AGENTOS_LEARNING_FREEZE: 'true' })).toEqual({ mode: 'on', setBy: 'config' });
    expect(processIsFrozen({ AGENTOS_LEARNING_FREEZE: '1' })).toBe(true);
    expect(processIsFrozen({})).toBe(false);
  });
});

describe('what a tool reads about its turn', () => {
  it('reads nothing on a host with no learning layer, and fails closed on a value it does not know', () => {
    expect(readToolLearningContext(undefined)).toBeUndefined();
    expect(readToolLearningContext({ sessionId: 's-1' })).toBeUndefined();
    expect(readToolLearningContext({ learning: { learner: 'bound', mode: 'frozen' } })).toEqual({ learner: 'bound', mode: 'frozen' });
    expect(readToolLearningContext({ learning: { learner: 'yes', mode: 'sideways' } })).toEqual({ learner: 'none', mode: 'off' });
    expect(readToolLearningContext({ learning: true })).toEqual({ learner: 'none', mode: 'off' });
  });

  it('refuses a self-change for the freeze, then the mode, then the learner', () => {
    const env = {};
    const frozenEnv = { AGENTOS_LEARNING_FREEZE: '1' };
    // No layer: only the process freeze refuses.
    expect(selfChangeRefusal(undefined, env)).toBeUndefined();
    expect(selfChangeRefusal({ sessionId: 's-1' }, frozenEnv)).toBe('frozen');
    // With a layer.
    expect(selfChangeRefusal({ learning: { learner: 'bound', mode: 'on' } }, env)).toBeUndefined();
    expect(selfChangeRefusal({ learning: { learner: 'bound', mode: 'frozen' } }, env)).toBe('frozen');
    expect(selfChangeRefusal({ learning: { learner: 'bound', mode: 'off' } }, env)).toBe('off');
    expect(selfChangeRefusal({ learning: { learner: 'none', mode: 'on' } }, env)).toBe('no_learner');
    expect(selfChangeRefusal({ learning: { learner: 'none', mode: 'off' } }, env)).toBe('off');
    expect(selfChangeRefusal({ learning: { learner: 'none', mode: 'off' } }, frozenEnv)).toBe('frozen');
  });

  it('builds a refusal that changed nothing and names its reason', () => {
    expect(refusedSelfChange('forge_tool', 'no_learner')).toEqual({
      success: false,
      error: 'forge_tool refused (no_learner): this turn has no learner; nothing was changed.',
      details: { status: 'rejected', reason: 'no_learner' },
    });
    expect(refusedSelfChange('adapt_personality', 'step_bound', 'one call moves a trait by at most 0.02').error).toBe(
      'adapt_personality refused (step_bound): one call moves a trait by at most 0.02; nothing was changed.',
    );
  });
});

describe('null reads as unset', () => {
  it('turns learning off for learning: null, and leaves a null field to its default', () => {
    expect(resolveLearning(null as never, 'full')).toBeUndefined();
    expect(
      resolveLearningConfig({ mode: null, traits: null, agentKey: null, namespace: null, anonymousUserIds: null } as never, 'full'),
    ).toEqual({ mode: 'on', traits: true, lessons: true, skills: true });
    const nulls = { lessons: null, skills: null, store: null, ledgerKey: null, clock: null, memoryTools: null };
    expect(resolveLearningConfig(nulls as never, 'light')).toEqual({ mode: 'on', traits: false, lessons: false, skills: false });
  });

  it('names the store, ledger key, clock and memory-tools fields of a config that is not valid', () => {
    expect(() => resolveLearningConfig({ ledgerKey: 7 as never }, 'light')).toThrow(/learning\.ledgerKey must be a string/);
    expect(() => resolveLearningConfig({ ledgerKey: ' ' }, 'light')).toThrow(/learning\.ledgerKey must not be blank/);
    expect(() => resolveLearningConfig({ clock: 'now' as never }, 'light')).toThrow(/learning\.clock must be a function/);
    expect(() => resolveLearningConfig({ store: {} as never }, 'light')).toThrow(/learning\.store must be a LearningStore/);
    expect(() => resolveLearningConfig({ memoryTools: 'facade' as never }, 'light')).toThrow(/learning\.memoryTools must be an object/);
  });
});

describe('the freeze a tool reads at the call', () => {
  it('refuses frozen before off, and the memory tools only on a freeze', () => {
    let frozen = false;
    const learning = { learner: 'bound', mode: 'off', frozen: () => frozen };
    expect(selfChangeRefusal({ learning }, {})).toBe('off');
    expect(memoryWriteRefusal({ learning }, {})).toBeUndefined();
    frozen = true;
    expect(selfChangeRefusal({ learning }, {})).toBe('frozen');
    expect(memoryWriteRefusal({ learning }, {})).toBe('frozen');
    expect(memoryWriteRefusal(undefined, { AGENTOS_LEARNING_FREEZE: '1' })).toBe('frozen');
    expect(memoryWriteRefusal({ learning: { learner: 'none', mode: 'off' } }, {})).toBeUndefined();
    expect(memoryWriteRefusal({ learning: { learner: 'bound', mode: 'frozen' } }, {})).toBe('frozen');
  });

  it("reads a turn's scopes, its recorder and its second user, and drops a malformed one", () => {
    const scopes = { learner: 'none', mode: 'on', userScopeId: '/s-1', personaScopeId: '/s-1::tutor', namespace: '' };
    const recordSelfChange = async () => ({ status: 'written' as const, result: undefined });
    expect(readToolLearningContext({ learning: { learner: 'none', mode: 'on', scopes, recordSelfChange, turnUserId: 'bo' } })).toEqual({
      learner: 'none',
      mode: 'on',
      scopes,
      recordSelfChange,
      turnUserId: 'bo',
    });
    expect(readToolLearningContext({ learning: { learner: 'none', mode: 'on', scopes: { userScopeId: 7 }, turnUserId: '' } })).toEqual({
      learner: 'none',
      mode: 'on',
    });
  });
});
