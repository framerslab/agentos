/**
 * The options souledAgent() gives the model calls of its wiki compile: the agent's route, budget, fallback settings
 * and usage ledger. generateText is replaced by a recorder; the agent, the Memory store and the wiki are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { generateTextSpy } = vi.hoisted(() => ({
  generateTextSpy: vi.fn(async (_opts: Record<string, unknown>) => ({ text: 'Merged page.' })),
}));
vi.mock('../generateText.js', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, generateText: generateTextSpy };
});

import { souledAgent } from '../souledAgent.js';
import { SpendBudget } from '../runtime/spendBudget.js';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey.js';

let dir: string;
beforeEach(() => {
  generateTextSpy.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-compile-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("souledAgent()'s wiki compile", () => {
  it("calls the model with the agent's budget, fallback settings and usage ledger, under a source of its own", async () => {
    const budget = new SpendBudget({ maxCostUSD: 5, unpriced: 'allow' });
    const fallbackProviders = [{ provider: 'anthropic', model: 'claude-x' }];
    const onFallback = vi.fn();
    const a = await souledAgent({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      soul: dir,
      budget,
      fallbackProviders,
      onFallback,
      usageLedger: { enabled: true, path: path.join(dir, 'ledger.jsonl'), sessionId: 'night' },
    } as never);
    await a.memory!.remember('Johnny likes green tea', {
      type: 'episodic',
      scope: 'conversation',
      scopeId: conversationScopeKey('aria-1', { kind: 'user', id: 'u1' }),
    });
    await a.memory!.compileWiki();
    await a.close();

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    const options = generateTextSpy.mock.calls[0][0];
    expect(options).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      fallbackProviders,
      onFallback,
      usageLedger: { enabled: true, path: path.join(dir, 'ledger.jsonl'), sessionId: 'night', source: 'souledAgent.compileWiki' },
    });
    // The very budget the agent holds, so the compile and the turns draw on one total.
    expect(options.budget).toBe(budget);
  });
});
