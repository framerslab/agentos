/**
 * @fileoverview Skill Registry for AgentOS
 * @module @framers/agentos/cognition/skills/SkillRegistry
 *
 * Runtime registry for managing and querying loaded skills.
 * Provides methods for registration, filtering, and building
 * skill snapshots for agent context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describeRefusedName, pathNameProblem } from '../../core/utils/pathName.js';
import type {
  SkillEntry,
  SkillSnapshot,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillsConfig,
} from './types.js';
import {
  loadSkillsFromDir,
  filterByPlatform,
  filterByEligibility,
  checkBinaryRequirements,
} from './SkillLoader.js';

// ============================================================================
// SKILL REGISTRY
// ============================================================================

/**
 * Registry options for initialization.
 */
export interface SkillRegistryOptions {
  /** Workspace directory containing skills */
  workspaceDir?: string;

  /** Managed/global skills directory (e.g., ~/.codex/skills). */
  managedSkillsDir?: string;

  /** Additional skill directories to scan */
  extraDirs?: string[];

  /** Bundled skills directory */
  bundledSkillsDir?: string;

  /** Skills configuration */
  config?: SkillsConfig;
}

/**
 * Skill Registry for managing loaded skills at runtime.
 */
export class SkillRegistry {
  private readonly entries: Map<string, SkillEntry> = new Map();
  private config?: SkillsConfig;
  private snapshotVersion = 1;

  constructor(config?: SkillsConfig) {
    this.config = config;
  }

  // ============================================================================
  // REGISTRATION
  // ============================================================================

  /**
   * Register a skill entry.
   *
   * @returns Whether the skill was registered (false if already exists)
   */
  register(entry: SkillEntry): boolean {
    const name = entry.skill.name;
    const skillKey = entry.metadata?.skillKey ?? name;

    if (this.entries.has(name)) {
      console.warn(`[SkillRegistry] Skill '${name}' already registered, skipping`);
      return false;
    }

    // If an allowlist is configured, only apply it to bundled skills.
    const allowBundled = normalizeAllowlist(this.config?.allowBundled);
    if (allowBundled && entry.source === 'bundled') {
      if (!allowBundled.includes(skillKey) && !allowBundled.includes(name)) {
        console.log(`[SkillRegistry] Bundled skill '${name}' blocked by allowBundled, skipping`);
        return false;
      }
    }

    // Check if skill is enabled in config
    const skillConfig = this.config?.entries?.[skillKey] ?? this.config?.entries?.[name];
    if (skillConfig?.enabled === false) {
      console.log(`[SkillRegistry] Skill '${name}' disabled in config, skipping`);
      return false;
    }

    this.entries.set(name, entry);
    this.snapshotVersion++;
    return true;
  }

  /**
   * Unregister a skill by name.
   */
  unregister(name: string): boolean {
    const existed = this.entries.delete(name);
    if (existed) {
      this.snapshotVersion++;
    }
    return existed;
  }

  /**
   * Clear all registered skills.
   */
  clear(): void {
    this.entries.clear();
    this.snapshotVersion++;
  }

  // ============================================================================
  // QUERIES
  // ============================================================================

  /**
   * Get a skill by name.
   */
  getByName(name: string): SkillEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * List all registered skills.
   */
  listAll(): SkillEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get the count of registered skills.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Check if a skill is registered.
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  // ============================================================================
  // LOADING
  // ============================================================================

  /**
   * Load skills from one or more directories.
   */
  async loadFromDirs(dirs: string[]): Promise<number> {
    let count = 0;

    for (const dir of dirs) {
      count += await this.loadFromDir(dir);
    }

    return count;
  }

  /**
   * Load skills from a single directory, optionally tagging the source.
   */
  async loadFromDir(dir: string, options?: { source?: string }): Promise<number> {
    let count = 0;
    const entries = await loadSkillsFromDir(dir);
    for (const entry of entries) {
      if (options?.source) {
        entry.source = options.source;
      }
      if (this.register(entry)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Reload all skills from configured directories.
   */
  async reload(options: SkillRegistryOptions): Promise<number> {
    this.clear();

    if (options.config) {
      this.config = options.config;
    }

    // Load in high → low precedence order (first registered wins):
    // workspace > managed > bundled > extra.
    let count = 0;

    if (options.workspaceDir) {
      count += await this.loadFromDir(options.workspaceDir, { source: 'workspace' });
    }

    if (options.managedSkillsDir) {
      count += await this.loadFromDir(options.managedSkillsDir, { source: 'managed' });
    }

    if (options.bundledSkillsDir) {
      count += await this.loadFromDir(options.bundledSkillsDir, { source: 'bundled' });
    }

    if (options.extraDirs) {
      for (const dir of options.extraDirs) {
        count += await this.loadFromDir(dir, { source: 'extra' });
      }
    }

    return count;
  }

  // ============================================================================
  // FILTERING
  // ============================================================================

  /**
   * Get skills filtered by platform.
   */
  filterByPlatform(platform: string): SkillEntry[] {
    return filterByPlatform(this.listAll(), platform);
  }

  /**
   * Get skills filtered by eligibility context.
   */
  filterByEligibility(context: SkillEligibilityContext): SkillEntry[] {
    return filterByEligibility(this.listAll(), context);
  }

  /**
   * Get skills that can be invoked by users.
   */
  getUserInvocableSkills(): SkillEntry[] {
    return this.listAll().filter((entry) => entry.invocation?.userInvocable !== false);
  }

  /**
   * Get skills that can be invoked by the model.
   */
  getModelInvocableSkills(): SkillEntry[] {
    return this.listAll().filter((entry) => entry.invocation?.disableModelInvocation !== true);
  }

  // ============================================================================
  // SNAPSHOTS
  // ============================================================================

  /**
   * Build a skill snapshot for agent context.
   */
  buildSnapshot(options?: {
    platform?: string;
    eligibility?: SkillEligibilityContext;
    filter?: string[];
    /**
     * If true, apply OpenClaw-style eligibility gating (OS/bins/anyBins/env/config).
     * This is useful for "only show runnable skills" behavior.
     */
    strict?: boolean;
    /** Optional config object used to evaluate `requires.config` paths. */
    runtimeConfig?: Record<string, unknown>;
  }): SkillSnapshot {
    let entries = this.listAll();

    // Apply platform filter
    if (options?.platform) {
      entries = filterByPlatform(entries, options.platform);
    }

    if (options?.strict) {
      const platform = (options.platform && String(options.platform).trim()) || process.platform;
      entries = entries.filter((entry) => shouldIncludeSkillEntry(entry, {
        platform,
        skillsConfig: this.config,
        runtimeConfig: options.runtimeConfig,
      }));
    }

    // Apply eligibility filter
    if (options?.eligibility) {
      entries = filterByEligibility(entries, options.eligibility);
    }

    // Apply name filter
    if (options?.filter && options.filter.length > 0) {
      const filterSet = new Set(options.filter);
      entries = entries.filter((e) => filterSet.has(e.skill.name));
    }

    // Build prompt
    const prompt = this.buildPrompt(entries);

    // Build skill list
    const skills = entries.map((e) => ({
      name: e.skill.name,
      primaryEnv: e.metadata?.primaryEnv,
    }));

    return {
      prompt,
      skills,
      resolvedSkills: entries.map((e) => e.skill),
      version: this.snapshotVersion,
      createdAt: new Date(),
    };
  }

  /**
   * Format skills into a prompt for LLM context.
   */
  buildPrompt(entries: SkillEntry[]): string {
    if (entries.length === 0) {
      return '';
    }

    const sections = entries.map((entry) => {
      const { skill, metadata } = entry;
      const emoji = metadata?.emoji || '\u{1F4E6}';
      const header = `## ${emoji} ${skill.name}`;
      const desc = skill.description ? `\n${skill.description}\n` : '';
      const content = skill.content ? `\n${skill.content}` : '';

      return `${header}${desc}${content}`;
    });

    return `# Available Skills\n\n${sections.join('\n\n---\n\n')}`;
  }

  // ============================================================================
  // COMMANDS
  // ============================================================================

  /**
   * Build command specifications for all skills.
   */
  buildCommandSpecs(options?: {
    platform?: string;
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
  }): SkillCommandSpec[] {
    let entries = this.getUserInvocableSkills();

    if (options?.platform) {
      entries = filterByPlatform(entries, options.platform);
    }

    if (options?.eligibility) {
      entries = filterByEligibility(entries, options.eligibility);
    }

    const reservedNames = options?.reservedNames || new Set<string>();
    const usedNames = new Set<string>(reservedNames);
    const specs: SkillCommandSpec[] = [];

    for (const entry of entries) {
      const baseName = sanitizeCommandName(entry.skill.name);
      const name = resolveUniqueCommandName(baseName, usedNames);
      usedNames.add(name);

      specs.push({
        name,
        skillName: entry.skill.name,
        description: truncateDescription(entry.skill.description),
      });
    }

    return specs;
  }

  // ============================================================================
  // REQUIREMENTS
  // ============================================================================

  /**
   * Check requirements for all registered skills.
   */
  checkAllRequirements(hasBin: (bin: string) => boolean): Map<string, { met: boolean; missing: string[] }> {
    const results = new Map<string, { met: boolean; missing: string[] }>();

    for (const entry of this.listAll()) {
      results.set(entry.skill.name, checkBinaryRequirements(entry, hasBin));
    }

    return results;
  }

  /**
   * Get skills with unmet requirements.
   */
  getSkillsWithMissingRequirements(hasBin: (bin: string) => boolean): Array<{
    skill: string;
    missing: string[];
  }> {
    const results: Array<{ skill: string; missing: string[] }> = [];

    for (const entry of this.listAll()) {
      const { met, missing } = checkBinaryRequirements(entry, hasBin);
      if (!met) {
        results.push({ skill: entry.skill.name, missing });
      }
    }

    return results;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

const COMMAND_MAX_LENGTH = 32;
const COMMAND_FALLBACK = 'skill';
const DESCRIPTION_MAX_LENGTH = 100;

/**
 * Sanitize a skill name into a valid command name.
 */
function sanitizeCommandName(raw: string): string {
  // Convert to lowercase, replace non-alphanumeric with hyphens
  let name = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Remove leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, '');

  // Collapse multiple hyphens
  name = name.replace(/-+/g, '-');

  // Truncate to max length
  if (name.length > COMMAND_MAX_LENGTH) {
    name = name.slice(0, COMMAND_MAX_LENGTH);
    // Clean up trailing hyphen
    name = name.replace(/-+$/, '');
  }

  return name || COMMAND_FALLBACK;
}

/**
 * Resolve a unique command name avoiding collisions.
 */
function resolveUniqueCommandName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base;
  }

  // Append numeric suffix
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  // Fallback with random suffix
  return `${base}-${Date.now() % 1000}`;
}

/**
 * Truncate description to max length.
 */
function truncateDescription(desc: string): string {
  if (desc.length <= DESCRIPTION_MAX_LENGTH) {
    return desc;
  }
  return desc.slice(0, DESCRIPTION_MAX_LENGTH - 3) + '...';
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const normalized = input.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function resolveConfigPath(config: Record<string, unknown> | undefined, pathStr: string): unknown {
  if (!config) return undefined;
  const parts = pathStr.split('.').filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isConfigPathTruthy(config: Record<string, unknown> | undefined, pathStr: string): boolean {
  return isTruthy(resolveConfigPath(config, pathStr));
}

function normalizePlatformName(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'darwin' || lower === 'macos' || lower === 'mac') return 'darwin';
  if (lower === 'win32' || lower === 'windows') return 'win32';
  if (lower === 'linux') return 'linux';
  return lower;
}

/**
 * The most skill and binary name pairs remembered as warned about. When the set is full it starts again, so a host
 * that loads many skills over its life holds a bounded set and warns again at most once per pair each time.
 */
const MAX_WARNED_BINARY_NAMES = 1024;

/** Each skill and refused binary name already warned about, so a refused name is warned about once per skill. */
const warnedBinaryNames = new Set<string>();

/**
 * True when a file named `bin` that this process may run is in a folder on PATH. `bin` comes from a skill's front
 * matter (`requires.bins`, `requires.anyBins`), so before any folder is looked at it is held to the rule for one
 * file name (`pathNameProblem`): a name the rule refuses, such as one that holds a slash or starts with a dot, or
 * a value that is not a string, counts as missing, no path is built from it, and the first time for each skill a
 * warning names it.
 *
 * @param bin - The binary's name, as the front matter gives it.
 * @param skillName - The skill that requires it, for the warning.
 */
function hasBinary(bin: unknown, skillName: string): boolean {
  if (typeof bin !== 'string') {
    warnRefusedBinaryName(skillName, bin, 'type');
    return false;
  }
  const problem = pathNameProblem(bin);
  if (problem !== null) {
    warnRefusedBinaryName(skillName, bin, problem);
    return false;
  }

  // Local PATH-only check (no shell).
  // Mirrors OpenClaw's behavior and is safe to call in hot paths.
  const pathEnv = process.env.PATH ?? '';
  const parts = pathEnv.split(path.delimiter).filter(Boolean);

  const candidates =
    process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];

  for (const part of parts) {
    for (const candidateName of candidates) {
      const candidate = path.join(part, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // keep scanning
      }
    }
  }

  return false;
}

/**
 * Write the warning for a binary name the skill `skillName` requires and `hasBinary` refused, the first time for
 * that skill and name.
 *
 * @param skillName - The skill that requires the binary.
 * @param bin - The refused name, as the front matter gives it.
 * @param problem - Why it was refused: the part of the name rule it breaks, or `type` when it is not a string.
 */
function warnRefusedBinaryName(skillName: string, bin: unknown, problem: string): void {
  // The name as the warning shows it, cut short, so a long name holds no more memory here than in the line.
  const shown = describeRefusedName(bin);
  const key = `${skillName}\u0000${shown}`;
  if (warnedBinaryNames.has(key)) return;
  if (warnedBinaryNames.size >= MAX_WARNED_BINARY_NAMES) warnedBinaryNames.clear();
  warnedBinaryNames.add(key);
  console.warn(
    `[SkillRegistry] Skill '${skillName}': the binary name ${shown} is not one file name (${problem}), so the binary counts as missing`,
  );
}

function shouldIncludeSkillEntry(
  entry: SkillEntry,
  opts: {
    platform: string;
    skillsConfig?: SkillsConfig;
    runtimeConfig?: Record<string, unknown>;
  },
): boolean {
  const name = entry.skill.name;
  const skillKey = entry.metadata?.skillKey ?? name;
  const skillConfig = opts.skillsConfig?.entries?.[skillKey] ?? opts.skillsConfig?.entries?.[name];

  if (skillConfig?.enabled === false) return false;

  const osList = entry.metadata?.os ?? [];
  if (osList.length > 0) {
    const platform = normalizePlatformName(opts.platform);
    const allowed = osList.some((p) => normalizePlatformName(p) === platform);
    if (!allowed) return false;
  }

  if (entry.metadata?.always === true) {
    return true;
  }

  const requires = entry.metadata?.requires;
  const requiredBins = requires?.bins ?? [];
  const requiredAnyBins = requires?.anyBins ?? [];
  const requiredEnv = requires?.env ?? [];
  const requiredConfig = requires?.config ?? [];

  for (const bin of requiredBins) {
    if (!hasBinary(bin, name)) return false;
  }

  if (requiredAnyBins.length > 0) {
    const ok = requiredAnyBins.some((bin) => hasBinary(bin, name));
    if (!ok) return false;
  }

  for (const envName of requiredEnv) {
    if (process.env[envName]) continue;
    if (skillConfig?.env?.[envName]) continue;
    if (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName) continue;
    return false;
  }

  for (const cfgPath of requiredConfig) {
    if (!isConfigPathTruthy(opts.runtimeConfig, cfgPath)) return false;
  }

  return true;
}
