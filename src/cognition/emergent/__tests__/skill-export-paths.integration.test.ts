import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { CapabilityManifestScanner } from '../../discovery/CapabilityManifestScanner.js';
import { SkillExportRefusedError, exportToolAsSkillPack, writeSkillFile } from '../SkillExporter.js';
import { InvalidToolNameError } from '../ToolName.js';
import type { EmergentTool, ForgeToolRequest } from '../types.js';
import { callTool, makeForgeHost } from './helpers/forge-host.js';
import { createSqliteAdapter } from './helpers/sqlite-adapter.js';
import { DOUBLED_OUT, NUMBER_IN, RAW_DOUBLE, seedToolRow } from './helpers/seed-rows.js';

// The skills folder is <root>/workspace/skills. A SKILL.md sits one level above it, a CAPABILITY.yaml two levels above.
let root: string;
let workspace: string;
let skillsDir: string;

const ONE_LEVEL_UP = 'A skill file one level above the skills folder.\n';
const TWO_LEVELS_UP = 'kind: tool\nname: two_levels_up\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-export-paths-'));
  workspace = path.join(root, 'workspace');
  skillsDir = path.join(workspace, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'SKILL.md'), ONE_LEVEL_UP);
  fs.writeFileSync(path.join(root, 'CAPABILITY.yaml'), TWO_LEVELS_UP);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every file and folder under the temp root, by its path there, with each file's text. */
function entries(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    const abs = path.join(root, rel);
    found[rel] = fs.statSync(abs).isDirectory() ? '(folder)' : fs.readFileSync(abs, 'utf8');
  }
  return found;
}

/** A forge request for a code tool, named `name`, that doubles a number. */
function doubleRequest(name: string): Record<string, unknown> {
  return {
    name,
    description: 'Doubles a number.',
    inputSchema: NUMBER_IN,
    outputSchema: DOUBLED_OUT,
    implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
    testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 } }],
  };
}

describe('a forged tool is exported as a skill only inside the skills folder', () => {
  it.each([
    ['../escaped', 'character'],
    ['../../CAPABILITY', 'character'],
    ['..', 'dot'],
    ['double it', 'identifier'],
  ])('forge_tool refuses the name %j (%s) with a typed error, before the judge runs or anything is registered', async (name, problem) => {
    const host = await makeForgeHost();

    const forged = await callTool(host.orchestrator, 'forge_tool', doubleRequest(name));

    expect(forged.isError).toBe(true);
    expect(forged.errorDetails?.details).toEqual({ code: 'INVALID_TOOL_NAME', problem });
    expect(String(forged.errorDetails?.message)).toContain(`tool name ${JSON.stringify(name)} refused`);
    expect(host.judge).not.toHaveBeenCalled();
    expect(await host.orchestrator.getTool(name)).toBeUndefined();
  });

  it('forge_tool refuses an empty name with its own message and the same typed details, before the judge runs', async () => {
    const host = await makeForgeHost();

    const forged = await callTool(host.orchestrator, 'forge_tool', doubleRequest(''));

    expect(forged.isError).toBe(true);
    expect(forged.errorDetails?.details).toEqual({ code: 'INVALID_TOOL_NAME', problem: 'empty' });
    expect(String(forged.errorDetails?.message)).toContain('name is required and must be a string');
    expect(host.judge).not.toHaveBeenCalled();
  });

  it('a host that forges through the engine directly is refused the same name', async () => {
    const host = await makeForgeHost();

    const result = await host.engine.forge(doubleRequest('../escaped') as unknown as ForgeToolRequest, {
      agentId: 'agent-test',
      sessionId: 'sess-test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tool name "../escaped" refused');
    expect(host.judge).not.toHaveBeenCalled();
  });

  it('a tool forged through forge_tool is written by both exporters to its own folder in the skills folder', async () => {
    const host = await makeForgeHost();
    const forged = await callTool(host.orchestrator, 'forge_tool', doubleRequest('double_it'));
    expect(forged.isError).toBeFalsy();
    const tool = forged.output.tool as EmergentTool;
    const before = entries();

    const skillPath = await writeSkillFile(tool, skillsDir);
    const pack = await exportToolAsSkillPack(tool, skillsDir);

    const folder = path.join(skillsDir, 'double_it');
    expect(skillPath).toBe(path.join(folder, 'SKILL.md'));
    expect(pack).toEqual({
      skillPath: path.join(folder, 'SKILL.md'),
      capabilityPath: path.join(folder, 'CAPABILITY.yaml'),
    });
    expect(YAML.parse(fs.readFileSync(pack.capabilityPath, 'utf8'))).toMatchObject({
      id: 'tool:double_it',
      name: 'double_it',
    });
    // The tool's folder and its two files were added; everything else, above the skills folder among it, is as it was.
    const folderRel = path.join('workspace', 'skills', 'double_it');
    expect(entries()).toEqual({
      ...before,
      [folderRel]: '(folder)',
      [path.join(folderRel, 'SKILL.md')]: expect.stringContaining('# Double It'),
      [path.join(folderRel, 'CAPABILITY.yaml')]: expect.stringContaining('tool:double_it'),
    });
  });

  it('the skill pack the exporter writes is read back by the capability manifest scanner, its skillContent inside the folder', async () => {
    const host = await makeForgeHost();
    const forged = await callTool(host.orchestrator, 'forge_tool', doubleRequest('double_it'));
    expect(forged.isError).toBeFalsy();
    const pack = await exportToolAsSkillPack(forged.output.tool as EmergentTool, skillsDir);

    const scanned = await new CapabilityManifestScanner().scanWithRefusals([skillsDir]);

    expect(scanned.refused).toEqual([]);
    expect(scanned.descriptors).toHaveLength(1);
    expect(scanned.descriptors[0]).toMatchObject({
      id: 'tool:double_it',
      name: 'double_it',
      fullContent: fs.readFileSync(pack.skillPath, 'utf8'),
      sourceRef: { type: 'manifest', manifestPath: pack.capabilityPath },
    });
  });

  it('a tool loaded from a stored row whose name leads out of the folder is refused by both exporters, and nothing is written', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    // A row stored before the forge held names to its rule, or written by a host's own SQL.
    seedToolRow(db, {
      id: 'stored-escape',
      name: '../escaped',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'agent',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    expect((await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'agent-seed' })).active).toBe(1);
    const [tool] = host.engine.getAgentTools('agent-seed');
    expect(tool?.name).toBe('../escaped');
    const before = entries();

    const refusals = [
      await writeSkillFile(tool, skillsDir).catch((err: unknown) => err),
      await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err),
    ];

    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(InvalidToolNameError);
      expect(refused).toMatchObject({ code: 'INVALID_TOOL_NAME', problem: 'character' });
    }
    // No folder was made and no file written, inside the skills folder or outside it.
    expect(entries()).toEqual(before);
    expect(fs.existsSync(path.join(workspace, 'escaped'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'SKILL.md'), 'utf8')).toBe(ONE_LEVEL_UP);
  });
});

describe('a skill export writes through no link below the skills folder', () => {
  /** A tool forged through forge_tool as double_it, and the folder the exporters give it. */
  async function forgedTool(): Promise<{ tool: EmergentTool; folder: string }> {
    const host = await makeForgeHost();
    const forged = await callTool(host.orchestrator, 'forge_tool', doubleRequest('double_it'));
    expect(forged.isError).toBeFalsy();
    return { tool: forged.output.tool as EmergentTool, folder: path.join(skillsDir, 'double_it') };
  }

  it("a link at the tool's folder, to a folder outside the skills folder, is refused by both exporters, and nothing is written", async () => {
    const { tool, folder } = await forgedTool();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, folder, 'dir');
    const before = entries();

    const refusals = [
      await writeSkillFile(tool, skillsDir).catch((err: unknown) => err),
      await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err),
    ];

    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(SkillExportRefusedError);
      expect(refused).toMatchObject({ code: 'SKILL_EXPORT_REFUSED', problem: 'link', target: folder });
    }
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(entries()).toEqual(before);
  });

  it('a link at CAPABILITY.yaml, to the file two levels up, refuses the skill pack before either file is made, and the file stays as it was', async () => {
    const { tool, folder } = await forgedTool();
    fs.mkdirSync(folder);
    fs.symlinkSync(path.join(root, 'CAPABILITY.yaml'), path.join(folder, 'CAPABILITY.yaml'));
    const before = entries();

    const refused = await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(SkillExportRefusedError);
    expect(refused).toMatchObject({ problem: 'link', target: path.join(folder, 'CAPABILITY.yaml') });
    // SKILL.md was not made, and the file the link leads to holds its own text.
    expect(fs.existsSync(path.join(folder, 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'CAPABILITY.yaml'), 'utf8')).toBe(TWO_LEVELS_UP);
    expect(entries()).toEqual(before);
  });

  it('a second name at SKILL.md for the file one level up is refused by both exporters, and that file stays as it was', async () => {
    const { tool, folder } = await forgedTool();
    fs.mkdirSync(folder);
    fs.linkSync(path.join(workspace, 'SKILL.md'), path.join(folder, 'SKILL.md'));
    const before = entries();

    const refusals = [
      await writeSkillFile(tool, skillsDir).catch((err: unknown) => err),
      await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err),
    ];

    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(SkillExportRefusedError);
      expect(refused).toMatchObject({ problem: 'link', target: path.join(folder, 'SKILL.md') });
    }
    expect(fs.readFileSync(path.join(workspace, 'SKILL.md'), 'utf8')).toBe(ONE_LEVEL_UP);
    expect(fs.existsSync(path.join(folder, 'CAPABILITY.yaml'))).toBe(false);
    expect(entries()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'a named pipe at SKILL.md refuses the skill pack at once, at the look before any file is opened, so CAPABILITY.yaml is not made',
    async () => {
      const { tool, folder } = await forgedTool();
      fs.mkdirSync(folder);
      // A pipe that no process reads. entries() would wait on it, so the folder is listed instead.
      execFileSync('mkfifo', [path.join(folder, 'SKILL.md')]);

      const refused = await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(SkillExportRefusedError);
      expect(refused).toMatchObject({ code: 'SKILL_EXPORT_REFUSED', problem: 'special', target: path.join(folder, 'SKILL.md') });
      // An open of CAPABILITY.yaml would have made it: the pack was refused before any open.
      expect(fs.readdirSync(folder)).toEqual(['SKILL.md']);
      expect(fs.lstatSync(path.join(folder, 'SKILL.md')).isFIFO()).toBe(true);
    },
    15_000,
  );

  it('a folder at CAPABILITY.yaml refuses the skill pack as something other than a regular file, before SKILL.md is made', async () => {
    const { tool, folder } = await forgedTool();
    fs.mkdirSync(path.join(folder, 'CAPABILITY.yaml'), { recursive: true });
    const before = entries();

    const refused = await exportToolAsSkillPack(tool, skillsDir).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(SkillExportRefusedError);
    expect(refused).toMatchObject({ problem: 'special', target: path.join(folder, 'CAPABILITY.yaml') });
    expect(fs.existsSync(path.join(folder, 'SKILL.md'))).toBe(false);
    expect(entries()).toEqual(before);
  });
});
