/**
 * @file gmiPersona.ts
 * The persona of a GMI built from agent options (`agent({ runtime: 'gmi' })`).
 *
 * The base system prompt is the text the legacy path sends: `buildSystemPrompt(opts)`
 * (or the joined `systemBlocks`). Whenever the GMI renders the personality section
 * itself, the section is left out of it: with the agent's `learning` option on, or
 * for a persona that has traits, `gmi()` gives its GMIs the persona's traits
 * (`GMIBaseConfig.personaTraits`, and with learning a learner session,
 * `GMIBaseConfig.learning`), and the GMI sends that section as a system prompt of
 * its own on every turn. With a soul, the persona carries the soul's fields through
 * the loader's one mapping (`personaFieldsOf`): its id, role, traits, mood,
 * reasoning-trace limits, hard limits and metadata; an option set in code wins for
 * the name and the traits. The chain-of-thought instruction is not part of
 * it: `gmi()` puts it first in the system prompt of each model call that offers
 * tools, as `generateText` does. The completion options are the
 * ones `agent()` forwards on every call. Sentiment presets are expanded into
 * metaprompts, as the persona loaders expand them, because the GMI runs only the
 * persona's `metaPrompts`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { buildSystemPrompt, loadSoulFromOption, type AgentOptions } from '../agent.js';
import { resolveModelOption } from '../model.js';
import { normalizeHexacoTraits } from '../../cognition/substrate/personas/hexaco.js';
import { stableIdOfName } from '../../cognition/substrate/personas/stableId.js';
import { normalizePersonaDefinition } from '../../cognition/substrate/personas/personaNormalization.js';
import type { IPersonaDefinition, SentimentTrackingConfig } from '../../cognition/substrate/personas/IPersonaDefinition.js';
import { personaFieldsOf, soulAgentIdOf, type LoadedSoul } from '../../cognition/substrate/personas/SoulLoader.js';
import { canonicalJson } from '../../cognition/learning/ledger/canonical.js';
import type { ITool } from '../../core/tools/ITool.js';
import type { ModelCompletionOptions } from '../../core/llm/providers/IProvider.js';
import type { ResolvedCognition } from './gmiCognition.js';
import { MEMORY_RECALL_SYSTEM_LINE } from './memoryDataBlock.js';

/** The session store bounds history, so the GMI's own count window stays out of the way. */
export const GMI_SESSION_MAX_HISTORY_MESSAGES = 100_000;

/**
 * The persona id of a named agent, which is the same at every build (the slug of its name); `undefined` for an agent
 * with no name, whose persona id is new at each build. `gmi()` names the agent's learners by it when `learning.agentKey`
 * is unset.
 */
export function stablePersonaIdOf(opts: Pick<AgentOptions, 'name'>): string | undefined {
  const name = opts.name?.trim();
  return name ? stableIdOfName(name) : undefined;
}

/**
 * The output cap each model call of an agent built from these options is sent with, as `agent()` forwards it:
 * `maxTokens`, else `controls.maxTotalTokens`; undefined when neither is set. A launch's one-call floor counts a
 * member's call with it.
 */
export function callMaxTokensOf(opts: Pick<AgentOptions, 'maxTokens' | 'controls'>): number | undefined {
  return opts.maxTokens ?? opts.controls?.maxTotalTokens;
}

/** The completion options `agent()` forwards on every call (its `baseOpts`), unset ones left out. */
function completionOptionsOf(opts: AgentOptions): Partial<ModelCompletionOptions> {
  const out: Partial<ModelCompletionOptions> = {};
  const maxTokens = callMaxTokensOf(opts);
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  if (opts.controls?.maxDurationMs !== undefined) out.requestTimeout = opts.controls.maxDurationMs;
  if (opts.thinking !== undefined) out.thinking = opts.thinking;
  if (opts.effort !== undefined) out.effort = opts.effort;
  if (opts.customModelParams !== undefined) out.customModelParams = opts.customModelParams;
  if (opts.cache !== undefined) out.cache = opts.cache;
  return out;
}

/**
 * The `learning.agentKey` the host set, trimmed; undefined when `learning` is not a config or the key is unset or blank.
 * It names the persona of an agent whose soul gives no id, and of an unnamed agent with no soul, so the memory that
 * files under the persona id keeps the host's key across builds.
 */
function hostAgentKeyOf(opts: Pick<AgentOptions, 'learning'>): string | undefined {
  const learning = opts.learning;
  if (!learning || typeof learning !== 'object') return undefined;
  const key = typeof learning.agentKey === 'string' ? learning.agentKey.trim() : '';
  return key || undefined;
}

/**
 * The persona id of a soul that gives no id (no `agentId`, no `name`, on an agent with no name and no
 * `learning.agentKey`): `soul-` and the first 16 hex characters of SHA-256 over the canonical JSON of its front matter
 * and body. The same at every build of the same soul; it changes with the soul's text. It is never a learner or brain
 * key (`memory.store` refuses such a soul without `learning.agentKey`, and with one the key names the persona), but
 * in-process cognitive memory files the persona and owner scopes under the persona id, so editing such a soul starts
 * those scopes afresh; set `agentId` or `learning.agentKey` to keep them.
 */
export function derivedSoulPersonaId(soul: Pick<LoadedSoul, 'frontmatter' | 'soulContent'>): string {
  return `soul-${createHash('sha256').update(canonicalJson([soul.frontmatter, soul.soulContent])).digest('hex').slice(0, 16)}`;
}

/**
 * The agent's stable id: with a soul, the soul's id rule (`soulAgentIdOf`); with none, a named agent's id. Undefined
 * for an agent that has neither.
 */
export function agentStableIdOf(opts: Partial<AgentOptions>, soul: LoadedSoul | null | undefined): string | undefined {
  return soul ? soulAgentIdOf(soul.frontmatter, opts.name) : stablePersonaIdOf(opts);
}

/**
 * The persona's base prompt. The personality section stays out of it whenever the GMI renders one itself (learning
 * on, or a persona with traits), so the section appears once; `systemBlocks` never carry one. With a `memoryProvider`
 * that recalls, its last line is the one that explains the recall block.
 *
 * @param soul - The soul loaded from `opts.soul`, or `null` for none.
 */
function basePrompt(
  opts: AgentOptions,
  leaveOutPersonality: boolean,
  soul: LoadedSoul | null,
): IPersonaDefinition['baseSystemPrompt'] {
  const recalls = Boolean(opts.memoryProvider?.getContext);
  if (!opts.systemBlocks) {
    const prompt = buildSystemPrompt(opts, soul, leaveOutPersonality ? { personality: false } : undefined) ?? '';
    // The static line that explains the recall block is the base prompt's last line, so it renders before the limits.
    return recalls ? [prompt, MEMORY_RECALL_SYSTEM_LINE].filter(Boolean).join('\n\n') : prompt;
  }
  const blocks = opts.systemBlocks.filter((block) => Boolean(block.text));
  let breakpoint = -1;
  blocks.forEach((block, index) => {
    if (block.cacheBreakpoint) breakpoint = index;
  });
  // Blocks through the last breakpoint are fixed and the ones after it change per turn. With no block after a
  // breakpoint (or no breakpoint) every block is fixed, and the joined text is the base prompt as one string.
  if (breakpoint < 0 || breakpoint === blocks.length - 1) {
    const prompt = blocks.map((block) => block.text).join('\n\n');
    return recalls ? [prompt, MEMORY_RECALL_SYSTEM_LINE].filter(Boolean).join('\n\n') : prompt;
  }
  // The blocks through the breakpoint are one fixed entry, so a blank block among them (kept, as in the joined text)
  // cannot end the fixed run early; their joined text is the same either way. Each later block is a turn entry.
  const entries: Array<{ content: string; priority: number; stability: 'persona' | 'turn' }> = [
    { content: blocks.slice(0, breakpoint + 1).map((block) => block.text).join('\n\n'), priority: 1, stability: 'persona' },
    ...blocks.slice(breakpoint + 1).map((block) => ({ content: block.text, priority: 1, stability: 'turn' as const })),
  ];
  if (recalls) entries.push({ content: MEMORY_RECALL_SYSTEM_LINE, priority: 1, stability: 'persona' });
  return entries;
}

/**
 * Builds the persona of a GMI from agent options.
 *
 * @param opts - The agent's options.
 * @param cognition - The resolved profile ({@link resolveCognition}): sentiment tracking, metaprompts, the memory
 *   config and whether learning is on.
 * @param tools - The agent's tools, adapted: they decide the persona's capabilities.
 * @param soul - The soul the caller loaded from `opts.soul`, `null` for none; not passed, `opts.soul` is loaded here.
 * @returns The persona. With `cognition.learning` set, or when the persona has traits, its base prompt has no
 *   personality section: a GMI built from it sends the section only when it is given a learner session
 *   (`GMIBaseConfig.learning`) or the persona's traits (`GMIBaseConfig.personaTraits`), as `gmi()` gives it. With a
 *   soul the persona carries the soul's id, role, traits, mood, reasoning-trace limits, hard limits and metadata, and
 *   never its voice or avatar. With memory on and `memory.recall` set, its `cognitiveMemoryConfig` holds `recall` and
 *   nothing else.
 * @throws {Error} When no provider or model can be resolved, as `generateText` throws.
 * @throws {SoulLoadError} When the soul is loaded here, fails to load and is not optional.
 */
export function personaFromAgentOptions(
  opts: AgentOptions,
  cognition: ResolvedCognition,
  tools: ITool[],
  soul?: LoadedSoul | null,
): IPersonaDefinition {
  const loaded = soul === undefined ? (opts.soul ? loadSoulFromOption(opts.soul) : null) : soul;
  const fields = loaded ? personaFieldsOf(loaded.frontmatter) : undefined;
  const { providerId, modelId } = resolveModelOption({ provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl }, 'text');
  // An option set in code wins over the soul's file; the id is the soul's.
  const name = opts.name?.trim() || loaded?.frontmatter.name?.trim() || 'Agent';
  const firstLine = opts.instructions?.split('\n').map((line) => line.trim()).find(Boolean);
  const traitSource = opts.personality ?? loaded?.frontmatter.hexaco;
  const traits = normalizeHexacoTraits(traitSource);
  const hasTraits = Object.keys(traits).length > 0;
  const completion = completionOptionsOf(opts);
  const presets: SentimentTrackingConfig['presets'] = cognition.metaprompts === 'all' ? ['all'] : cognition.metaprompts || [];
  const persona = {
    id: loaded
      ? (soulAgentIdOf(loaded.frontmatter, opts.name) ?? hostAgentKeyOf(opts) ?? derivedSoulPersonaId(loaded))
      : (stablePersonaIdOf(opts) ?? hostAgentKeyOf(opts) ?? `agent-${randomUUID()}`),
    name,
    description: loaded?.frontmatter.role?.trim() || firstLine || name,
    version: '1.0.0',
    baseSystemPrompt: basePrompt(opts, cognition.learning !== undefined || hasTraits, loaded),
    ...(traitSource ? { personalityTraits: traits } : {}),
    ...(fields?.hardLimits ? { hardLimits: fields.hardLimits } : {}),
    ...(fields?.moodAdaptation ? { moodAdaptation: fields.moodAdaptation } : {}),
    ...(fields?.reasoningTraceConfig ? { reasoningTraceConfig: fields.reasoningTraceConfig } : {}),
    // The persona type has no top-level metadata member; the loader carries it the same way.
    ...(fields?.metadata ? { metadata: fields.metadata } : {}),
    defaultProviderId: providerId,
    defaultModelId: modelId,
    ...(Object.keys(completion).length > 0 ? { defaultModelCompletionOptions: completion } : {}),
    allowedCapabilities: [...new Set(tools.flatMap((tool) => tool.requiredCapabilities ?? []))],
    conversationContextConfig: { maxMessages: GMI_SESSION_MAX_HISTORY_MESSAGES },
    sentimentTracking: cognition.sentiment ? { enabled: true, presets } : { enabled: false },
    ...(cognition.metaprompts === false ? { metaPrompts: [] } : {}),
    // The memory's recall settings (memory.recall): the only memory setting the persona carries.
    ...(cognition.memory && cognition.memory.recall ? { cognitiveMemoryConfig: { recall: cognition.memory.recall } } : {}),
  } as IPersonaDefinition;
  return normalizePersonaDefinition(persona);
}
