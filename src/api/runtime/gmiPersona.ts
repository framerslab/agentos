/**
 * @file gmiPersona.ts
 * The persona of a GMI built from agent options (`agent({ runtime: 'gmi' })`).
 *
 * The base system prompt is the text the legacy path sends: `buildSystemPrompt(opts)`
 * (or the joined `systemBlocks`). The chain-of-thought instruction is not part of
 * it: `gmi()` puts it first in the system prompt of each model call that offers
 * tools, as `generateText` does. The completion options are the
 * ones `agent()` forwards on every call. Sentiment presets are expanded into
 * metaprompts, as the persona loaders expand them, because the GMI runs only the
 * persona's `metaPrompts`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { buildSystemPrompt, type AgentOptions } from '../agent.js';
import { resolveModelOption } from '../model.js';
import { normalizeHexacoTraits } from '../../cognition/substrate/personas/hexaco.js';
import { normalizePersonaDefinition } from '../../cognition/substrate/personas/personaNormalization.js';
import type { IPersonaDefinition, SentimentTrackingConfig } from '../../cognition/substrate/personas/IPersonaDefinition.js';
import type { ITool } from '../../core/tools/ITool.js';
import type { ModelCompletionOptions } from '../../core/llm/providers/IProvider.js';
import type { ResolvedCognition } from './gmiCognition.js';

/** The session store bounds history (spec D10), so the GMI's own count window stays out of the way. */
export const GMI_SESSION_MAX_HISTORY_MESSAGES = 100_000;

/**
 * A stable persona id from the agent's name: a lowercase ASCII slug, or, for a
 * name with no Latin letters or digits, `agent-` and a hash of the name.
 */
function personaIdFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `agent-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}

/** The completion options `agent()` forwards on every call (its `baseOpts`), unset ones left out. */
function completionOptionsOf(opts: AgentOptions): Partial<ModelCompletionOptions> {
  const out: Partial<ModelCompletionOptions> = {};
  const maxTokens = opts.maxTokens ?? opts.controls?.maxTotalTokens;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  if (opts.controls?.maxDurationMs !== undefined) out.requestTimeout = opts.controls.maxDurationMs;
  if (opts.thinking !== undefined) out.thinking = opts.thinking;
  if (opts.effort !== undefined) out.effort = opts.effort;
  if (opts.customModelParams !== undefined) out.customModelParams = opts.customModelParams;
  if (opts.cache !== undefined) out.cache = opts.cache;
  return out;
}

function basePrompt(opts: AgentOptions): string {
  return opts.systemBlocks
    ? opts.systemBlocks.map((block) => block.text).filter(Boolean).join('\n\n')
    : buildSystemPrompt(opts) ?? '';
}

/**
 * Builds the persona of a GMI from agent options (spec D6).
 *
 * @param opts - The agent's options.
 * @param cognition - The resolved profile ({@link resolveCognition}): sentiment tracking and metaprompts.
 * @param tools - The agent's tools, adapted: they decide the persona's capabilities.
 * @throws {Error} When no provider or model can be resolved, as `generateText` throws.
 */
export function personaFromAgentOptions(opts: AgentOptions, cognition: ResolvedCognition, tools: ITool[]): IPersonaDefinition {
  const { providerId, modelId } = resolveModelOption({ provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl }, 'text');
  const name = opts.name?.trim() || 'Agent';
  const firstLine = opts.instructions?.split('\n').map((line) => line.trim()).find(Boolean);
  const completion = completionOptionsOf(opts);
  const presets: SentimentTrackingConfig['presets'] = cognition.metaprompts === 'all' ? ['all'] : cognition.metaprompts || [];
  const persona: IPersonaDefinition = {
    id: opts.name?.trim() ? personaIdFor(opts.name.trim()) : `agent-${randomUUID()}`,
    name,
    description: firstLine ?? name,
    version: '1.0.0',
    baseSystemPrompt: basePrompt(opts),
    ...(opts.personality ? { personalityTraits: normalizeHexacoTraits(opts.personality) } : {}),
    defaultProviderId: providerId,
    defaultModelId: modelId,
    ...(Object.keys(completion).length > 0 ? { defaultModelCompletionOptions: completion } : {}),
    allowedCapabilities: [...new Set(tools.flatMap((tool) => tool.requiredCapabilities ?? []))],
    conversationContextConfig: { maxMessages: GMI_SESSION_MAX_HISTORY_MESSAGES },
    sentimentTracking: cognition.sentiment ? { enabled: true, presets } : { enabled: false },
    ...(cognition.metaprompts === false ? { metaPrompts: [] } : {}),
  };
  return normalizePersonaDefinition(persona);
}
