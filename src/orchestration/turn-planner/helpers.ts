import { CostAggregator } from '../../cognition/substrate/IGMI';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

/**
 * Normalises undefined cost fields so downstream consumers always receive a fully shaped usage object. The
 * prompt-cache counts are kept when the usage has them and stay absent when it does not.
 */
export const normalizeUsage = (usage?: CostAggregator): CostAggregator | undefined => {
  if (!usage) {
    return undefined;
  }

  return {
    totalTokens: usage.totalTokens ?? 0,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalCostUSD: usage.totalCostUSD,
    breakdown: usage.breakdown,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
    ...(usage.cacheCreationExtendedTokens !== undefined ? { cacheCreationExtendedTokens: usage.cacheCreationExtendedTokens } : {}),
    ...(usage.inclusiveInputTokens !== undefined ? { inclusiveInputTokens: usage.inclusiveInputTokens } : {}),
  };
};

/**
 * Produces a lightweight persona snapshot suitable for metadata streaming.
 * Falls back to label/name display hints if the persona definition omits them.
 */
export const snapshotPersonaDetails = (
  persona?: IPersonaDefinition,
): Partial<IPersonaDefinition> | undefined => {
  if (!persona) {
    return undefined;
  }

  const label =
    persona.label ??
    (persona as unknown as { displayName?: string }).displayName ??
    persona.name ??
    persona.id;

  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    version: persona.version,
    label,
  };
};
