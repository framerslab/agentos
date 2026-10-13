/**
 * @file CapabilityManifestScanner.spec.ts
 * @description Unit tests for the CapabilityManifestScanner class, against manifests in a temp folder.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// os.homedir is replaced, so the default folders are known; the rest of node:os, tmpdir among it, is the real module.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn(),
}));

// Import AFTER mocking
import { CapabilityManifestScanner } from '../../src/cognition/discovery/CapabilityManifestScanner.js';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const mockedOs = vi.mocked(os);

const YAML_FULL = `
id: custom:my-tool
kind: tool
name: my-tool
displayName: My Custom Tool
description: Does something useful
category: information
tags: [search, api]
requiredSecrets: [MY_API_KEY]
requiredTools: [curl]
hasSideEffects: true
`.trim();

const YAML_MINIMAL = `
kind: tool
name: minimal-tool
description: A minimal tool
`.trim();

const YAML_MISSING_FIELDS = `
kind: tool
name: incomplete
`.trim();

const YAML_WITH_SKILL_REF = `
kind: skill
name: my-skill
description: A custom skill
skillContent: ./SKILL.md
`.trim();

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('CapabilityManifestScanner', () => {
  let scanner: CapabilityManifestScanner;
  let root: string;
  const originalEnv = process.env;

  /** Write a capability's files into `<root>/<name>/` and return that folder. */
  function capability(name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
  }

  beforeEach(() => {
    scanner = new CapabilityManifestScanner();
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    mockedOs.homedir.mockReturnValue('/home/testuser');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-scanner-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // =========================================================================
  // getDefaultDirs
  // =========================================================================

  describe('getDefaultDirs', () => {
    it('includes ~/.wunderland/capabilities/', () => {
      const dirs = scanner.getDefaultDirs();
      expect(dirs).toContain(
        path.join('/home/testuser', '.wunderland', 'capabilities'),
      );
    });

    it('includes ./.wunderland/capabilities/', () => {
      const dirs = scanner.getDefaultDirs();
      expect(dirs).toContain(
        path.join(process.cwd(), '.wunderland', 'capabilities'),
      );
    });

    it('includes $WUNDERLAND_CAPABILITY_DIRS when set', () => {
      process.env.WUNDERLAND_CAPABILITY_DIRS = '/custom/dir1:/custom/dir2';
      const dirs = scanner.getDefaultDirs();
      expect(dirs).toContain('/custom/dir1');
      expect(dirs).toContain('/custom/dir2');
    });

    it('does not include env dirs when WUNDERLAND_CAPABILITY_DIRS is not set', () => {
      delete process.env.WUNDERLAND_CAPABILITY_DIRS;
      const dirs = scanner.getDefaultDirs();
      // Should only have 2 directories (home + cwd)
      expect(dirs).toHaveLength(2);
    });
  });

  // =========================================================================
  // scan
  // =========================================================================

  describe('scan', () => {
    it('returns empty for non-existent directories', async () => {
      const result = await scanner.scan([path.join(root, 'nonexistent')]);
      expect(result).toEqual([]);
    });

    it('scans directory with a CAPABILITY.yaml entry', async () => {
      capability('my-tool', { 'CAPABILITY.yaml': YAML_FULL });

      const result = await scanner.scan([root]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('custom:my-tool');
      expect(result[0].kind).toBe('tool');
      expect(result[0].name).toBe('my-tool');
      expect(result[0].displayName).toBe('My Custom Tool');
      expect(result[0].description).toBe('Does something useful');
      expect(result[0].category).toBe('information');
      expect(result[0].tags).toEqual(['search', 'api']);
      expect(result[0].requiredSecrets).toEqual(['MY_API_KEY']);
      expect(result[0].requiredTools).toEqual(['curl']);
    });
  });

  // =========================================================================
  // parseManifest
  // =========================================================================

  describe('parseManifest', () => {
    it('correctly parses a CAPABILITY.yaml with all fields', async () => {
      const dir = capability('my-tool', { 'CAPABILITY.yaml': YAML_FULL });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('custom:my-tool');
      expect(result!.kind).toBe('tool');
      expect(result!.name).toBe('my-tool');
      expect(result!.displayName).toBe('My Custom Tool');
      expect(result!.description).toBe('Does something useful');
      expect(result!.category).toBe('information');
      expect(result!.tags).toEqual(['search', 'api']);
      expect(result!.requiredSecrets).toEqual(['MY_API_KEY']);
      expect(result!.requiredTools).toEqual(['curl']);
      expect(result!.hasSideEffects).toBe(true);
      expect(result!.sourceRef).toEqual({
        type: 'manifest',
        manifestPath: path.join(dir, 'CAPABILITY.yaml'),
        entryId: 'custom:my-tool',
      });
    });

    it('returns null for missing required fields', async () => {
      const dir = capability('bad', { 'CAPABILITY.yaml': YAML_MISSING_FIELDS });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it('generates id from kind:name when id not provided', async () => {
      const dir = capability('min', { 'CAPABILITY.yaml': YAML_MINIMAL });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('tool:minimal-tool');
    });

    it('defaults category to custom when not provided', async () => {
      const dir = capability('min', { 'CAPABILITY.yaml': YAML_MINIMAL });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result!.category).toBe('custom');
    });

    it('loads optional SKILL.md content from skillContent reference', async () => {
      const dir = capability('my-skill', {
        'CAPABILITY.yaml': YAML_WITH_SKILL_REF,
        'SKILL.md': '# My Skill\nInstructions here.',
      });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).not.toBeNull();
      expect(result!.fullContent).toBe('# My Skill\nInstructions here.');
    });

    it('loads default SKILL.md when skillContent not specified', async () => {
      const dir = capability('min', {
        'CAPABILITY.yaml': YAML_MINIMAL,
        'SKILL.md': '# Default Skill',
      });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).not.toBeNull();
      expect(result!.fullContent).toBe('# Default Skill');
    });

    it('loads optional schema.json', async () => {
      const schemaJson = JSON.stringify({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
      });
      const dir = capability('min', {
        'CAPABILITY.yaml': YAML_MINIMAL,
        'schema.json': schemaJson,
      });

      const result = await scanner.parseManifest(path.join(dir, 'CAPABILITY.yaml'), dir);

      expect(result).not.toBeNull();
      expect(result!.fullSchema).toEqual({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
      });
    });
  });
});
