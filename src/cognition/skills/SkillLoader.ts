/**
 * @fileoverview Skill Loader for AgentOS
 * @module @framers/agentos/cognition/skills/SkillLoader
 *
 * Loads skills from directories by parsing SKILL.md files with YAML frontmatter.
 * Skills are modular capabilities that extend agent functionality.
 *
 * A skill's SKILL.md is read never through a symbolic link at the skill's
 * folder or below it, never waiting, and only when it is a regular file
 * (`readFileOutsideLinks`); a skill whose SKILL.md is refused that way is
 * skipped with a warning.
 */

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

import { readFileOutsideLinks, type OpenRefusal } from '../../core/utils/linkFreeWrite.js';
import type {
  Skill,
  SkillEntry,
  SkillMetadata,
  SkillEligibilityContext,
  ParsedSkillFrontmatter,
  SkillInvocationPolicy,
} from './types.js';

const fsp = fs.promises;

// ============================================================================
// FRONTMATTER PARSING
// ============================================================================

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Supports the standard `---` delimited format.
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: ParsedSkillFrontmatter;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // Check for frontmatter start
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: normalized.trim() };
  }

  // Find frontmatter end
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const frontmatterBlock = lines.slice(1, endIndex).join('\n');
  const body = lines.slice(endIndex + 1).join('\n').trim();

  try {
    const parsed = YAML.parse(frontmatterBlock) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: {}, body };
    }
    return { frontmatter: parsed as ParsedSkillFrontmatter, body };
  } catch {
    return { frontmatter: {}, body };
  }
}

/**
 * Extract SkillMetadata from parsed frontmatter.
 */
export function extractMetadata(frontmatter: ParsedSkillFrontmatter): SkillMetadata | undefined {
  const metadataValue = frontmatter.metadata;
  let meta: unknown = undefined;

  if (metadataValue && typeof metadataValue === 'object') {
    const mObj = metadataValue as Record<string, unknown>;
    meta = mObj.openclaw ?? mObj.wunderland ?? mObj.agentos ?? mObj;
  } else if (typeof metadataValue === 'string' && metadataValue.trim()) {
    // Support OpenClaw-style metadata serialization (JSON-ish string in YAML).
    try {
      meta = JSON.parse(metadataValue);
    } catch {
      meta = undefined;
    }
  }

  if (!meta) {
    meta = frontmatter;
  }

  if (!meta || typeof meta !== 'object') {
    return undefined;
  }

  const m = meta as Record<string, unknown>;

  return {
    always: m.always === true,
    skillKey: typeof m.skillKey === 'string' ? m.skillKey : undefined,
    primaryEnv: typeof m.primaryEnv === 'string' ? m.primaryEnv : undefined,
    emoji: typeof m.emoji === 'string' ? m.emoji : undefined,
    homepage: typeof m.homepage === 'string' ? m.homepage : undefined,
    os: Array.isArray(m.os) ? (m.os as string[]) : undefined,
    requires: m.requires as SkillMetadata['requires'],
    install: Array.isArray(m.install) ? (m.install as SkillMetadata['install']) : undefined,
  };
}

/**
 * Extract skill description from body content.
 */
function extractDescription(body: string): string {
  // Skip markdown title and get first paragraph
  const lines = body.split('\n');
  let inParagraph = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings
    if (trimmed.startsWith('#')) {
      if (inParagraph) break;
      continue;
    }

    // Skip empty lines before paragraph
    if (!trimmed && !inParagraph) {
      continue;
    }

    // Empty line ends paragraph
    if (!trimmed && inParagraph) {
      break;
    }

    inParagraph = true;
    paragraphLines.push(trimmed);
  }

  return paragraphLines.join(' ').slice(0, 200);
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return undefined;
}

function resolveSkillInvocationPolicy(frontmatter: ParsedSkillFrontmatter): SkillInvocationPolicy {
  const userInvocable =
    coerceBoolean(frontmatter['user-invocable']) ??
    coerceBoolean(frontmatter.userInvocable) ??
    true;

  const disableModelInvocation =
    coerceBoolean(frontmatter['disable-model-invocation']) ??
    coerceBoolean(frontmatter.disableModelInvocation) ??
    false;

  return { userInvocable, disableModelInvocation };
}

// ============================================================================
// SKILL LOADING
// ============================================================================

/** What is wrong with a SKILL.md's place, as a warning words it. */
const PLACE_REFUSED: Record<OpenRefusal, string> = {
  link: 'it is reached through a symbolic link',
  special: 'it is not a regular file',
};

/**
 * Load a single skill from a directory.
 *
 * SKILL.md is read below the folder that holds `skillDir`, so the skill's own
 * folder is looked at too: never through a symbolic link at that folder or
 * below it, never waiting, and only when it is a regular file
 * (`readFileOutsideLinks`). A SKILL.md refused that way, or one that cannot
 * be loaded, is skipped with a warning.
 *
 * @param skillDir - Path to skill directory (should contain SKILL.md). It may
 *   not be a symbolic link; the folder that holds it may.
 * @returns SkillEntry, or null when the folder holds no SKILL.md or its
 *   SKILL.md was skipped
 */
export async function loadSkillFromDir(skillDir: string): Promise<SkillEntry | null> {
  const skillPath = path.join(skillDir, 'SKILL.md');

  try {
    const dir = path.resolve(skillDir);
    const root = path.dirname(dir);
    const read = await readFileOutsideLinks(root, path.relative(root, path.join(dir, 'SKILL.md')));
    // A folder with no SKILL.md is not a skill.
    if (read === null) return null;
    if (typeof read === 'string') {
      console.warn(`[SkillLoader] Skipped ${skillPath}: ${PLACE_REFUSED[read]}`);
      return null;
    }

    const { frontmatter, body } = parseSkillFrontmatter(read.text);

    const name = (typeof frontmatter.name === 'string' && frontmatter.name.trim())
      ? frontmatter.name.trim()
      : path.basename(skillDir);

    const description =
      (typeof frontmatter.description === 'string' && frontmatter.description.trim())
        ? frontmatter.description.trim()
        : extractDescription(body);

    const skill: Skill = {
      name,
      description,
      content: body,
    };

    const metadata = extractMetadata(frontmatter);
    const invocation = resolveSkillInvocationPolicy(frontmatter);

    return {
      skill,
      frontmatter,
      metadata,
      invocation,
      sourcePath: skillDir,
    };
  } catch (err) {
    console.warn(
      `[SkillLoader] Skipped ${skillPath}: it could not be loaded (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/**
 * Load all skills from a directory. Each skill is a folder in it; an entry
 * whose name starts with a dot, and one that is not a folder, is passed over,
 * and a symbolic link is passed over with a warning.
 *
 * @param dir - Parent directory containing skill subdirectories. It may be a
 *   symbolic link.
 * @returns Array of SkillEntry objects
 */
export async function loadSkillsFromDir(dir: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isSymbolicLink()) {
        // A skill is read only from a folder of its own, never through a link.
        console.warn(`[SkillLoader] Skipped ${path.join(dir, item.name)}: it is a symbolic link`);
        continue;
      }
      if (!item.isDirectory()) continue;

      const skillDir = path.join(dir, item.name);
      const entry = await loadSkillFromDir(skillDir);

      if (entry) {
        entries.push(entry);
      }
    }
  } catch (err) {
    // Directory doesn't exist or is inaccessible
    console.warn(`[SkillLoader] Failed to load skills from ${dir}:`, err);
  }

  return entries;
}

// ============================================================================
// FILTERING
// ============================================================================

/**
 * Filter skill entries by platform.
 */
export function filterByPlatform(entries: SkillEntry[], platform: string): SkillEntry[] {
  return entries.filter((entry) => {
    const os = entry.metadata?.os;
    if (!os || os.length === 0) return true;

    // Normalize platform names
    const normalizedPlatform = normalizeOSName(platform);
    return os.some((p) => normalizeOSName(p) === normalizedPlatform);
  });
}

/**
 * Normalize OS name for comparison.
 */
function normalizeOSName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'darwin' || lower === 'macos' || lower === 'mac') return 'darwin';
  if (lower === 'win32' || lower === 'windows') return 'win32';
  if (lower === 'linux') return 'linux';
  return lower;
}

/**
 * Filter skill entries by eligibility context.
 */
export function filterByEligibility(
  entries: SkillEntry[],
  context: SkillEligibilityContext,
): SkillEntry[] {
  return entries.filter((entry) => {
    const requires = entry.metadata?.requires;
    if (!requires) return true;

    // Check required binaries
    if (requires.bins && requires.bins.length > 0) {
      const allBins = requires.bins.every((bin) => context.hasBin(bin));
      if (!allBins) return false;
    }

    // Check any-of binaries
    if (requires.anyBins && requires.anyBins.length > 0) {
      const anyBin = context.hasAnyBin(requires.anyBins);
      if (!anyBin) return false;
    }

    // Check environment variables
    if (requires.env && requires.env.length > 0 && context.hasEnv) {
      const allEnv = requires.env.every((env) => context.hasEnv!(env));
      if (!allEnv) return false;
    }

    // Platform check
    for (const platform of context.platforms) {
      const filtered = filterByPlatform([entry], platform);
      if (filtered.length === 0) return false;
    }

    return true;
  });
}

/**
 * Check if all binary requirements for a skill are met.
 */
export function checkBinaryRequirements(
  entry: SkillEntry,
  hasBin: (bin: string) => boolean,
): { met: boolean; missing: string[] } {
  const requires = entry.metadata?.requires;
  const missing: string[] = [];

  if (requires?.bins) {
    for (const bin of requires.bins) {
      if (!hasBin(bin)) {
        missing.push(bin);
      }
    }
  }

  return {
    met: missing.length === 0,
    missing,
  };
}
