/**
 * @file agentos-reasoning-trace.test.ts
 * Boots the real runtime with a provider stub and checks the reasoning-trace
 * limits end to end: a persona's `reasoningTraceConfig`, defined inline or
 * loaded from SOUL.md frontmatter, beats the runtime default set through
 * `gmiManagerConfig.defaultGMIBaseConfigDefaults`; the default applies to a
 * persona that sets none; and the GMI serving each session keeps exactly that
 * many entries once enough turns have run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize(_config: Record<string, unknown>) {
      this.isInitialized = true;
    }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream() {
      yield { responseTextDelta: 'Noted.' };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { parseSoul } from '../../cognition/substrate/personas/SoulLoader';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { REASONING_TRACE_MIN_ENTRIES } from '../../cognition/substrate/reasoningTraceLimits';
import type { ReasoningTrace } from '../../cognition/substrate/IGMI';

const inline: IPersonaDefinition = {
  id: 'trace-inline', name: 'Trace Inline', description: 'Sets its own trace limit.', version: '1.0.0',
  baseSystemPrompt: 'You are terse.', reasoningTraceConfig: { maxEntries: 25 },
};
const plain: IPersonaDefinition = {
  id: 'trace-plain', name: 'Trace Plain', description: 'Takes the runtime default.', version: '1.0.0', baseSystemPrompt: 'You are terse.',
};
const soul: IPersonaDefinition = {
  ...parseSoul('---\nname: Trace Soul\nagentId: trace-soul\nreasoningTrace:\n  maxEntries: 30\n  maxMessageLength: 40\n---\nYou are terse.').personaDefinition,
  id: 'trace-soul',
};
const providers = { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] };
const RUNTIME_DEFAULT = REASONING_TRACE_MIN_ENTRIES;

let booted: AgentOS | undefined;
afterEach(async () => {
  await (booted as unknown as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.()?.catch(() => undefined);
  booted = undefined;
});

// No storageAdapter: the runtime boots on the package's Prisma stub with in-memory conversations.
async function boot(): Promise<AgentOS> {
  booted = await AgentOS.create({
    modelProviderManagerConfig: providers,
    turnPlanning: { enabled: false },
    personas: [inline, plain, soul],
    gmiManagerConfig: { defaultGMIBaseConfigDefaults: { defaultReasoningTraceMaxEntries: RUNTIME_DEFAULT } },
  } as any);
  return booted;
}

async function turn(agentos: AgentOS, personaId: string, i: number): Promise<void> {
  for await (const _chunk of agentos.processRequest({ userId: 'user-1', sessionId: `s-${personaId}`, selectedPersonaId: personaId, textInput: `Turn ${i}` } as any)) {
    // drain
  }
}

async function trace(agentos: AgentOS, personaId: string): Promise<Readonly<ReasoningTrace>> {
  const { gmi } = await agentos.getGMIManager().getOrCreateGMIForSession('user-1', `s-${personaId}`, personaId);
  return gmi.getReasoningTrace();
}

/** Runs turns until the trace holds `cap` entries, then two more, and returns the trace. */
async function fill(agentos: AgentOS, personaId: string, cap: number) {
  let i = 0;
  while ((await trace(agentos, personaId)).entries.length < cap && i < 40) {
    await turn(agentos, personaId, i++);
  }
  await turn(agentos, personaId, i++);
  await turn(agentos, personaId, i++);
  return trace(agentos, personaId);
}

describe('reasoning-trace limits through the runtime', () => {
  it('applies the inline persona limit over the runtime default', async () => {
    const agentos = await boot();
    const t = await fill(agentos, 'trace-inline', 25);
    expect(t.entries.length).toBe(25);
  });

  it('applies the runtime default to a persona that sets none', async () => {
    const agentos = await boot();
    const t = await fill(agentos, 'trace-plain', RUNTIME_DEFAULT);
    expect(t.entries.length).toBe(RUNTIME_DEFAULT);
  });

  it('applies limits loaded from SOUL.md frontmatter, message cap included', async () => {
    const agentos = await boot();
    const t = await fill(agentos, 'trace-soul', 30);
    expect(t.entries.length).toBe(30);
    expect(t.entries.every((entry) => entry.message.length <= 40)).toBe(true);
  });
});
