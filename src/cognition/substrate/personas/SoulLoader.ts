/**
 * @fileoverview SoulLoader — load agent identity from SOUL.md (and companion files)
 * into an `IPersonaDefinition`. Mirrors the OpenClaw/aaronjmars-soul.md convention:
 * personality lives in markdown (with YAML frontmatter for structured config),
 * not JSON.
 *
 * **The 6-file workspace pattern** (per agent):
 *
 *   ~/.agentos/agents/<agent-id>/
 *   ├── SOUL.md       identity, values, tone, hard limits         (REQUIRED)
 *   ├── STYLE.md      voice, syntax, vocabulary patterns          (optional)
 *   ├── IDENTITY.md   display card: name, role, agent-ID, avatar  (optional, derived from SOUL frontmatter when absent)
 *   ├── AGENTS.md     procedural rules: workflows, file access    (optional)
 *   ├── MEMORY.md     long-term facts; daily logs at memory/YYYY-MM-DD.md  (auto-managed)
 *   └── examples/     good-outputs.md + bad-outputs.md            (optional)
 *
 * **SOUL.md format** — markdown with YAML frontmatter:
 *
 *   ---
 *   name: Aria
 *   agentId: support-bot
 *   role: Customer support for Meridian SaaS
 *   hexaco:
 *     honestyHumility: 0.8
 *     emotionality: 0.6
 *     extraversion: 0.7
 *     agreeableness: 0.85
 *     conscientiousness: 0.9
 *     openness: 0.65
 *   voice:
 *     provider: elevenlabs
 *     voiceId: rachel-warm
 *   defaultMood: helpful_engaged
 *   hardLimits:
 *     - Never share internal pricing formulas
 *     - Always recommend a human review for refunds > €100
 *   ---
 *
 *   ## Who You Are
 *
 *   You are Aria, the customer support agent for Meridian SaaS...
 *
 * **Loading order at agent boot:**
 *
 *   1. SOUL.md → injected as the FIRST system message (the "character sheet")
 *   2. STYLE.md → appended as second system message if present
 *   3. AGENTS.md → session-start procedures executed if defined
 *   4. MEMORY.md → loaded into long-term memory store
 *   5. examples/ → fed to emergent calibration (if enabled)
 *
 * @module @framers/agentos/cognition/substrate/personas/SoulLoader
 */

import * as fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { IPersonaDefinition } from './IPersonaDefinition.js';

/**
 * Result of loading a soul workspace. The `personaDefinition` is suitable for
 * passing to `PersonaOverlayManager` or wiring into AgentOptions; the raw
 * `soulContent` and companion-file contents are available for the runtime
 * to inject as system messages.
 */
export interface LoadedSoul {
  /** Persona definition derived from SOUL.md frontmatter + body. */
  personaDefinition: IPersonaDefinition;
  /** Raw SOUL.md prose body (frontmatter stripped). Inject as first system message. */
  soulContent: string;
  /** Raw STYLE.md content if present. Inject as second system message. */
  styleContent?: string;
  /** Raw IDENTITY.md content if present. Used for display surfaces. */
  identityContent?: string;
  /** Raw AGENTS.md content if present. Procedural rules / workflow definitions. */
  agentsContent?: string;
  /** Raw MEMORY.md seed content if present. Loaded into long-term memory. */
  memoryContent?: string;
  /** Path to the agent's workspace dir (where MEMORY.md daily logs accumulate). */
  workspaceDir: string;
  /** Frontmatter parsed from SOUL.md — useful for inspection/debugging. */
  frontmatter: SoulFrontmatter;
}

/**
 * YAML frontmatter shape parsed from SOUL.md. All fields optional —
 * a soul file can be pure prose if structured config isn't needed.
 */
export interface SoulFrontmatter {
  /** Display name of the agent. e.g. "Aria". */
  name?: string;
  /** Stable identifier used for routing in multi-agent setups. */
  agentId?: string;
  /** One-line role description. e.g. "Customer support for Meridian SaaS". */
  role?: string;
  /** HEXACO trait scores (0.0-1.0). Maps to PersonalityMutationStore + PersonaDriftMechanism. */
  hexaco?: HEXACOScores;
  /** Voice config for TTS output. Maps to PersonaVoiceConfig. */
  voice?: { provider?: string; voiceId?: string; languageCode?: string };
  /** Default mood at session start. e.g. "helpful_engaged". */
  defaultMood?: string;
  /** Allowed mood transitions. Subset of agentos GMI moods. */
  allowedMoods?: string[];
  /**
   * Hard behavioral limits. Each entry becomes a "Never X" rule appended
   * to the system prompt and a guardrail check in PersonaOverlayManager.
   */
  hardLimits?: string[];
  /** Avatar config for visual surfaces. Maps to PersonaAvatarConfig. */
  avatar?: { type?: string; sourceUrl?: string; descriptionForGeneration?: string };
  /** Free-form structured fields any consumer can read. */
  metadata?: Record<string, unknown>;
}

/**
 * HEXACO personality model scores. All values 0.0-1.0.
 * See {@link https://hexaco.org/} for the trait reference.
 */
export interface HEXACOScores {
  /** Sincerity, fairness, modesty, low entitlement. */
  honestyHumility?: number;
  /** Anxiety, sensitivity to fear, sentimentality. */
  emotionality?: number;
  /** Sociability, expressiveness, social self-esteem. */
  extraversion?: number;
  /** Forgiveness, gentleness, flexibility, patience. */
  agreeableness?: number;
  /** Organization, diligence, prudence, perfectionism. */
  conscientiousness?: number;
  /** Aesthetic appreciation, inquisitiveness, creativity, unconventionality. */
  openness?: number;
}

/**
 * Options for `loadSoul()`.
 */
export interface SoulLoaderOptions {
  /**
   * Either a workspace directory (containing SOUL.md and friends) OR a
   * direct path to a SOUL.md file. If a directory, all 6 standard files
   * are scanned.
   */
  source: string;
  /**
   * If true, throw when SOUL.md is missing. Default true — a soul without
   * SOUL.md is not a soul.
   */
  requireSoul?: boolean;
}

/**
 * Load a soul workspace. Reads SOUL.md (required) plus any of the optional
 * companion files (STYLE.md, IDENTITY.md, AGENTS.md, MEMORY.md). Returns
 * a `LoadedSoul` with both the parsed `IPersonaDefinition` and the raw
 * markdown bodies for the runtime to inject as system messages.
 *
 * @example
 * ```ts
 * import { loadSoul } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
 *
 * const soul = await loadSoul({ source: '~/.agentos/agents/aria' });
 *
 * agent({
 *   provider: 'anthropic',
 *   instructions: soul.soulContent,         // SOUL.md prose as system prompt
 *   persona: soul.personaDefinition,        // structured fields (HEXACO, voice, mood)
 * });
 * ```
 */
export async function loadSoul(options: SoulLoaderOptions): Promise<LoadedSoul> {
  const requireSoul = options.requireSoul ?? true;
  const resolvedSource = expandHome(options.source);

  // Determine if source is a file or a directory
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Soul source does not exist: ${resolvedSource}`);
  }

  let workspaceDir: string;
  let soulPath: string;

  if (stats.isDirectory()) {
    workspaceDir = resolvedSource;
    soulPath = path.join(workspaceDir, 'SOUL.md');
  } else {
    workspaceDir = path.dirname(resolvedSource);
    soulPath = resolvedSource;
  }

  // Read SOUL.md (required unless explicitly opted out)
  let soulRaw: string | null = null;
  try {
    soulRaw = await fs.readFile(soulPath, 'utf-8');
  } catch {
    if (requireSoul) {
      throw new Error(`SOUL.md not found at ${soulPath}`);
    }
  }

  // Parse frontmatter + body
  const parsed = soulRaw ? matter(soulRaw) : { data: {}, content: '' };
  const frontmatter = parsed.data as SoulFrontmatter;
  const soulContent = parsed.content.trim();

  // Read optional companion files
  const styleContent = await readOptional(path.join(workspaceDir, 'STYLE.md'));
  const identityContent = await readOptional(path.join(workspaceDir, 'IDENTITY.md'));
  const agentsContent = await readOptional(path.join(workspaceDir, 'AGENTS.md'));
  const memoryContent = await readOptional(path.join(workspaceDir, 'MEMORY.md'));

  // Build IPersonaDefinition from frontmatter + soul body
  const personaDefinition = frontmatterToPersona(frontmatter, soulContent, styleContent);

  return {
    personaDefinition,
    soulContent,
    styleContent,
    identityContent,
    agentsContent,
    memoryContent,
    workspaceDir,
    frontmatter,
  };
}

/**
 * Synchronous variant of `loadSoul` for use in sync agent factory code paths.
 * Behaves identically but blocks on file I/O. Prefer the async `loadSoul` for
 * application code; reserve `loadSoulSync` for boot-time wiring where async
 * is awkward (e.g., inside a non-async `agent({ soul: '...' })` factory).
 */
export function loadSoulSync(options: SoulLoaderOptions): LoadedSoul {
  const requireSoul = options.requireSoul ?? true;
  const resolvedSource = expandHome(options.source);

  let stats;
  try {
    stats = statSync(resolvedSource);
  } catch {
    throw new Error(`Soul source does not exist: ${resolvedSource}`);
  }

  let workspaceDir: string;
  let soulPath: string;

  if (stats.isDirectory()) {
    workspaceDir = resolvedSource;
    soulPath = path.join(workspaceDir, 'SOUL.md');
  } else {
    workspaceDir = path.dirname(resolvedSource);
    soulPath = resolvedSource;
  }

  let soulRaw: string | null = null;
  try {
    soulRaw = readFileSync(soulPath, 'utf-8');
  } catch {
    if (requireSoul) {
      throw new Error(`SOUL.md not found at ${soulPath}`);
    }
  }

  const parsed = soulRaw ? matter(soulRaw) : { data: {}, content: '' };
  const frontmatter = parsed.data as SoulFrontmatter;
  const soulContent = parsed.content.trim();

  const styleContent = readOptionalSync(path.join(workspaceDir, 'STYLE.md'));
  const identityContent = readOptionalSync(path.join(workspaceDir, 'IDENTITY.md'));
  const agentsContent = readOptionalSync(path.join(workspaceDir, 'AGENTS.md'));
  const memoryContent = readOptionalSync(path.join(workspaceDir, 'MEMORY.md'));

  const personaDefinition = frontmatterToPersona(frontmatter, soulContent, styleContent);

  return {
    personaDefinition,
    soulContent,
    styleContent,
    identityContent,
    agentsContent,
    memoryContent,
    workspaceDir,
    frontmatter,
  };
}

/**
 * Parse an inline soul markdown string (with optional YAML frontmatter) and
 * return the same `LoadedSoul` shape. Useful when the soul content is supplied
 * in code rather than from disk (tests, ephemeral agents, dynamically-built
 * personas).
 */
export function parseSoul(soulMarkdown: string): LoadedSoul {
  const parsed = matter(soulMarkdown);
  const frontmatter = parsed.data as SoulFrontmatter;
  const soulContent = parsed.content.trim();
  return {
    personaDefinition: frontmatterToPersona(frontmatter, soulContent),
    soulContent,
    workspaceDir: '',
    frontmatter,
  };
}

/**
 * Convert SoulFrontmatter + markdown body into an IPersonaDefinition that
 * the existing PersonaOverlayManager and persona overlays can consume.
 */
export function frontmatterToPersona(
  frontmatter: SoulFrontmatter,
  soulBody: string,
  styleBody?: string,
): IPersonaDefinition {
  const baseSystemPrompt = [soulBody, styleBody && `## Style\n\n${styleBody}`]
    .filter(Boolean)
    .join('\n\n')
    .trim();

  const definition: IPersonaDefinition = {
    id: frontmatter.agentId ?? slugify(frontmatter.name ?? 'unnamed-agent'),
    name: frontmatter.name ?? 'Unnamed Agent',
    description: frontmatter.role ?? '',
    version: '1.0.0',
    baseSystemPrompt,
    personalityTraits: frontmatter.hexaco
      ? {
          honestyHumility: frontmatter.hexaco.honestyHumility,
          emotionality: frontmatter.hexaco.emotionality,
          extraversion: frontmatter.hexaco.extraversion,
          agreeableness: frontmatter.hexaco.agreeableness,
          conscientiousness: frontmatter.hexaco.conscientiousness,
          openness: frontmatter.hexaco.openness,
        }
      : undefined,
    moodAdaptation: frontmatter.defaultMood
      ? {
          enabled: true,
          defaultMood: frontmatter.defaultMood,
          allowedMoods: frontmatter.allowedMoods,
        }
      : undefined,
    voiceConfig: frontmatter.voice
      ? {
          provider: frontmatter.voice.provider,
          voiceId: frontmatter.voice.voiceId,
          languageCode: frontmatter.voice.languageCode,
        }
      : undefined,
    avatarConfig: frontmatter.avatar
      ? ({
          type: frontmatter.avatar.type,
          sourceUrl: frontmatter.avatar.sourceUrl,
          descriptionForGeneration: frontmatter.avatar.descriptionForGeneration,
        } as NonNullable<IPersonaDefinition['avatarConfig']>)
      : undefined,
    hardLimits: frontmatter.hardLimits,
    metadata: frontmatter.metadata,
  } as IPersonaDefinition;

  return definition;
}

/**
 * Render a persona definition (typically loaded from JSON or constructed
 * programmatically) as a SOUL.md file. Useful for migration from the
 * legacy JSON-only persona format and for `agent({ soul: { autoGenerate: ... } })`.
 */
export function renderSoulMarkdown(persona: IPersonaDefinition): string {
  const fm: SoulFrontmatter = {
    name: persona.name,
    agentId: persona.id,
    role: persona.description,
    hexaco: persona.personalityTraits as HEXACOScores | undefined,
    voice: persona.voiceConfig
      ? {
          provider: persona.voiceConfig.provider,
          voiceId: persona.voiceConfig.voiceId,
          languageCode: persona.voiceConfig.languageCode,
        }
      : undefined,
    defaultMood: persona.moodAdaptation?.defaultMood,
    allowedMoods: persona.moodAdaptation?.allowedMoods,
    hardLimits: (persona as IPersonaDefinition & { hardLimits?: string[] }).hardLimits,
    avatar: persona.avatarConfig
      ? {
          type: persona.avatarConfig.type,
          sourceUrl: persona.avatarConfig.sourceUrl,
          descriptionForGeneration: persona.avatarConfig.descriptionForGeneration,
        }
      : undefined,
    metadata: (persona as IPersonaDefinition & { metadata?: Record<string, unknown> }).metadata,
  };

  // baseSystemPrompt may be a string, template object, or content array.
  // Normalize to a single string for the markdown body.
  const body = stringifyBaseSystemPrompt(persona.baseSystemPrompt);
  return matter.stringify(body, fm as Record<string, unknown>);
}

/**
 * Coerce the polymorphic `baseSystemPrompt` field to a single markdown string.
 * Handles plain strings, template objects ({ template, variables }), and
 * content arrays ({ content, priority }[]).
 */
function stringifyBaseSystemPrompt(
  prompt: IPersonaDefinition['baseSystemPrompt'],
): string {
  if (!prompt) return '';
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((entry) => entry.content)
      .join('\n\n');
  }
  // Template object
  return prompt.template;
}

/**
 * Helper: read a file if it exists, otherwise return undefined.
 */
async function readOptional(filepath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filepath, 'utf-8');
    return content.trim();
  } catch {
    return undefined;
  }
}

/**
 * Sync companion to `readOptional`. Used by `loadSoulSync` when blocking I/O
 * is acceptable (boot-time agent factory wiring).
 */
function readOptionalSync(filepath: string): string | undefined {
  try {
    return readFileSync(filepath, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Helper: expand a leading `~/` to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Helper: convert a name to a kebab-case identifier.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
