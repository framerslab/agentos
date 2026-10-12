import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { exportToolAsSkillPack, writeSkillFile } from '../SkillExporter.js';
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
