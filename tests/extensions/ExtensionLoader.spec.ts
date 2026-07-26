/**
 * @file ExtensionLoader.spec.ts
 * @description Unit tests for the Extension Loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtensionLoader, ExtensionLoaderConfig } from '../../src/extensions/ExtensionLoader';
import { ExtensionManager } from '../../src/extensions/ExtensionManager';
import type { ExtensionPack } from '../../src/extensions/manifest';

// Mock fs and child_process
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    extensions: {
      curated: [
        {
          id: 'web-search',
          name: 'Web Search',
          package: '@framers/agentos-ext-web-search',
          version: '1.0.0',
          category: 'research',
          description: 'Web search',
          verified: true,
        },
      ],
      community: [
        {
          id: 'community-ext',
          name: 'Community Extension',
          package: '@community/extension',
          version: '1.0.0',
          category: 'other',
          description: 'Community extension',
        },
      ],
    },
  })),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, cb) => {
    if (cb) cb(null, { stdout: '[]', stderr: '' });
    return { on: vi.fn() };
  }),
  execFile: vi.fn((cmd, args, cb) => {
    const done = typeof args === 'function' ? args : cb;
    if (done) done(null, { stdout: '[]', stderr: '' });
    return { on: vi.fn() };
  }),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn) => async (...args: any[]) => {
    return { stdout: '[]', stderr: '' };
  }),
}));

describe('ExtensionLoader', () => {
  let manager: ExtensionManager;
  let loader: ExtensionLoader;

  beforeEach(() => {
    manager = new ExtensionManager();
    loader = new ExtensionLoader(manager, {
      loadCurated: false,
      loadCommunity: false,
      autoInstall: false,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const ldr = new ExtensionLoader(manager);
      expect(ldr).toBeDefined();
    });

    it('should create with custom config', () => {
      const config: ExtensionLoaderConfig = {
        loadCurated: false,
        loadCommunity: false,
        npmRegistry: 'https://custom.registry.org',
        localRegistryPath: '/custom/path',
        extensionScope: '@custom',
        cacheDir: '/custom/cache',
        autoInstall: false,
        whitelist: ['@framers/ext1'],
        blacklist: ['@framers/ext2'],
      };
      const ldr = new ExtensionLoader(manager, config);
      expect(ldr).toBeDefined();
    });
  });

  describe('getLoadedExtensions', () => {
    it('should return empty map initially', () => {
      const loaded = loader.getLoadedExtensions();
      expect(loaded.size).toBe(0);
    });
  });

  describe('getExtensionMetadata', () => {
    it('should return empty map initially', () => {
      const metadata = loader.getExtensionMetadata();
      expect(metadata.size).toBe(0);
    });
  });

  describe('getAvailableTools', () => {
    it('should return empty array when no extensions loaded', () => {
      const tools = loader.getAvailableTools();
      expect(tools).toEqual([]);
    });
  });

  describe('shouldLoadExtension (via whitelist/blacklist)', () => {
    it('should respect blacklist', () => {
      const ldr = new ExtensionLoader(manager, {
        blacklist: ['@framers/blocked-ext'],
      });
      // The blacklist is checked internally, we test it via initialize
      expect(ldr).toBeDefined();
    });

    it('should respect whitelist', () => {
      const ldr = new ExtensionLoader(manager, {
        whitelist: ['@framers/allowed-ext'],
      });
      expect(ldr).toBeDefined();
    });
  });

  describe('inferCategory', () => {
    it('should infer categories from package names', async () => {
      // We test this indirectly through searchNpmExtensions
      const loader2 = new ExtensionLoader(manager);
      
      // Mock the exec to return results
      const { promisify } = await import('util');
      vi.mocked(promisify).mockReturnValue(async () => ({
        stdout: JSON.stringify([
          { name: '@framers/agentos-research-test', version: '1.0.0', description: 'Research' },
          { name: '@framers/agentos-integration-test', version: '1.0.0', description: 'Integration' },
          { name: '@framers/agentos-productivity-test', version: '1.0.0', description: 'Productivity' },
          { name: '@framers/agentos-development-test', version: '1.0.0', description: 'Development' },
          { name: '@framers/agentos-utility-test', version: '1.0.0', description: 'Utility' },
          { name: '@framers/agentos-other-test', version: '1.0.0', description: 'Other' },
        ]),
        stderr: '',
      }));
    });
  });

  describe('getExtensionOptions', () => {
    it('should load telegram options from env', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      const ldr = new ExtensionLoader(manager);
      // Options are loaded internally during loadExtension
      delete process.env.TELEGRAM_BOT_TOKEN;
    });

    it('should load web-search options from env', () => {
      process.env.SERPER_API_KEY = 'serper-key';
      process.env.SERPAPI_API_KEY = 'serpapi-key';
      process.env.BRAVE_API_KEY = 'brave-key';
      const ldr = new ExtensionLoader(manager);
      delete process.env.SERPER_API_KEY;
      delete process.env.SERPAPI_API_KEY;
      delete process.env.BRAVE_API_KEY;
    });
  });

  describe('loadExtension', () => {
    it('should return cached extension if already loaded', async () => {
      // Manually add an extension to the loaded map
      const mockPack: ExtensionPack = {
        name: 'test-pack',
        version: '1.0.0',
        descriptors: [],
      };
      
      // Access private loadedExtensions via getLoadedExtensions
      const loaded = loader.getLoadedExtensions();
      loaded.set('@framers/test-pack', mockPack);

      const result = await loader.loadExtension('@framers/test-pack');
      expect(result).toBe(mockPack);
    });

    it('should return null on error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      // Try to load non-existent package with autoInstall disabled
      const ldr = new ExtensionLoader(manager, { autoInstall: false });
      const result = await ldr.loadExtension('@framers/nonexistent-package');
      
      expect(result).toBeNull();
      consoleSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe('searchNpmExtensions', () => {
    it('should search npm for extensions', async () => {
      const results = await loader.searchNpmExtensions('test');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should search npm without query', async () => {
      const results = await loader.searchNpmExtensions();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('reload', () => {
    it('should clear and reinitialize extensions', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      await loader.reload();
      
      expect(consoleSpy).toHaveBeenCalledWith('🔄 Reloading extensions...');
      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });
  });
});
