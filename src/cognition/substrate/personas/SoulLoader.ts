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
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { readFrontMatter, writeFrontMatter } from '../../../core/utils/frontMatter.js';
import {
  readFileOutsideLinks,
  readFileOutsideLinksSync,
  type OpenRefusal,
} from '../../../core/utils/linkFreeWrite.js';
import { ensureMemoryDir } from '../memory/wiki/migrateMemoryMd.js';
import { listWikiPageIds, listWikiPageIdsSync } from '../memory/wiki/WikiMemoryStore.js';
import { operatorIndexText, parsePage } from '../memory/wiki/WikiPageCodec.js';
import type { WikiPage } from '../memory/wiki/types.js';
import type { IPersonaDefinition } from './IPersonaDefinition.js';
import { normalizeHexacoTraits } from './hexaco.js';
import { stableIdOfName } from './stableId.js';

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
  /** Raw MEMORY.md seed content if present (legacy fallback). */
  memoryContent?: string;
  /** Absolute path to the memory/ wiki dir (created/migrated on load). */
  memoryDir?: string;
  /**
   * The memory index for system-prelude injection, trimmed: the catalog of the operator's pages under memory/,
   * rendered from the page files, after the text migrated from a legacy MEMORY.md that memory/index.md holds. A page
   * a compile wrote (front matter that lists `sources`) and a page whose front matter cannot be read are left out,
   * and so is anything else memory/index.md holds. The end marker that closes the migrated text
   * (`<!-- end of MEMORY.md -->`) is the wiki's own bookkeeping and is left out. Undefined when memory/index.md gave
   * no text.
   */
  wikiIndex?: string;
  /** Path to the agent's workspace dir. */
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
   * Hard behavioral limits, carried on the persona (`personaDefinition.hardLimits`). Every path renders them as the
   * closing "Hard limits" block of the system prompt: a GMI from its persona, `agent()` and `souledAgent()` after their
   * own prompt. A memory provider's recall and a planned call's plan are system messages after the block. They are
   * words for the model: PersonaOverlayManager runs no guardrail check on them.
   */
  hardLimits?: string[];
  /** Avatar config for visual surfaces. Maps to PersonaAvatarConfig. */
  avatar?: { type?: string; sourceUrl?: string; descriptionForGeneration?: string };
  /** Free-form structured fields any consumer can read. */
  metadata?: Record<string, unknown>;
  /** Reasoning-trace limits; maps to `IPersonaDefinition.reasoningTraceConfig`. */
  reasoningTrace?: { maxEntries?: number; maxMessageLength?: number };
}

/** Thrown when a soul cannot be loaded: its file is missing or was not read, or its front matter has a field of the wrong type. */
export class SoulLoadError extends Error {
  readonly code = 'SOUL_LOAD_FAILED' as const;
  /** What names the soul: its path as given, or `inline soul` for inline content. */
  readonly source: string;
  /** The error this one wraps, when the failure came from another error. */
  readonly cause?: unknown;

  /**
   * @param source - What names the soul: its path as given, or `inline soul`.
   * @param reason - Why it failed; the message ends with it.
   * @param options - `cause`: the error this one wraps.
   */
  constructor(source: string, reason: string, options?: { cause?: unknown }) {
    super(`The soul failed to load (${source}): ${reason}`);
    this.name = 'SoulLoadError';
    this.source = source;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const STRING_FIELDS = ['name', 'agentId', 'role', 'defaultMood'] as const;
const STRING_LIST_FIELDS = ['allowedMoods', 'hardLimits'] as const;
const OBJECT_FIELDS = ['voice', 'avatar', 'reasoningTrace', 'metadata'] as const;
const DECLARED_FIELDS: readonly string[] = [...STRING_FIELDS, ...STRING_LIST_FIELDS, ...OBJECT_FIELDS, 'hexaco'];

/** True for a value YAML reads as a mapping: an object that is not a list and not a date. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Checks the declared fields of a soul's front matter and returns it. A declared field set to `null` (an empty YAML
 * value) counts as not set and is left out; keys the loader does not declare are kept as they are.
 *
 * @param data - The front matter as parsed.
 * @param source - What names the soul in the error: its path, or `inline soul`.
 * @throws {SoulLoadError} Naming the field, when a declared field has a value of the wrong type.
 */
export function validateSoulFrontmatter(data: Record<string, unknown>, source = 'inline soul'): SoulFrontmatter {
  const out: Record<string, unknown> = { ...data };
  for (const field of DECLARED_FIELDS) if (out[field] === null) delete out[field];
  const refuse = (field: string, expected: string): never => {
    throw new SoulLoadError(source, `front matter field '${field}' must be ${expected}`);
  };
  for (const field of STRING_FIELDS) {
    if (out[field] !== undefined && typeof out[field] !== 'string') refuse(field, 'a string');
  }
  for (const field of STRING_LIST_FIELDS) {
    const value = out[field];
    if (value !== undefined && !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) refuse(field, 'a list of strings');
  }
  for (const field of OBJECT_FIELDS) {
    if (out[field] !== undefined && !isMapping(out[field])) refuse(field, 'an object');
  }
  if (isMapping(out.reasoningTrace)) {
    // A member set to null (an empty YAML value) counts as not set, as a declared field does.
    const trace: Record<string, unknown> = { ...out.reasoningTrace };
    for (const member of ['maxEntries', 'maxMessageLength']) {
      const value = trace[member];
      if (value === null) delete trace[member];
      else if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) refuse(`reasoningTrace.${member}`, 'a finite number');
    }
    out.reasoningTrace = trace;
  }
  const hexaco = out.hexaco;
  if (hexaco !== undefined) {
    const scores = isMapping(hexaco) ? Object.values(hexaco) : undefined;
    if (!scores || scores.some((score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      refuse('hexaco', 'an object of numbers between 0 and 1');
    }
  }
  return out as SoulFrontmatter;
}

/**
 * HEXACO personality model scores. All values 0.0-1.0.
 * See {@link https://hexaco.org/} for the trait reference.
 *
 * Loaded personas store these under the runtime keys from
 * `normalizeHexacoTraits`: Honesty-Humility becomes `personalityTraits.honesty`.
 */
export interface HEXACOScores {
  /** Sincerity, fairness, modesty, low entitlement. The documented frontmatter key. */
  honestyHumility?: number;
  /**
   * Same trait as `honestyHumility`, under the key runtime personas use.
   * Accepted in frontmatter; when both spellings are present, `honesty` wins.
   */
  honesty?: number;
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
   * are scanned. The files are read below the folder that holds the
   * workspace directory, so the workspace directory may not be a symbolic
   * link; the folder that holds it may.
   */
  source: string;
  /**
   * If true, throw when SOUL.md is missing or is not read (a symbolic link,
   * or not a regular file). Default true: a soul without SOUL.md is not a
   * soul.
   */
  requireSoul?: boolean;
}

/**
 * Load a soul workspace. Reads SOUL.md (required) plus any of the optional
 * companion files (STYLE.md, IDENTITY.md, AGENTS.md, MEMORY.md). Returns
 * a `LoadedSoul` with both the parsed `IPersonaDefinition` and the raw
 * markdown bodies for the runtime to inject as system messages.
 *
 * Each file, `memory/index.md` among them, is read never through a symbolic
 * link at the workspace directory or below it, never waiting, and only when
 * it is a regular file (`readFileOutsideLinks`). A file refused that way, or
 * one that cannot be read, is skipped with a warning; a skipped SOUL.md
 * throws, as a missing one does, unless `requireSoul` is false. The
 * workspace's `memory/` folder is made by `ensureMemoryDir`, which writes
 * nothing through a link either.
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

  // The soul's files are read below the folder that holds the workspace.
  const folder = soulFolder(workspaceDir);

  // Read SOUL.md (required unless explicitly opted out)
  const soulRaw = soulText(soulPath, await readSoulFile(folder, path.basename(soulPath)), requireSoul);

  // Parse frontmatter + body. The frontmatter is read as data, never evaluated.
  const parsed = soulRaw ? readFrontMatter(soulRaw) : { data: {}, content: '' };
  const frontmatter = validateSoulFrontmatter(parsed.data as Record<string, unknown>, options.source);
  const soulContent = parsed.content.trim();

  // Read optional companion files
  const styleContent = trimmedText(await readSoulFile(folder, 'STYLE.md'));
  const identityContent = trimmedText(await readSoulFile(folder, 'IDENTITY.md'));
  const agentsContent = trimmedText(await readSoulFile(folder, 'AGENTS.md'));
  const memoryContent = trimmedText(await readSoulFile(folder, 'MEMORY.md'));

  // Resolve the markdown wiki memory dir (idempotent migration of legacy MEMORY.md).
  const memoryDir = ensureMemoryDir(workspaceDir);
  const wikiIndex = await indexText(folder, await readSoulFile(folder, path.join('memory', 'index.md')));

  // Build IPersonaDefinition from frontmatter + soul body
  const personaDefinition = frontmatterToPersona(frontmatter, soulContent, styleContent);

  return {
    personaDefinition,
    soulContent,
    styleContent,
    identityContent,
    agentsContent,
    memoryContent,
    memoryDir,
    wikiIndex,
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

  const folder = soulFolder(workspaceDir);

  const soulRaw = soulText(soulPath, readSoulFileSync(folder, path.basename(soulPath)), requireSoul);

  const parsed = soulRaw ? readFrontMatter(soulRaw) : { data: {}, content: '' };
  const frontmatter = validateSoulFrontmatter(parsed.data as Record<string, unknown>, options.source);
  const soulContent = parsed.content.trim();

  const styleContent = trimmedText(readSoulFileSync(folder, 'STYLE.md'));
  const identityContent = trimmedText(readSoulFileSync(folder, 'IDENTITY.md'));
  const agentsContent = trimmedText(readSoulFileSync(folder, 'AGENTS.md'));
  const memoryContent = trimmedText(readSoulFileSync(folder, 'MEMORY.md'));

  // Resolve the markdown wiki memory dir (idempotent migration of legacy MEMORY.md).
  const memoryDir = ensureMemoryDir(workspaceDir);
  const wikiIndex = indexTextSync(folder, readSoulFileSync(folder, path.join('memory', 'index.md')));

  const personaDefinition = frontmatterToPersona(frontmatter, soulContent, styleContent);

  return {
    personaDefinition,
    soulContent,
    styleContent,
    identityContent,
    agentsContent,
    memoryContent,
    memoryDir,
    wikiIndex,
    workspaceDir,
    frontmatter,
  };
}

/**
 * Parse an inline soul markdown string (with optional YAML frontmatter) and
 * return the same `LoadedSoul` shape. Useful when the soul content is supplied
 * in code rather than from disk (tests, ephemeral agents, dynamically-built
 * personas). The frontmatter is read as data: a block marked as JavaScript
 * (`---js`) is dropped, never evaluated.
 */
export function parseSoul(soulMarkdown: string): LoadedSoul {
  const parsed = readFrontMatter(soulMarkdown);
  const frontmatter = validateSoulFrontmatter(parsed.data as Record<string, unknown>);
  const soulContent = parsed.content.trim();
  return {
    personaDefinition: frontmatterToPersona(frontmatter, soulContent),
    soulContent,
    workspaceDir: '',
    frontmatter,
  };
}

/** The persona fields a soul's front matter sets, with no prompt: the one mapping every path consumes. */
export type SoulPersonaFields = Pick<
  IPersonaDefinition,
  'id' | 'name' | 'description' | 'personalityTraits' | 'reasoningTraceConfig' | 'moodAdaptation' | 'voiceConfig' | 'avatarConfig' | 'hardLimits'
> & { metadata?: Record<string, unknown> };

/** The persona fields of a soul's front matter: id, name, role, traits, reasoning-trace limits, mood, voice, avatar, hard limits and metadata. */
export function personaFieldsOf(frontmatter: SoulFrontmatter): SoulPersonaFields {
  return {
    id: soulAgentIdOf(frontmatter) ?? 'unnamed-agent',
    name: frontmatter.name ?? 'Unnamed Agent',
    description: frontmatter.role ?? '',
    // Runtime readers key Honesty-Humility as `honesty`; the frontmatter may
    // use either spelling.
    personalityTraits: frontmatter.hexaco ? normalizeHexacoTraits(frontmatter.hexaco) : undefined,
    reasoningTraceConfig: frontmatter.reasoningTrace ? { ...frontmatter.reasoningTrace } : undefined,
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
  } as SoulPersonaFields;
}

/**
 * The one stable id of a soul: `agentId` trimmed, else the slug of the soul's `name` (for a name with no Latin letters
 * or digits, `agent-` and a hash of the name), else an id from the agent option's `name`; undefined when the soul has
 * neither and the agent has no name. Never a random id.
 *
 * @param frontmatter - The soul's front matter.
 * @param agentName - The agent's `name` option, used only when the soul names no id and no name.
 */
export function soulAgentIdOf(frontmatter: SoulFrontmatter, agentName?: string): string | undefined {
  const agentId = typeof frontmatter.agentId === 'string' ? frontmatter.agentId.trim() : '';
  if (agentId) return agentId;
  // The loader's slug first, so the id a Latin name had does not move; a name it leaves empty is hashed.
  const soulName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (soulName) return slugify(soulName) || stableIdOfName(soulName);
  const name = agentName?.trim();
  return name ? stableIdOfName(name) : undefined;
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
  return { ...personaFieldsOf(frontmatter), version: '1.0.0', baseSystemPrompt } as IPersonaDefinition;
}

/**
 * Render a persona definition (typically loaded from JSON or constructed
 * programmatically) as a SOUL.md file. Useful for migration from the
 * legacy JSON-only persona format and for `agent({ soul: { autoGenerate: ... } })`.
 *
 * HEXACO traits are written under the documented frontmatter keys
 * (`honestyHumility`, ...) whichever spelling the persona uses, so the output
 * parses back to the same `personalityTraits`. Unset optional fields are
 * left out of the frontmatter. A persona with no field to write is rendered
 * as its prompt alone, or behind an empty frontmatter block when the prompt
 * opens like one (three dashes that a fourth does not follow) or with a byte
 * order mark, so that the loader takes none of the prompt's lines for
 * frontmatter.
 */
export function renderSoulMarkdown(persona: IPersonaDefinition): string {
  const traits = normalizeHexacoTraits(persona.personalityTraits);
  const fm: SoulFrontmatter = {
    name: persona.name,
    agentId: persona.id,
    role: persona.description,
    hexaco:
      Object.keys(traits).length > 0
        ? {
            honestyHumility: traits.honesty,
            emotionality: traits.emotionality,
            extraversion: traits.extraversion,
            agreeableness: traits.agreeableness,
            conscientiousness: traits.conscientiousness,
            openness: traits.openness,
          }
        : undefined,
    voice: persona.voiceConfig
      ? {
          provider: persona.voiceConfig.provider,
          voiceId: persona.voiceConfig.voiceId,
          languageCode: persona.voiceConfig.languageCode,
        }
      : undefined,
    defaultMood: persona.moodAdaptation?.defaultMood,
    allowedMoods: persona.moodAdaptation?.allowedMoods,
    // A plain object is copied; anything else passes through unchanged, so a value the loader kept for validation survives a render.
    reasoningTrace:
      persona.reasoningTraceConfig && typeof persona.reasoningTraceConfig === 'object' && !Array.isArray(persona.reasoningTraceConfig)
        ? { ...persona.reasoningTraceConfig }
        : (persona.reasoningTraceConfig as SoulFrontmatter['reasoningTrace']),
    hardLimits: persona.hardLimits,
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
  // gray-matter dumps YAML with js-yaml's safeDump, which throws on undefined.
  // The body is written as it is and never read for frontmatter of its own.
  return writeFrontMatter(body, stripUndefined(fm) as Record<string, unknown>);
}

/**
 * Return a copy of a YAML-bound value with every `undefined` removed from
 * plain objects and arrays. Other values (dates, strings, numbers) pass
 * through unchanged.
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(stripUndefined);
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
          result[key] = stripUndefined(entry);
        }
      }
      return result;
    }
  }
  return value;
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
 * A soul's folder, resolved, and the folder that holds it, which its files are
 * read below so that the soul's folder itself is looked at too.
 */
interface SoulFolder {
  /** The folder that holds the soul's folder. It may be a link. */
  root: string;
  /** The soul's folder. */
  dir: string;
}

/** A soul file's text; null when no file is there; or why it was skipped. */
type SoulFileRead = { text: string } | { skipped: string } | null;

/** What is wrong with a soul file's place, as a warning words it. */
const PLACE_REFUSED: Record<OpenRefusal, string> = {
  link: 'it is reached through a symbolic link',
  special: 'it is not a regular file',
};

/** Where the files of the soul whose folder is `workspaceDir` are read. */
function soulFolder(workspaceDir: string): SoulFolder {
  const dir = path.resolve(workspaceDir);
  return { root: path.dirname(dir), dir };
}

/**
 * Read the soul file `name` names below the soul's folder, never through a
 * symbolic link at that folder or below it, never waiting, and only when it is
 * a regular file (`readFileOutsideLinks`). A file refused that way, or one that
 * cannot be read, is skipped with a warning.
 */
async function readSoulFile(folder: SoulFolder, name: string): Promise<SoulFileRead> {
  const file = path.join(folder.dir, name);
  try {
    return settleSoulFile(file, await readFileOutsideLinks(folder.root, path.relative(folder.root, file)));
  } catch (err) {
    return skipSoulFile(file, `it could not be read (${errorText(err)})`);
  }
}

/**
 * Sync companion to `readSoulFile`. Used by `loadSoulSync` when blocking I/O
 * is acceptable (boot-time agent factory wiring); a named pipe is refused at
 * once, so it never holds the thread up.
 */
function readSoulFileSync(folder: SoulFolder, name: string): SoulFileRead {
  const file = path.join(folder.dir, name);
  try {
    return settleSoulFile(file, readFileOutsideLinksSync(folder.root, path.relative(folder.root, file)));
  } catch (err) {
    return skipSoulFile(file, `it could not be read (${errorText(err)})`);
  }
}

/** A read's outcome as a `SoulFileRead`, with a warning for a refusal. */
function settleSoulFile(file: string, read: { text: string } | OpenRefusal | null): SoulFileRead {
  if (typeof read !== 'string') return read;
  return skipSoulFile(file, PLACE_REFUSED[read]);
}

/** Write the one warning for a skipped soul file and say why it was skipped. */
function skipSoulFile(file: string, reason: string): { skipped: string } {
  console.warn(`[SoulLoader] Skipped ${file}: ${reason}`);
  return { skipped: reason };
}

/**
 * SOUL.md's text, or null when it gave none and `requireSoul` is false.
 *
 * @throws Error when SOUL.md is missing or was skipped and `requireSoul` is true.
 */
function soulText(soulPath: string, read: SoulFileRead, requireSoul: boolean): string | null {
  if (read === null) {
    if (requireSoul) throw new Error(`SOUL.md not found at ${soulPath}`);
    return null;
  }
  if ('text' in read) return read.text;
  if (requireSoul) throw new Error(`SOUL.md at ${soulPath} was not read: ${read.skipped}`);
  return null;
}

/** An optional file's text, trimmed, or undefined when it gave none. */
function trimmedText(read: SoulFileRead): string | undefined {
  return read !== null && 'text' in read ? read.text.trim() : undefined;
}

/** The file of wiki page `id`, as a path below the soul's folder. */
function pageFileOf(id: string): string {
  return path.join('memory', ...id.split('/')) + '.md';
}

/** A page file's read as a page; undefined when the file gave no text or its front matter does not parse. */
function pageOf(id: string, read: SoulFileRead): WikiPage | undefined {
  if (read === null || !('text' in read)) return undefined;
  try {
    return parsePage(id, read.text);
  } catch {
    return undefined;
  }
}

/**
 * The memory index {@link LoadedSoul.wikiIndex} holds, rendered from the page files under memory/ and the text
 * migrated from MEMORY.md that memory/index.md holds (`operatorIndexText`); undefined when memory/index.md gave no
 * text. Each page file is read as the soul's other files are, through no link (`readSoulFile`).
 */
async function indexText(folder: SoulFolder, index: SoulFileRead): Promise<string | undefined> {
  if (index === null || !('text' in index)) return undefined;
  const ids = await listWikiPageIds(path.join(folder.dir, 'memory'), (dir) => fs.readdir(dir, { withFileTypes: true }));
  const pages: WikiPage[] = [];
  for (const id of ids) {
    const page = pageOf(id, await readSoulFile(folder, pageFileOf(id)));
    if (page) pages.push(page);
  }
  return operatorIndexText(pages, index.text);
}

/** Sync companion to `indexText`, for `loadSoulSync`. */
function indexTextSync(folder: SoulFolder, index: SoulFileRead): string | undefined {
  if (index === null || !('text' in index)) return undefined;
  const ids = listWikiPageIdsSync(path.join(folder.dir, 'memory'), (dir) => readdirSync(dir, { withFileTypes: true }));
  const pages: WikiPage[] = [];
  for (const id of ids) {
    const page = pageOf(id, readSoulFileSync(folder, pageFileOf(id)));
    if (page) pages.push(page);
  }
  return operatorIndexText(pages, index.text);
}

/** An error's message, or the value as text when it is not an Error. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
