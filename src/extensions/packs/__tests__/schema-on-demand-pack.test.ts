import { describe, it, expect, vi } from 'vitest';

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { ExtensionManager } from '../../ExtensionManager';
import { EXTENSION_KIND_TOOL } from '../../types';
import { createSchemaOnDemandPack } from '../schema-on-demand-pack';

// AgentOS keeps the extensions registry bundle as an optional dependency. For unit tests,
// use a small virtual mock so schema-on-demand behavior is deterministic.
(vi as any).mock(
  '@framers/agentos-extensions-registry',
  () => ({
    getAvailableExtensions: async () => [
      { name: 'web-search', packageName: '@framers/agentos-ext-web-search' },
      { name: 'cli-executor', packageName: '@framers/agentos-ext-cli-executor' },
    ],
  }),
  { virtual: true },
);

describe('createSchemaOnDemandPack', () => {
  it('enables an extension pack from a local module and exposes new tool schemas next iteration', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentos-schema-on-demand-'));
    const modulePath = path.join(tmpDir, 'test-pack.mjs');

    await fs.writeFile(
      modulePath,
      [
        'export function createExtensionPack() {',
        '  const tool = {',
        "    id: 'hello-tool-v1',",
        "    name: 'hello_tool',",
        "    displayName: 'Hello Tool',",
        "    description: 'A tiny test tool',",
        '    inputSchema: { type: \"object\", properties: {}, additionalProperties: false },',
        '    hasSideEffects: false,',
        '    async execute() { return { success: true, output: { ok: true } }; },',
        '  };',
        '  return {',
        "    name: '@test/schema-on-demand-pack',",
        "    version: '0.0.0',",
        '    descriptors: [',
        "      { id: tool.name, kind: 'tool', payload: tool },",
        '    ],',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new ExtensionManager({});
    await manager.loadPackFromFactory(
      createSchemaOnDemandPack({ extensionManager: manager, options: { allowModules: true } }),
      'schema-on-demand-test',
    );

    const enableTool = manager.getRegistry<any>(EXTENSION_KIND_TOOL).getActive('extensions_enable')?.payload as any;
    expect(enableTool).toBeTruthy();

    const first = await enableTool.execute({ extension: modulePath, source: 'module' }, {} as any);
    expect(first.success).toBe(true);
    expect(first.output?.loaded).toBe(true);
    expect(first.output?.toolsAdded).toContain('hello_tool');

    const hello = manager.getRegistry<any>(EXTENSION_KIND_TOOL).getActive('hello_tool')?.payload as any;
    expect(hello).toBeTruthy();

    const second = await enableTool.execute({ extension: modulePath, source: 'module' }, {} as any);
    expect(second.success).toBe(true);
    expect(second.output?.loaded).toBe(false);
    expect(second.output?.skipped).toBe(true);
    expect(second.output?.reason).toBe('already_loaded');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('enforces official registry allowlist for package loading by default', async () => {
    const manager = new ExtensionManager({});
    await manager.loadPackFromFactory(
      createSchemaOnDemandPack({ extensionManager: manager, options: { allowPackages: true } }),
      'schema-on-demand-registry-policy',
    );

    const enableTool = manager.getRegistry<any>(EXTENSION_KIND_TOOL).getActive('extensions_enable')?.payload as any;
    expect(enableTool).toBeTruthy();

    const denied = await enableTool.execute(
      { extension: '@totally-not-real/evil-pack', source: 'package', dryRun: true },
      {} as any,
    );
    expect(denied.success).toBe(false);
    expect(String(denied.error || '')).toMatch(/official registry/i);

    // Curated source should accept official package names even when explicit package loading is disabled.
    const manager2 = new ExtensionManager({});
    await manager2.loadPackFromFactory(
      createSchemaOnDemandPack({ extensionManager: manager2, options: { allowPackages: false } }),
      'schema-on-demand-curated-package-name',
    );

    const enableTool2 = manager2.getRegistry<any>(EXTENSION_KIND_TOOL).getActive('extensions_enable')?.payload as any;
    expect(enableTool2).toBeTruthy();

    const allowed = await enableTool2.execute(
      { extension: '@framers/agentos-ext-web-search', source: 'curated', dryRun: true },
      {} as any,
    );
    expect(allowed.success).toBe(true);
    expect(allowed.output?.resolved?.packageName).toBe('@framers/agentos-ext-web-search');
  });
});
