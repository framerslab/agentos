/**
 * @fileoverview Skill exporter for emergent tools.
 * @module @framers/agentos/emergent/SkillExporter
 *
 * Converts runtime-forged {@link EmergentTool} instances into the standard
 * SKILL.md + CAPABILITY.yaml format consumed by the agentos-skills-registry
 * and the discovery capability manifest scanner.
 *
 * This enables emergent tools that have proven their worth (agent-tier or
 * shared-tier) to be persisted as first-class skills, discoverable by the
 * capability discovery engine alongside curated human-authored skills.
 *
 * Three export levels:
 * - `exportToolAsSkill()` — pure in-memory string conversion to SKILL.md markdown
 * - `writeSkillFile()` — writes a single SKILL.md to disk
 * - `exportToolAsSkillPack()` — writes both SKILL.md and CAPABILITY.yaml (a full
 *   capability directory ready for scanner pickup)
 *
 * The two that write name the tool's folder after the tool, so they hold the
 * name to the rule every name built from data meets and write only when the
 * folder resolves inside the output directory (`resolveToolFolder`). A tool
 * whose name fails either check is refused with an `InvalidToolNameError`
 * before any folder is made or file written. Below the output directory they
 * make the tool's folder and write its files never through a link, and only
 * into regular files with one name (`core/utils/linkFreeWrite`); anything else
 * there is refused with a `SkillExportRefusedError`, and nothing is written.
 */

import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import YAML from 'yaml';

import type { EmergentTool, ComposableToolSpec, SandboxedToolSpec } from './types.js';
import type { JSONSchemaObject } from '../../core/tools/ITool.js';
import {
  lookOutsideLinks,
  makeFoldersOutsideLinks,
  openFileOutsideLinks,
  type OpenRefusal,
} from '../../core/utils/linkFreeWrite.js';
import { resolveToolFolder } from './ToolName.js';

// ============================================================================
// FRONTMATTER HELPERS
// ============================================================================

/**
 * Derives a human-readable title from a tool's machine-readable name.
 * Replaces underscores and hyphens with spaces, then title-cases each word.
 *
 * @param name - Machine-readable tool name (e.g. "fetch_github_pr_summary").
 * @returns Title-cased display name (e.g. "Fetch Github Pr Summary").
 *
 * @example
 * ```ts
 * titleCase('fetch_github_pr_summary'); // "Fetch Github Pr Summary"
 * ```
 */
function titleCase(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extracts the list of sub-tool names required by a composable implementation.
 * Sandboxed tools declare their API allowlist instead.
 *
 * @param impl - The tool's implementation specification.
 * @returns Deduplicated array of required tool names.
 */
function extractRequiredTools(impl: EmergentTool['implementation']): string[] {
  if (impl.mode === 'compose') {
    // Collect all unique tool names referenced across pipeline steps
    const tools = new Set((impl as ComposableToolSpec).steps.map((s) => s.tool));
    return [...tools];
  }
  // Sandbox tools don't depend on named tools — they have an API allowlist
  return [];
}

/**
 * Extracts tags from the tool's metadata and implementation mode.
 * Always includes 'generated' and 'emergent' to distinguish forged skills
 * from hand-authored ones.
 *
 * @param tool - The emergent tool to derive tags from.
 * @returns Array of tag strings.
 */
function deriveTags(tool: EmergentTool): string[] {
  const tags = new Set<string>(['generated', 'emergent']);
  tags.add(tool.implementation.mode);
  tags.add(tool.tier);
  return [...tags];
}

// ============================================================================
// PARAMETER TABLE
// ============================================================================

/**
 * Builds a markdown table describing the tool's input parameters from its
 * JSON Schema `inputSchema`.
 *
 * Only processes top-level `properties` from an object schema. Nested schemas
 * are represented as their `type` string with a note to see the full schema.
 *
 * @param schema - The tool's inputSchema (JSON Schema object).
 * @returns Markdown table string, or empty string if no properties exist.
 */
function buildParameterTable(schema: JSONSchemaObject): string {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') {
    return '';
  }

  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);

  const rows: string[] = [];
  rows.push('| Parameter | Type | Required | Description |');
  rows.push('|-----------|------|----------|-------------|');

  for (const [name, prop] of Object.entries(properties)) {
    const p = prop as Record<string, unknown>;
    const type = String(p.type ?? 'unknown');
    const isRequired = required.has(name) ? 'Yes' : 'No';
    const description = String(p.description ?? '');
    rows.push(`| ${name} | ${type} | ${isRequired} | ${description} |`);
  }

  return rows.join('\n');
}

// ============================================================================
// SKILL.md EXPORT
// ============================================================================

/**
 * Converts an {@link EmergentTool} into a SKILL.md markdown string.
 *
 * The generated SKILL.md follows the standard format used by the curated
 * skills in `packages/agentos-skills/registry/curated/`. It includes
 * YAML frontmatter, a purpose section, usage guidance, a parameter table,
 * and implementation notes.
 *
 * Sandbox tools receive a redaction notice instead of exposed source code —
 * the SKILL.md documents the tool's interface without leaking runtime code.
 *
 * @param tool - The emergent tool to export.
 * @returns Complete SKILL.md content as a string.
 *
 * @example
 * ```ts
 * import { exportToolAsSkill } from '@framers/agentos/emergent/SkillExporter';
 *
 * const markdown = exportToolAsSkill(myEmergentTool);
 * console.log(markdown);
 * // ---
 * // name: fetch-data
 * // version: '1.0.0'
 * // ...
 * // ---
 * // # Fetch Data
 * // ...
 * ```
 */
export function exportToolAsSkill(tool: EmergentTool): string {
  const tags = deriveTags(tool);
  const requiredTools = extractRequiredTools(tool.implementation);
  const displayName = titleCase(tool.name);

  // -- YAML frontmatter --
  const frontmatter: Record<string, unknown> = {
    name: tool.name,
    version: '1.0.0',
    description: tool.description,
    author: 'emergent-engine',
    namespace: 'emergent',
    category: 'emergent',
    tags,
    requires_secrets: [],
    requires_tools: requiredTools,
    metadata: {
      agentos: {
        tier: tool.tier,
        createdBy: tool.createdBy,
        createdAt: tool.createdAt,
        mode: tool.implementation.mode,
      },
    },
  };

  // Serialize frontmatter with the yaml library for consistent formatting
  const frontmatterYaml = YAML.stringify(frontmatter).trim();

  // -- Body sections --
  const sections: string[] = [];
  sections.push(`# ${displayName}`);
  sections.push('');

  // Purpose
  sections.push('## Purpose');
  sections.push('');
  sections.push(tool.description);
  sections.push('');

  // Usage
  sections.push('## Usage');
  sections.push('');
  if (tool.implementation.mode === 'compose') {
    const steps = (tool.implementation as ComposableToolSpec).steps;
    sections.push(
      `This tool is a composable pipeline of ${steps.length} step(s) that chains ` +
        `the following tools in sequence: ${steps.map((s) => `\`${s.tool}\``).join(' -> ')}.`
    );
  } else {
    // Sandbox tools — explain without exposing code
    const sandbox = tool.implementation as SandboxedToolSpec;
    sections.push(
      'This tool executes sandboxed code with the following API allowlist: ' +
        `${sandbox.allowlist.map((a) => `\`${a}\``).join(', ')}.`
    );
    sections.push('');
    sections.push(
      '> **Note:** Sandbox source code is redacted in the skill export for security. ' +
        'The tool must be re-forged or the original sandbox source must be provided separately.'
    );
  }
  sections.push('');

  // Parameters
  const paramTable = buildParameterTable(tool.inputSchema);
  if (paramTable) {
    sections.push('## Parameters');
    sections.push('');
    sections.push(paramTable);
    sections.push('');
  }

  // Output schema
  if (tool.outputSchema && Object.keys(tool.outputSchema).length > 0) {
    sections.push('## Output');
    sections.push('');
    sections.push('```json');
    sections.push(JSON.stringify(tool.outputSchema, null, 2));
    sections.push('```');
    sections.push('');
  }

  // Implementation details (for composable tools only — sandbox code is redacted)
  if (tool.implementation.mode === 'compose') {
    const steps = (tool.implementation as ComposableToolSpec).steps;
    sections.push('## Pipeline Steps');
    sections.push('');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      sections.push(`${i + 1}. **${step.name}** — calls \`${step.tool}\``);
      if (step.condition) {
        sections.push(`   - Condition: \`${step.condition}\``);
      }
      const mappingEntries = Object.entries(step.inputMapping);
      if (mappingEntries.length > 0) {
        sections.push(
          `   - Input mapping: ${mappingEntries.map(([k, v]) => `\`${k}\` = \`${String(v)}\``).join(', ')}`
        );
      }
    }
    sections.push('');
  }

  // Provenance
  sections.push('## Provenance');
  sections.push('');
  sections.push(`- **Source:** ${tool.source}`);
  sections.push(`- **Tier:** ${tool.tier}`);
  sections.push(`- **Total uses:** ${tool.usageStats.totalUses}`);
  sections.push(
    `- **Success rate:** ${
      tool.usageStats.totalUses > 0
        ? ((tool.usageStats.successCount / tool.usageStats.totalUses) * 100).toFixed(1)
        : '0.0'
    }%`
  );
  sections.push(`- **Confidence:** ${tool.usageStats.confidenceScore.toFixed(2)}`);
  sections.push('');

  return `---\n${frontmatterYaml}\n---\n\n${sections.join('\n')}`;
}

// ============================================================================
// CAPABILITY.yaml EXPORT
// ============================================================================

/**
 * Builds a CAPABILITY.yaml content string for an emergent tool.
 *
 * The format matches the schema expected by the capability manifest scanner:
 * ```yaml
 * id: tool:<name>
 * kind: tool
 * name: <name>
 * displayName: <Title Case Name>
 * description: <description>
 * category: emergent
 * tags: [generated, ...]
 * inputSchema: { ... }
 * outputSchema: { ... }
 * skillContent: ./SKILL.md
 * ```
 *
 * @param tool - The emergent tool to export.
 * @returns CAPABILITY.yaml content string.
 */
export function buildCapabilityYaml(tool: EmergentTool): string {
  const tags = deriveTags(tool);

  const manifest: Record<string, unknown> = {
    id: `tool:${tool.name}`,
    kind: 'tool',
    name: tool.name,
    displayName: titleCase(tool.name),
    description: tool.description,
    category: 'emergent',
    tags,
    requiredSecrets: [],
    requiredTools: extractRequiredTools(tool.implementation),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    // Relative path to the SKILL.md companion file in the same directory
    skillContent: './SKILL.md',
  };

  return YAML.stringify(manifest);
}

// ============================================================================
// FILE I/O
// ============================================================================

/**
 * Thrown by `writeSkillFile` and `exportToolAsSkillPack` when something below
 * the output directory is not written through: a symbolic link at the tool's
 * folder or at one of its files, a second name (a hard link) for one of its
 * files, or anything but a regular file at a file's place. Nothing is written.
 */
export class SkillExportRefusedError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'SKILL_EXPORT_REFUSED';

  /**
   * @param problem - `link` for a symbolic link or a second name, `special` for anything but a regular file.
   * @param target - The absolute path of the folder or file refused.
   */
  constructor(
    readonly problem: OpenRefusal,
    readonly target: string,
  ) {
    super(
      `skill export refused: ${problem === 'link' ? 'a link' : 'something other than a regular file'} is at ${target}`,
    );
    this.name = 'SkillExportRefusedError';
  }
}

/**
 * Write a tool's files into its own folder under `outputDir`, all of them or
 * none. The folder is resolved by `resolveToolFolder`, which refuses a name that
 * is not a safe folder name or a folder outside `outputDir`. The output
 * directory is the caller's: it is made when missing and used as it is, even
 * when it is a link. Below it, the tool's folder is made never through a link;
 * every file's place is looked at before any file is opened, and every file is
 * opened and checked before any is written.
 *
 * @param tool - The tool whose files are written.
 * @param outputDir - The folder the tool's folder is made in.
 * @param files - Each file's name in the tool's folder and its content.
 * @returns The absolute path of each file, in the order given.
 * @throws {InvalidToolNameError} When the name is refused. Nothing is written.
 * @throws {SkillExportRefusedError} When a link or anything but a regular file
 *   is in the way. Nothing is written.
 */
async function writeToolFiles(
  tool: EmergentTool,
  outputDir: string,
  files: ReadonlyArray<{ name: string; content: string }>,
): Promise<string[]> {
  const folder = resolveToolFolder(outputDir, tool.name);
  const root = path.resolve(outputDir);
  await fs.mkdir(root, { recursive: true });
  if (!(await makeFoldersOutsideLinks(root, path.relative(root, folder)))) {
    throw new SkillExportRefusedError('link', folder);
  }

  // Every file's place is looked at before any file is opened, so a link or a special file already there refuses
  // the export before an open makes a missing file.
  const paths = files.map((file) => path.join(folder, file.name));
  for (const file of paths) {
    const refusal = await lookOutsideLinks(file);
    if (refusal) throw new SkillExportRefusedError(refusal, file);
  }
  const opened = await Promise.allSettled(paths.map((file) => openFileOutsideLinks(file)));
  const handles: FileHandle[] = [];
  for (const outcome of opened) {
    if (outcome.status !== 'fulfilled') continue;
    const value = outcome.value;
    if (typeof value !== 'string') handles.push(value.handle);
  }

  let failure: { error: unknown } | undefined;
  try {
    const ready: Array<{ handle: FileHandle; content: string }> = [];
    for (let index = 0; index < opened.length; index++) {
      const outcome = opened[index];
      if (outcome.status === 'rejected') throw outcome.reason;
      const value = outcome.value;
      if (typeof value === 'string') throw new SkillExportRefusedError(value, paths[index]);
      ready.push({ handle: value.handle, content: files[index].content });
    }
    await Promise.all(
      ready.map(async ({ handle, content }) => {
        await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
      }),
    );
  } catch (error) {
    failure = { error };
  }
  // A file whose close fails may not hold what was written, so that fails the export too.
  for (const closed of await Promise.allSettled(handles.map((handle) => handle.close()))) {
    if (closed.status === 'rejected') failure ??= { error: closed.reason };
  }
  if (failure) throw failure.error;
  return paths;
}

/**
 * Writes a SKILL.md file to disk for an emergent tool.
 *
 * Creates the output directory if it does not exist. The file is written to
 * `<outputDir>/<tool.name>/SKILL.md`. The tool's name must be a safe folder
 * name and its folder must resolve inside `outputDir`, and below `outputDir`
 * the file is written through no link and only into a regular file; otherwise
 * nothing is written.
 *
 * @param tool - The emergent tool to export.
 * @param outputDir - Base directory where the skill subdirectory will be created.
 * @returns Absolute path to the written SKILL.md file.
 *
 * @throws {InvalidToolNameError} If the tool's name is not a safe folder name
 *   or its folder would lie outside `outputDir`. Nothing is written.
 * @throws {SkillExportRefusedError} If a link, a second name or anything but a
 *   regular file is at the tool's folder or at SKILL.md. Nothing is written.
 * @throws {Error} If the filesystem write fails (permissions, disk full, etc.).
 *
 * @example
 * ```ts
 * const skillPath = await writeSkillFile(myTool, '/home/user/.wunderland/capabilities');
 * // => "/home/user/.wunderland/capabilities/my-tool/SKILL.md"
 * ```
 */
export async function writeSkillFile(tool: EmergentTool, outputDir: string): Promise<string> {
  const [skillPath] = await writeToolFiles(tool, outputDir, [
    { name: 'SKILL.md', content: exportToolAsSkill(tool) },
  ]);
  return skillPath;
}

/**
 * Exports an emergent tool as a full skill pack (SKILL.md + CAPABILITY.yaml).
 *
 * Creates a directory named after the tool under `outputDir`, containing both
 * files. This directory structure is compatible with the
 * capability manifest scanner and can be placed in any scan directory
 * (`~/.wunderland/capabilities/`, `./.wunderland/capabilities/`, etc.) for
 * automatic discovery. The tool's name must be a safe folder name and its
 * folder must resolve inside `outputDir`, and below `outputDir` the files are
 * written through no link and only into regular files; otherwise nothing is
 * written.
 *
 * @param tool - The emergent tool to export.
 * @param outputDir - Base directory where the skill subdirectory will be created.
 * @returns Absolute paths to the written SKILL.md and CAPABILITY.yaml files.
 *
 * @throws {InvalidToolNameError} If the tool's name is not a safe folder name
 *   or its folder would lie outside `outputDir`. Nothing is written.
 * @throws {SkillExportRefusedError} If a link, a second name or anything but a
 *   regular file is at the tool's folder or at either file. Nothing is written.
 * @throws {Error} If the filesystem writes fail (permissions, disk full, etc.).
 *
 * @example
 * ```ts
 * const { skillPath, capabilityPath } = await exportToolAsSkillPack(
 *   myTool,
 *   '/home/user/.wunderland/capabilities',
 * );
 * // skillPath     => "/home/user/.wunderland/capabilities/my-tool/SKILL.md"
 * // capabilityPath => "/home/user/.wunderland/capabilities/my-tool/CAPABILITY.yaml"
 * ```
 */
export async function exportToolAsSkillPack(
  tool: EmergentTool,
  outputDir: string
): Promise<{ skillPath: string; capabilityPath: string }> {
  const [skillPath, capabilityPath] = await writeToolFiles(tool, outputDir, [
    { name: 'SKILL.md', content: exportToolAsSkill(tool) },
    { name: 'CAPABILITY.yaml', content: buildCapabilityYaml(tool) },
  ]);
  return { skillPath, capabilityPath };
}
