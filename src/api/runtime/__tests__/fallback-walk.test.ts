import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceFallbackWalk,
  buildPolicyAwareFallbackChain,
  gateFallbackEntry,
  INITIAL_FALLBACK_WALK,
  resolveFallbackChain,
  resolvePolicyTier,
  type ResolvedFallbackEntry,
} from '../../generateText.js';
import { PolicyAwareRouter } from '../../../core/llm/routing/PolicyAwareRouter.js';
import { createUncensoredModelCatalog } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import { PROVIDER_DEFAULTS } from '../provider-defaults.js';

const LLAMA = 'meta-llama/llama-3.3-70b-instruct';
const MAGNUM = 'anthracite-org/magnum-v4-72b';
const HERMES = 'nousresearch/hermes-3-llama-3.1-70b';
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;

function coded(code: string, message = 'failed') {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}
function status(httpStatus: number) {
  const err = new Error(`[${httpStatus}] failed`) as Error & { httpStatus?: number };
  err.httpStatus = httpStatus;
  return err;
}
const roles = (chain: ResolvedFallbackEntry[]) =>
  chain.map((e) => `${e.model}${e.walkRole ? `(${e.walkRole})` : ''}`);

describe('resolveFallbackChain', () => {
  let saved: Array<[string, string | undefined]>;
  beforeEach(() => {
    saved = ENV_KEYS.map((k) => [k, process.env[k]] as [string, string | undefined]);
    for (const k of ENV_KEYS) process.env[k] = 'test';
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('mature after a Claude first model: two standing legs, then the refill, then the suffix', () => {
    const chain = resolveFallbackChain(buildPolicyAwareFallbackChain('mature', 'anthropic'), {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    expect(roles(chain)).toEqual([
      `${LLAMA}(standing)`,
      `${MAGNUM}(standing)`,
      `${HERMES}(refill)`,
      'gpt-5.6-sol',
      'openai/gpt-5.6-sol',
      'gemini-3.1-pro-preview',
    ]);
  });

  it('mature after llama-3.3-70b failed: its leg dropped, magnum and hermes standing, no refill', () => {
    const skipped: string[] = [];
    const chain = resolveFallbackChain(buildPolicyAwareFallbackChain('mature', 'openrouter'), {
      primary: { provider: 'openrouter', model: LLAMA },
      onSkip: (entry, reason) => skipped.push(`${entry.model}:${reason}`),
    });
    expect(roles(chain).slice(0, 2)).toEqual([`${MAGNUM}(standing)`, `${HERMES}(standing)`]);
    expect(chain.some((e) => e.walkRole === 'refill')).toBe(false);
    expect(skipped).toEqual([`${LLAMA}:failed_primary`]);
  });

  it('private-adult after magnum failed: hermes stands alone', () => {
    const chain = resolveFallbackChain(buildPolicyAwareFallbackChain('private-adult', 'openrouter'), {
      primary: { provider: 'openrouter', model: MAGNUM },
    });
    expect(chain.filter((e) => e.group === 'uncensored').map((e) => `${e.model}(${e.walkRole})`)).toEqual([
      `${HERMES}(standing)`,
    ]);
  });

  it('drops a policy-default suffix entry naming the failed first model, keeps a caller entry naming it', () => {
    const chain = resolveFallbackChain(
      [{ provider: 'openai', model: 'gpt-5.6-sol' }, ...buildPolicyAwareFallbackChain('mature')],
      { primary: { provider: 'openai', model: 'gpt-5.6-sol' } },
    );
    const openai = chain.filter((e) => e.provider === 'openai' && e.model === 'gpt-5.6-sol');
    expect(openai).toHaveLength(1);
    expect(openai[0]!.origin).toBeUndefined();
  });

  it('skips catalog models lacking an explicitly required capability, under either spelling', () => {
    for (const capability of ['function_calling', 'tool_use']) {
      const skipped: string[] = [];
      const chain = resolveFallbackChain(buildPolicyAwareFallbackChain('mature', 'anthropic'), {
        primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        requiredCapabilities: [capability],
        onSkip: (entry, reason) => skipped.push(`${entry.model}:${reason}`),
      });
      const models = chain.map((e) => e.model);
      expect(models).toContain(LLAMA);
      expect(models).not.toContain(MAGNUM);
      expect(models).not.toContain(HERMES);
      expect(models).toContain('gpt-5.6-sol');
      expect(skipped).toEqual([`${MAGNUM}:missing_capability`, `${HERMES}:missing_capability`]);
    }
  });

  it('skips an excluded model', () => {
    const chain = resolveFallbackChain(buildPolicyAwareFallbackChain('mature', 'anthropic'), {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      excludedModelIds: [MAGNUM],
    });
    expect(roles(chain).slice(0, 2)).toEqual([`${LLAMA}(standing)`, `${HERMES}(standing)`]);
  });

  it('checks a leg as it will be sent: a provider default model, a provider-qualified id', () => {
    const skipped: string[] = [];
    const chain = resolveFallbackChain(
      [{ provider: 'openai' }, { provider: 'openrouter', model: `openrouter:${MAGNUM}` }, { provider: 'openrouter', model: LLAMA }],
      {
        primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        excludedModelIds: [PROVIDER_DEFAULTS.openai!.text!],
        requiredCapabilities: ['function_calling'],
        onSkip: (entry, reason) => skipped.push(`${entry.model ?? `${entry.provider} default`}:${reason}`),
      },
    );
    expect(chain.map((e) => e.model)).toEqual([LLAMA]);
    expect(skipped).toEqual(['openai default:excluded_model', `openrouter:${MAGNUM}:missing_capability`]);
  });

  it('matches an exclusion by the model as written and as sent, with or without a provider prefix', () => {
    const skipped: string[] = [];
    const chain = resolveFallbackChain(
      [
        { provider: 'openrouter', model: `openrouter:${MAGNUM}` },
        { provider: 'openrouter', model: MAGNUM },
        { provider: 'openrouter', model: `openrouter:${HERMES}` },
        // Sent as `gpt-5.6-sol` (the prefix repeats the provider): only the
        // written form matches this exclusion.
        { provider: 'openai', model: 'openai/gpt-5.6-sol' },
        { provider: 'openrouter', model: LLAMA },
      ],
      {
        primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        excludedModelIds: [`openrouter:${MAGNUM}`, HERMES, 'openai/gpt-5.6-sol'],
        onSkip: (entry, reason) => skipped.push(`${entry.model}:${reason}`),
      },
    );
    expect(chain.map((e) => e.model)).toEqual([LLAMA]);
    expect(skipped).toEqual([
      `openrouter:${MAGNUM}:excluded_model`,
      `${MAGNUM}:excluded_model`,
      `openrouter:${HERMES}:excluded_model`,
      'openai/gpt-5.6-sol:excluded_model',
    ]);
  });

  it('walks a safe chain verbatim', () => {
    const chain = buildPolicyAwareFallbackChain('safe', 'openai');
    expect(resolveFallbackChain(chain, { primary: { provider: 'openai', model: 'gpt-5.5' } })).toEqual(chain);
  });
});

describe('gateFallbackEntry and advanceFallbackWalk', () => {
  const refill: ResolvedFallbackEntry = {
    provider: 'openrouter',
    model: HERMES,
    origin: 'policy-default',
    group: 'uncensored',
    walkRole: 'refill',
  };
  const claudeDirect: ResolvedFallbackEntry = { provider: 'anthropic', model: 'claude-sonnet-5', origin: 'policy-default' };
  const claudeRouted: ResolvedFallbackEntry = {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    origin: 'policy-default',
  };
  const claudeCaller: ResolvedFallbackEntry = { provider: 'anthropic', model: 'claude-opus-5-5' };

  it('runs a refill only while one is owed, and spends it', () => {
    expect(gateFallbackEntry(INITIAL_FALLBACK_WALK, refill)).toEqual({ run: false, reason: 'refill_not_owed' });
    expect(gateFallbackEntry({ refillsOwed: 1, refusalSeen: false }, refill)).toEqual({
      run: true,
      state: { refillsOwed: 0, refusalSeen: false },
    });
  });

  it('passes over the policy chain Claude legs after a refusal, never a caller Claude leg', () => {
    const afterRefusal = { refillsOwed: 0, refusalSeen: true };
    expect(gateFallbackEntry(afterRefusal, claudeDirect)).toEqual({ run: false, reason: 'claude_after_refusal' });
    expect(gateFallbackEntry(afterRefusal, claudeRouted)).toEqual({ run: false, reason: 'claude_after_refusal' });
    expect(gateFallbackEntry(afterRefusal, claudeCaller).run).toBe(true);
    expect(gateFallbackEntry(INITIAL_FALLBACK_WALK, claudeDirect).run).toBe(true);
  });

  it('owes a refill for a standing leg that failed on availability or did not fit', () => {
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', status(429)).refillsOwed).toBe(1);
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', coded('CONTEXT_WINDOW_EXCEEDED')).refillsOwed).toBe(1);
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', coded('REQUEST_TIMEOUT')).refillsOwed).toBe(1);
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', undefined).refillsOwed).toBe(1);
  });

  it('owes nothing after a content decline, and records only a refusal', () => {
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', coded('content_filter'))).toEqual({
      refillsOwed: 0,
      refusalSeen: true,
    });
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'standing', coded('content_policy_violation'))).toEqual({
      refillsOwed: 0,
      refusalSeen: false,
    });
  });

  it('owes nothing for a refill or the first model, but records the first model refusal', () => {
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, 'refill', status(429)).refillsOwed).toBe(0);
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, undefined, status(429)).refillsOwed).toBe(0);
    expect(advanceFallbackWalk(INITIAL_FALLBACK_WALK, undefined, coded('content_filter')).refusalSeen).toBe(true);
  });
});

describe('resolvePolicyTier', () => {
  const catalog = createUncensoredModelCatalog();

  type TierCase = [opts: Parameters<typeof resolvePolicyTier>[0], expected: string | undefined];
  const TIER_CASES: TierCase[] = [
    [{ routerParams: { policyTier: 'standard' }, policyTier: 'mature' }, 'standard'],
    [{ policyTier: 'mature', router: { policyTier: 'private-adult' } }, 'mature'],
    [{ hostPolicy: {}, router: { policyTier: 'mature' } }, 'standard'],
    [{ hostPolicy: { policyTier: 'private-adult' } }, 'private-adult'],
    [{ router: { policyTier: 'mature' } }, 'mature'],
    [{}, undefined],
  ];
  it.each(TIER_CASES)('%j -> %s', (opts, expected) => {
    expect(resolvePolicyTier(opts)).toBe(expected);
  });

  it('reads a delegating router base default', () => {
    const base = new PolicyAwareRouter(catalog, null, {}, 'private-adult');
    expect(resolvePolicyTier({ router: new PolicyAwareRouter(catalog, base) })).toBe('private-adult');
  });
});
