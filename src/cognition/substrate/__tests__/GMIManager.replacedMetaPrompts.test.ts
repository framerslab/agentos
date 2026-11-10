/**
 * @file GMIManager.replacedMetaPrompts.test.ts
 * A persona whose `metaPrompts` is not an array is reported as `invalid_metaprompts` even when its sentiment
 * presets replace that value at load, so strict mode can block it, through a host `IPersonaLoader`, the
 * file-system `PersonaLoader` and the `InMemoryPersonaLoader`. The stored persona keeps the merged presets, and a
 * session for the blocked persona cannot start. A loader that wraps another keeps the report only when it passes the
 * definitions through or copies them with `clonePersonaDefinition`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GMIManager } from '../GMIManager';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import { PersonaLoader } from '../personas/PersonaLoader';
import { InMemoryPersonaLoader } from '../personas/InMemoryPersonaLoader';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import { clonePersonaDefinition } from '../personas/personaNormalization';
import type { PersonaValidationStrictConfig } from '../personas/PersonaValidation';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import { GMIErrorCode } from '../../../core/utils/errors';

const REPLACED =
  '{"id":"a","name":"a","version":"1.0.0","baseSystemPrompt":"x","metaPrompts":{"id":"custom","description":"c","promptTemplate":"t","trigger":{"type":"manual"}},"sentimentTracking":{"enabled":true,"presets":["frustration_recovery"]}}';
const KEPT =
  '{"id":"k","name":"k","version":"1.0.0","baseSystemPrompt":"x","metaPrompts":[{"id":"custom","description":"c","promptTemplate":"t","trigger":{"type":"manual"}}],"sentimentTracking":{"enabled":true,"presets":["frustration_recovery"]}}';

const STRICT: PersonaValidationStrictConfig = { enabled: true, mode: 'activation_block', blockOnCodes: ['invalid_metaprompts'] };

/** A host loader that hands back parsed JSON as it is, without normalizing it. */
function hostLoader(definitions: IPersonaDefinition[]): IPersonaLoader {
  return {
    initialize: async () => undefined,
    loadPersonaById: async (id: string) => definitions.find((definition) => definition.id === id),
    loadAllPersonaDefinitions: async () => definitions,
  } as unknown as IPersonaLoader;
}

function createManager(loader: IPersonaLoader, personaSource: string) {
  return new GMIManager(
    { personaLoaderConfig: { personaSource }, personaValidationStrict: STRICT },
    undefined,
    undefined,
    { getOrCreateConversationContext: async () => new ConversationContext('conv-1') } as unknown as ConversationManager,
    { estimateTokenCount: async () => 10 } as unknown as IPromptEngine,
    {} as unknown as AIModelProviderManager,
    {} as unknown as IUtilityAI,
    { listAvailableTools: async () => [] } as unknown as IToolOrchestrator,
    undefined,
    loader,
  );
}

type RecordView = { status: string; blockedReasons?: string[]; validation?: { issues: { code: string }[] } };
const recordsOf = (manager: GMIManager) =>
  (manager as unknown as { allPersonaRecords: Map<string, RecordView> }).allPersonaRecords;
const codesOf = (manager: GMIManager, id: string) => recordsOf(manager).get(id)?.validation?.issues.map((issue) => issue.code) ?? [];

/** The checks every loader path must pass: reported, blockable, stored with the presets merged. */
function expectReplacedReportedAndBlocked(manager: GMIManager) {
  expect(manager.getPersonaDefinition('a')!.metaPrompts!.map((metaPrompt) => metaPrompt.id)).toEqual(['gmi_frustration_recovery']);
  expect(codesOf(manager, 'a')).toContain('invalid_metaprompts');
  expect(recordsOf(manager).get('a')?.status).toBe('invalid');
  expect(recordsOf(manager).get('a')?.blockedReasons).toEqual(['invalid_metaprompts']);

  expect(manager.getPersonaDefinition('k')!.metaPrompts!.map((metaPrompt) => metaPrompt.id)).toEqual(['gmi_frustration_recovery', 'custom']);
  expect(codesOf(manager, 'k')).not.toContain('invalid_metaprompts');
  expect(recordsOf(manager).get('k')?.status).not.toBe('invalid');
}

describe('a persona whose non-array metaPrompts is replaced by its sentiment presets', () => {
  let dir: string;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-metaprompts-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is reported as invalid_metaprompts and blocked by blockOnCodes through a host IPersonaLoader', async () => {
    const replaced = JSON.parse(REPLACED) as IPersonaDefinition;
    const manager = createManager(hostLoader([replaced, JSON.parse(KEPT) as IPersonaDefinition]), 'host');
    await manager.initialize();
    expectReplacedReportedAndBlocked(manager);
    // The host's own object is left as it was.
    expect(replaced).toEqual(JSON.parse(REPLACED));
    await manager.shutdown();
  });

  it('is reported as invalid_metaprompts and blocked by blockOnCodes through the file PersonaLoader', async () => {
    await fs.writeFile(path.join(dir, 'a.json'), REPLACED, 'utf-8');
    await fs.writeFile(path.join(dir, 'k.json'), KEPT, 'utf-8');
    const manager = createManager(new PersonaLoader(), dir);
    await manager.initialize();
    expectReplacedReportedAndBlocked(manager);
    await manager.shutdown();
  });

  it('is reported as invalid_metaprompts and blocked by blockOnCodes through the InMemoryPersonaLoader', async () => {
    const loader = new InMemoryPersonaLoader([JSON.parse(REPLACED), JSON.parse(KEPT)] as IPersonaDefinition[]);
    const manager = createManager(loader, 'memory');
    await manager.initialize();
    expectReplacedReportedAndBlocked(manager);
    await manager.shutdown();
  });

  it('refuses a session for the blocked persona with PERMISSION_DENIED', async () => {
    const loader = new InMemoryPersonaLoader([JSON.parse(REPLACED), JSON.parse(KEPT)] as IPersonaDefinition[]);
    const manager = createManager(loader, 'memory');
    await manager.initialize();
    expectReplacedReportedAndBlocked(manager);

    await expect(manager.getOrCreateGMIForSession('user-1', 'session-1', 'a')).rejects.toMatchObject({
      code: GMIErrorCode.PERMISSION_DENIED,
      details: { requestedPersonaId: 'a', blockedReasons: ['invalid_metaprompts'] },
    });
    expect(manager.activeGMIs.size).toBe(0);
    await manager.shutdown();
  });

  it('keeps the report through a wrapping loader that copies with clonePersonaDefinition, and loses it through a spread', async () => {
    const inner = new InMemoryPersonaLoader([JSON.parse(REPLACED), JSON.parse(KEPT)] as IPersonaDefinition[]);
    const wrapping = (copy: (definition: IPersonaDefinition) => IPersonaDefinition): IPersonaLoader =>
      ({
        initialize: (config: Parameters<IPersonaLoader['initialize']>[0]) => inner.initialize(config),
        loadPersonaById: async (id: string) => {
          const definition = await inner.loadPersonaById(id);
          return definition ? copy(definition) : undefined;
        },
        loadAllPersonaDefinitions: async () => (await inner.loadAllPersonaDefinitions()).map(copy),
      }) as unknown as IPersonaLoader;

    const cloned = createManager(wrapping(clonePersonaDefinition), 'cloned');
    await cloned.initialize();
    expectReplacedReportedAndBlocked(cloned);
    await cloned.shutdown();

    // The documented limit: a spread is a new object without the record, so the persona loads with only the preset
    // metaprompts and nothing reports or blocks it.
    const spread = createManager(wrapping((definition) => ({ ...definition })), 'spread');
    await spread.initialize();
    expect(spread.getPersonaDefinition('a')!.metaPrompts!.map((metaPrompt) => metaPrompt.id)).toEqual(['gmi_frustration_recovery']);
    expect(codesOf(spread, 'a')).not.toContain('invalid_metaprompts');
    expect(recordsOf(spread).get('a')?.status).not.toBe('invalid');
    await spread.shutdown();
  });
});
