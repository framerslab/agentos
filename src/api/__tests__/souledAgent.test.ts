import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { format, inspect } from 'node:util';

// Spy on the real `agent` factory so we can inspect what souledAgent passes it,
// while keeping loadSoulFromOption (and the rest of agent.js) real.
const { agentSpy, fakeAgent } = vi.hoisted(() => {
  // A stand-in with the whole Agent surface souledAgent wraps: generate, stream, session and close.
  const fakeAgent = (o: unknown, close: () => Promise<void> = async () => {}) => {
    const stream = () => ({ usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }) });
    return {
      __agentOpts: o,
      generate: async () => ({ text: '' }),
      stream,
      session: () => ({ id: 's', send: async () => ({ text: '' }), stream, close: async () => {} }),
      close,
    };
  };
  return { fakeAgent, agentSpy: vi.fn((o: unknown) => fakeAgent(o)) };
});
vi.mock('../agent.js', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, agent: agentSpy };
});

import pino from 'pino';
import { souledAgent } from '../souledAgent.js';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory.js';
import { Memory } from '../../cognition/memory/io/facade/Memory.js';
import { WikiMemoryStore } from '../../cognition/substrate/memory/wiki/WikiMemoryStore.js';

/**
 * The runtimes every case runs on, each as the options that select it: `runtime: 'legacy'`, and no `runtime` at
 * all, which is souledAgent()'s default. A case that names a runtime of its own runs on that one under both.
 */
const RUNTIMES = [
  ["runtime: 'legacy'", { runtime: 'legacy' }],
  ['no runtime set', {}],
] as const;
/** The runtime options of the suite that is running: each suite of the runtimes sets them before its cases. */
let RUNTIME: (typeof RUNTIMES)[number][1] = RUNTIMES[0][1];

let dir: string;
beforeEach(() => {
  agentSpy.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
});
afterEach(() => {
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The library's log lines from here to the end of the case, parsed, as the host's logger receives them. */
function logLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}
/** The console lines of souledAgent's own among a spy's calls. */
const ownConsoleLines = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].includes('souledAgent'));

describe.each(RUNTIMES)('with %s', (_name, runtime) => {
  beforeAll(() => {
    RUNTIME = runtime;
  });

  describe('souledAgent', () => {
    it('wires a memory provider + read_memory_page tool and creates the wiki store', async () => {
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Facts\n\nUser prefers terse commits.');
      const existingTool = { name: 'other_tool' };
      await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir, tools: [existingTool] } as any);

      expect(agentSpy).toHaveBeenCalledTimes(1);
      const passed = agentSpy.mock.calls[0][0] as any;
      expect(passed.memoryProvider).toBeTruthy();
      expect(typeof passed.memoryProvider.observe).toBe('function');
      expect(typeof passed.memoryProvider.getContext).toBe('function');
      const toolNames = passed.tools.map((t: any) => t.name);
      expect(toolNames).toContain('other_tool');
      expect(toolNames).toContain('read_memory_page');
      expect(fs.existsSync(path.join(dir, 'memory', '.store', 'memory.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'memory', 'index.md'))).toBe(true);
    });

    it('closes the memory store when the agent is closed', async () => {
      const closeSpy = vi.spyOn(Memory.prototype, 'close');
      const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
      await a.close();
      expect(closeSpy).toHaveBeenCalled();
      closeSpy.mockRestore();
    });

    it('exposes the memory store on the returned agent for manual compilation', async () => {
      const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
      expect(a.memory).toBeTruthy();
      expect(typeof a.memory.compileWiki).toBe('function');
      await a.close();
    });

    it('folds conversation into the wiki on close (best-effort compileWiki)', async () => {
      const compileSpy = vi.spyOn(Memory.prototype, 'compileWiki');
      const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
      await a.close();
      expect(compileSpy).toHaveBeenCalled();
      compileSpy.mockRestore();
    });

    it('logs one line when the compile on close fails, and still closes the agent and the store', async () => {
      const agentClose = vi.fn(async () => {});
      agentSpy.mockImplementationOnce((o: unknown) => fakeAgent(o, agentClose));
      const compile = vi.spyOn(Memory.prototype, 'compileWiki').mockRejectedValue(new Error('disk full'));
      const storeClose = vi.spyOn(Memory.prototype, 'close');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
        const log = logLines();
        warn.mockClear();
        await expect(a.close()).resolves.toBeUndefined();

        expect(compile).toHaveBeenCalled();
        // Through the host's logger, with the error's listed type and code and never its text; nothing on the console.
        expect(log.filter((line) => line.event === 'memory.close_compile_failed')).toEqual([
          expect.objectContaining({ type: 'Error', code: 'unknown' }),
        ]);
        expect(JSON.stringify(log)).not.toContain('disk full');
        expect(ownConsoleLines(warn)).toEqual([]);
        expect(agentClose).toHaveBeenCalledTimes(1);
        expect(storeClose).toHaveBeenCalled();
      } finally {
        compile.mockRestore();
        storeClose.mockRestore();
        warn.mockRestore();
      }
    });

    it('logs one line and still closes when the compile on close fails with a value that cannot be turned into text', async () => {
      const agentClose = vi.fn(async () => {});
      agentSpy.mockImplementationOnce((o: unknown) => fakeAgent(o, agentClose));
      // An object with no prototype has no toString: String() of it throws.
      const compile = vi.spyOn(Memory.prototype, 'compileWiki').mockRejectedValue(Object.create(null));
      const storeClose = vi.spyOn(Memory.prototype, 'close');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
        const log = logLines();
        warn.mockClear();
        await expect(a.close()).resolves.toBeUndefined();

        expect(log.filter((line) => line.event === 'memory.close_compile_failed')).toEqual([
          expect.objectContaining({ type: expect.any(String), code: 'unknown' }),
        ]);
        expect(ownConsoleLines(warn)).toEqual([]);
        expect(agentClose).toHaveBeenCalledTimes(1);
        expect(storeClose).toHaveBeenCalled();
      } finally {
        compile.mockRestore();
        storeClose.mockRestore();
        warn.mockRestore();
      }
    });

    it('logs one line and still closes when the compile on close fails with an error that cannot be inspected', async () => {
      const agentClose = vi.fn(async () => {});
      agentSpy.mockImplementationOnce((o: unknown) => fakeAgent(o, agentClose));
      const error = new Error('disk full');
      Object.defineProperty(error, inspect.custom, { value: () => { throw new Error('cannot inspect'); } });
      const compile = vi.spyOn(Memory.prototype, 'compileWiki').mockRejectedValue(error);
      const storeClose = vi.spyOn(Memory.prototype, 'close');
      // Formats its arguments as the console does, so an argument that cannot be inspected throws here as it would there.
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        format(...args);
      });
      try {
        const a = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
        const log = logLines();
        warn.mockClear();
        await expect(a.close()).resolves.toBeUndefined();

        expect(log.filter((line) => line.event === 'memory.close_compile_failed')).toEqual([
          expect.objectContaining({ type: 'Error', code: 'unknown' }),
        ]);
        expect(JSON.stringify(log)).not.toContain('disk full');
        expect(ownConsoleLines(warn)).toEqual([]);
        expect(agentClose).toHaveBeenCalledTimes(1);
        expect(storeClose).toHaveBeenCalled();
      } finally {
        compile.mockRestore();
        storeClose.mockRestore();
        warn.mockRestore();
      }
    });

    it('starts with pages named after members every object has, and finds their index entries on the next start', async () => {
      const memoryDir = path.join(dir, 'memory');
      fs.mkdirSync(memoryDir);
      const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
      for (const name of names) {
        fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\nsummary: The ${name} page.\n---\nNotes on the page ${name}.\n`);
      }
      const indexEntries = () => JSON.parse(fs.readFileSync(path.join(memoryDir, '.meta', 'index.json'), 'utf8')).pages;

      const first = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
      await first.close();
      const entries = indexEntries();
      expect(Object.keys(entries).sort()).toEqual([...names].sort());

      // Each page finds its own entry, so the next start's index skips all five and indexes none of them again.
      const index = vi.spyOn(WikiMemoryStore.prototype, 'index');
      let boot: any;
      try {
        const second = (await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
        // The start's first index is the boot index over memory/.
        boot = await index.mock.results[0]?.value;
        await second.close();
      } finally {
        index.mockRestore();
      }
      expect({ ...boot, skipped: [...boot.skipped].sort() }).toEqual({
        indexed: [],
        skipped: [...names].sort(),
        removed: [],
      });
      expect(indexEntries()).toEqual(entries);
    });

    it('falls back to a plain agent for an inline soul with no workspace', async () => {
      await souledAgent({ ...RUNTIME, provider: 'openai', model: 'gpt-4o', soul: { content: '---\nname: X\n---\nhi' } } as any);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      const passed = agentSpy.mock.calls[0][0] as any;
      expect(passed.memoryProvider).toBeUndefined();
    });
  });
});
