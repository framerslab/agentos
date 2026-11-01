/**
 * @file conversation-tables-provenance.e2e.test.ts
 * The full runtime's conversation tables under conversationManagerConfig.tablePrefix, with the provenance pack active
 * in sealed mode. A storage policy names the tables it protects exactly, and the sealed profiles name `conversations`
 * and `conversation_messages`: a runtime whose conversations a prefix would keep under names its policy leaves
 * unprotected refuses to start, naming the tables to add. Once the policy lists them, the runtime starts, saves a
 * conversation, and refuses to rewrite or delete its rows. With no prefix the sealed profile starts as it is.
 * AgentOS.create(); only the OpenAI provider class is stubbed, and no model is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream() {
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { AgentOS } from '../AgentOS';
import { createAgentOSConfig } from '../../core/config/AgentOSConfig';
import { MessageRole } from '../../core/conversation/ConversationMessage';
import { GMIErrorCode } from '../../core/utils/errors';
import { createProvenancePack } from '../../extensions/packs/provenance-pack';
import { profiles } from '../../safety/provenance/config/PolicyProfiles';
import type { ProvenanceSystemConfig } from '../../safety/provenance/types';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

const tutor = {
  id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0',
  baseSystemPrompt: 'You teach networking.', personalityTraits: { honesty: 0.9 },
} as unknown as IPersonaDefinition;

let booted: AgentOS | undefined;
let adapter: StorageAdapter | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  if (adapter) await adapter.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  booted = undefined;
  adapter = undefined;
  dir = undefined;
  vi.restoreAllMocks();
});

/** The sealed profile with no anchoring timer, protecting `protectedTables` when given and the profile's own list otherwise. */
const sealed = (protectedTables?: string[]): ProvenanceSystemConfig =>
  profiles.custom(profiles.sealedAutonomous(), {
    anchorIntervalMs: 0,
    ...(protectedTables ? { storagePolicy: { mode: 'sealed' as const, protectedTables } } : {}),
  });

/** The full runtime on a fresh SQLite file, with the provenance pack on it and the conversations append-only. */
async function bootSealed(policy: ProvenanceSystemConfig, tablePrefix?: string): Promise<AgentOS> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-provenance-e2e-'));
  const db = await resolveStorageAdapter({ filePath: path.join(dir, 'one.sqlite'), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapter = db;
  const base = await createAgentOSConfig();
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [tutor],
    storageAdapter: db,
    extensionManifest: { packs: [{ factory: () => createProvenancePack(policy, db, 'agent-sealed') }] },
    conversationManagerConfig: {
      ...base.conversationManagerConfig,
      persistenceEnabled: true,
      appendOnlyPersistence: true,
      ...(tablePrefix === undefined ? {} : { tablePrefix }),
    },
  } as any);
  return booted;
}

/** The adapter the runtime keeps its conversations through: the provenance-wrapped one. */
const conversationsAdapterOf = (agentos: AgentOS): StorageAdapter =>
  (agentos.getConversationManager() as unknown as { storageAdapter: StorageAdapter }).storageAdapter;

describe("a sealed provenance policy and the runtime's conversation tables under a prefix", () => {
  it('refuses to start where the policy protects the tables by their default names, naming the tables to add', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(bootSealed(sealed(), 'agentos_')).rejects.toMatchObject({
      code: GMIErrorCode.CONFIGURATION_ERROR,
      message: expect.stringMatching(/agentos_conversations, agentos_conversation_messages[\s\S]*protectedTables/),
    });
  });

  it('starts once the policy lists the prefixed tables, saves a conversation, and refuses to rewrite or delete its rows', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await bootSealed(
      sealed(['conversations', 'conversation_messages', 'messages', 'agentos_conversations', 'agentos_conversation_messages']),
      'agentos_',
    );
    const manager = agentos.getConversationManager();
    const context = await manager.getOrCreateConversationContext('conv-sealed', 'u-1');
    context.addMessage({ role: MessageRole.USER, content: 'kept as written' });
    await manager.saveConversation(context);
    expect(await adapter!.all('SELECT content FROM agentos_conversation_messages')).toEqual([{ content: 'kept as written' }]);

    const through = conversationsAdapterOf(agentos);
    await expect(through.run("UPDATE agentos_conversations SET title = 'rewritten' WHERE id = ?", ['conv-sealed'])).rejects.toMatchObject({
      code: 'SEALED_MUTATION_BLOCKED',
    });
    await expect(through.run('DELETE FROM agentos_conversation_messages WHERE conversation_id = ?', ['conv-sealed'])).rejects.toMatchObject({
      code: 'SEALED_MUTATION_BLOCKED',
    });
    expect(await adapter!.all('SELECT content FROM agentos_conversation_messages')).toEqual([{ content: 'kept as written' }]);
  });

  it('starts with the sealed profile as it is when the tables keep their default names, and protects them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await bootSealed(sealed());
    await expect(
      conversationsAdapterOf(agentos).run("UPDATE conversations SET title = 'rewritten' WHERE id = ?", ['conv-none']),
    ).rejects.toMatchObject({ code: 'SEALED_MUTATION_BLOCKED' });
  });
});
