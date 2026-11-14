/**
 * @file agentos-default-request.e2e.test.ts
 * What the full runtime adds to a request when the host names nothing: boots AgentOS through `AgentOS.create()` and
 * through `new AgentOS().initialize()` with the OpenAI provider class stubbed at its module boundary, reads every
 * completion request the stub receives and the orchestrator's effective persistence setting, and checks the one
 * `runtime.defaults` event initialization writes. No prompt profile and no date tool reach a request unless the host
 * passes one; `AgentOS.create()` keeps the factory's ENABLE_PERSISTENCE value when the host's orchestrator config
 * leaves that field out. A persona that names the date tool gets it only when the host registers it: the bundled
 * architect persona, whose definition lists the tool, is served either way, and strict persona validation refuses a
 * persona whose `toolIds` name a date tool the host did not register.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ calls: [] as any[], logs: [] as any[], askDate: false }));
vi.mock('../../core/logging/loggerFactory', async (original) => {
  const actual = await original<typeof import('../../core/logging/loggerFactory')>();
  return { ...actual, moduleLogger: (...args: Parameters<typeof actual.moduleLogger>) => {
    const log = actual.moduleLogger(...args);
    return { ...log, info: (event: any, fields: any) => { wire.logs.push({ event, fields }); log.info(event, fields); } };
  } };
});
// The root barrel this file imports reads the module's other exports too, so they are kept.
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: class {
    readonly providerId = 'openai'; isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream(_model: string, messages: any[], options: any) {
      wire.calls.push({ messages, options });
      if (wire.askDate && wire.calls.length === 1) {
        yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
          { id: 'date-1', type: 'function', function: { name: 'getCurrentDateTime', arguments: '{"timezone":"UTC"}' } },
        ] }, finishReason: 'tool_calls' }] };
      } else {
        yield { responseTextDelta: 'Noted.' };
        yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }] };
      }
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  },
}));
import * as root from '../../index';
import { AgentOS } from '../AgentOS';
import { createAgentOSConfig } from '../../core/config/AgentOSConfig';

/** Every system message's text in one request, in order: string content, or the text of its text parts. */
function systemTextOf(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '')
    .join('\n');
}

let os: AgentOS | undefined;
const providers = { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] };
const personas = [{ id: 'defaults', name: 'Defaults', description: 'Default request test.', version: '1.0.0', baseSystemPrompt: 'Host policy.' }];
const exportsOf = root as unknown as Record<string, any>;
async function create(orchestratorConfig: Record<string, unknown> = {}, tools?: unknown[]) {
  os = await AgentOS.create({ modelProviderManagerConfig: providers, personas,
    turnPlanning: { enabled: false }, orchestratorConfig, ...(tools ? { tools } : {}),
  } as any);
  return os;
}
async function send() {
  for await (const chunk of os!.processRequest({ userId: 'u', sessionId: 's', selectedPersonaId: 'defaults', textInput: 'Hello.' } as any)) void chunk;
}
/** Sends one turn as a persona and returns every chunk the stream yields. */
async function turnAs(personaId: string): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of os!.processRequest({ userId: 'u', sessionId: `s-${personaId}`, selectedPersonaId: personaId, textInput: 'Hello.' } as any)) chunks.push(chunk);
  return chunks;
}
/** Whether one captured completion request offers the date tool. */
const offersDate = (call: any): boolean => (call.options.tools ?? [])
  .some((definition: any) => definition.function?.name === 'getCurrentDateTime' || definition.name === 'getCurrentDateTime');
const defaults = () => wire.logs.filter((line) => line.event === 'runtime.defaults');
const persistence = () => (os as any).agentOSOrchestrator.config.enableConversationalPersistence;
beforeEach(() => { wire.calls.length = 0; wire.logs.length = 0; wire.askDate = false; });
afterEach(async () => { if (os) await os.shutdown(); os = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('full-runtime explicit defaults', () => {
  it.each([{}, { promptProfileConfig: null }])('sends no implicit prompt profile with %j', async (config) => {
    await create(config); await send();
    expect(wire.calls.length).toBeGreaterThan(0);
    for (const call of wire.calls) expect(systemTextOf(call.messages)).not.toContain('Meta-Preset: Concise');
    expect(defaults()).toHaveLength(1);
    expect(defaults()[0].fields.promptProfile).toBe('none');
  });
  it('exports and honors the explicit default profile', async () => {
    expect(exportsOf.DEFAULT_PROMPT_PROFILE_CONFIG).toBeDefined();
    await create({ promptProfileConfig: exportsOf.DEFAULT_PROMPT_PROFILE_CONFIG }); await send();
    expect(systemTextOf(wire.calls[0].messages)).toContain('Meta-Preset: Concise');
    expect(defaults()[0].fields.promptProfile).toBe('host');
  });
  it.each([
    ['false', undefined, false, 'environment'],
    ['true', undefined, true, 'environment'],
    ['false', true, true, 'host'],
    ['true', false, false, 'host'],
    [undefined, undefined, true, 'default'],
  ] as const)('resolves create persistence env=%s host=%s', async (environment, host, expected, from) => {
    vi.stubEnv('ENABLE_PERSISTENCE', environment);
    await create(host === undefined ? {} : { enableConversationalPersistence: host });
    await send();
    expect(persistence()).toBe(expected);
    expect(defaults()).toHaveLength(1);
    expect(defaults()[0].fields).toEqual({ promptProfile: 'none', persistence: expected ? 'on' : 'off', persistenceFrom: from, dateTool: 'off' });
  });
  it.each([undefined, false, true] as const)('initialize resolves host persistence %s independently of environment false', async (host) => {
    vi.stubEnv('ENABLE_PERSISTENCE', 'false');
    const config = await createAgentOSConfig();
    os = new AgentOS();
    await os.initialize({ ...config, modelProviderManagerConfig: providers, personas,
      turnPlanning: { enabled: false }, orchestratorConfig: host === undefined ? {} : { enableConversationalPersistence: host },
    } as any);
    await send();
    expect(persistence()).toBe(host ?? true);
    expect(defaults()[0].fields).toMatchObject({ persistence: (host ?? true) ? 'on' : 'off', persistenceFrom: host === undefined ? 'default' : 'host' });
  });
  it('offers no tool or tool choice when the host and discovery supply none', async () => {
    await create(); await send();
    for (const call of wire.calls) {
      expect(call.options.tools).toBeUndefined();
      expect(call.options.toolChoice).toBeUndefined();
    }
    expect(defaults()[0].fields.dateTool).toBe('off');
  });
  it('offers and executes an explicitly registered date tool', async () => {
    const tool = exportsOf.createCurrentDateTimeTool();
    const execute = vi.spyOn(tool, 'execute');
    wire.askDate = true; await create({}, [tool]); await send();
    expect(wire.calls[0].options.tools.some((definition: any) => definition.function?.name === 'getCurrentDateTime' || definition.name === 'getCurrentDateTime')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const result = await execute.mock.results[0].value;
    expect(result).toMatchObject({ success: true, output: { timezoneUsed: 'UTC', isoTimestamp: expect.any(String) } });
    expect(defaults()[0].fields.dateTool).toBe('on');
  });
  it('does not log resolved defaults twice when initialize is called again', async () => {
    await create(); await os!.initialize((os as any).config);
    expect(defaults()).toHaveLength(1);
  });
  it.each([false, true])('serves the bundled architect persona, whose definition lists the date tool, and offers that tool only when the host registers it (registered: %s)', async (registered) => {
    const architect = exportsOf.getBuiltInPersona('atlas-systems-architect');
    expect(architect.tools.enabled).toContain('getCurrentDateTime');
    os = await AgentOS.create({ modelProviderManagerConfig: providers, personas: [architect], turnPlanning: { enabled: false },
      ...(registered ? { tools: [exportsOf.createCurrentDateTimeTool()] } : {}),
    } as any);
    const chunks = await turnAs(architect.id);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(wire.calls.length).toBeGreaterThan(0);
    for (const call of wire.calls) expect(offersDate(call)).toBe(registered);
  });
  it.each([false, true])('under strict persona validation, refuses a persona whose toolIds name the date tool unless the host registers it (registered: %s)', async (registered) => {
    const factory = await createAgentOSConfig();
    os = await AgentOS.create({ modelProviderManagerConfig: providers, turnPlanning: { enabled: false },
      personas: [{ ...personas[0], toolIds: ['getCurrentDateTime'] }],
      gmiManagerConfig: { ...factory.gmiManagerConfig, personaValidationStrict: { enabled: true } },
      ...(registered ? { tools: [exportsOf.createCurrentDateTimeTool()] } : {}),
    } as any);
    const errors = (await turnAs('defaults')).filter((chunk) => chunk.type === 'error');
    if (registered) {
      expect(errors).toEqual([]);
      expect(wire.calls.length).toBeGreaterThan(0);
    } else {
      expect(wire.calls).toHaveLength(0);
      expect(JSON.stringify(errors)).toContain('blocked by strict validation');
    }
  });
});
