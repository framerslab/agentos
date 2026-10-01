/**
 * @file PersonaValidation.ts
 * @description Provides rich validation utilities for `IPersonaDefinition` objects prior to
 *              activation or deployment. Ensures structural integrity, semantic consistency,
 *              and cross-persona conflict detection (e.g., activation keyword collisions).
 *
 * Design Goals:
 *  - Catch hard errors early (missing required fields, invalid IDs, unknown tool references).
 *  - Surface softer warnings (overly long system prompt, voice config without audio modality).
 *  - Offer proactive suggestions that improve quality (e.g., recommend cost strategy if omitted).
 *  - Remain side-effect free and pure: callers can run in CI, authoring tools, or runtime gates.
 */
import { IPersonaDefinition } from './IPersonaDefinition';
import { GMIEventType } from '../GMIEvent.js';

/** Classification of validation issue severity. */
export type PersonaValidationIssueSeverity = 'error' | 'warning' | 'suggestion';

/**
 * Structured validation issue capturing severity, machine-readable code, human message,
 * and optional field context.
 */
export interface PersonaValidationIssue {
  severity: PersonaValidationIssueSeverity;
  code: string; // machine readable stable identifier (e.g., 'missing_required_field')
  message: string; // human readable explanation
  personaId?: string;
  field?: string;
}

/** Result for a single persona definition. */
export interface PersonaValidationResult {
  personaId: string;
  issues: PersonaValidationIssue[];
  summary: {
    errorCount: number;
    warningCount: number;
    suggestionCount: number;
  };
}

/** Aggregate report across multiple personas. */
export interface PersonaValidationAggregateReport {
  results: PersonaValidationResult[];
  totals: { errors: number; warnings: number; suggestions: number };
  activationKeywordConflicts: Array<{ keyword: string; personaIds: string[] }>;
}

/** Options for persona validation. */
export interface PersonaValidationOptions {
  /** Known registered tool IDs for verifying persona.toolIds references. */
  knownToolIds?: Set<string>;
  /** Reserved persona identifiers disallowed for user-defined personas. */
  reservedPersonaIds?: Set<string>;
  /** Maximum advisable length of the base system prompt before warning (characters). */
  maxSystemPromptLength?: number;
  /** Maximum advisable token length of the base system prompt before warning (uses tokenEstimator if provided). */
  maxSystemPromptTokens?: number;
  /** Optional token estimator allowing model-specific token length validation. */
  tokenEstimator?: (text: string) => Promise<number> | number;
}

/**
 * Configuration for strict validation enforcement.
 * When enabled, personas with blocking issues are marked invalid and optionally excluded from activation.
 */
export interface PersonaValidationStrictConfig {
  /** Master toggle: if false, all strict enforcement is disabled. */
  enabled: boolean;
  /** 
   * Enforcement mode:
   * - 'activation_block': Load all personas but prevent session activation of invalid ones.
   * - 'load_block': Exclude invalid personas from registry entirely (stricter, more disruptive).
   */
  mode?: 'activation_block' | 'load_block';
  /** Specific validation codes that should block (overrides severity if set). If empty, errors block by default. */
  blockOnCodes?: string[];
  /** Escalate these warning codes to error severity for blocking purposes. */
  treatWarningsAsErrors?: string[];
  /** Persona IDs that bypass strict enforcement (escape hatch for WIP personas). */
  allowlistPersonaIds?: string[];
  /** 
   * Shadow mode: perform strict classification and log what would be blocked without enforcing.
   * Useful for observing impact before activating strict mode.
   */
  shadowMode?: boolean;
}

/** Loaded persona record enriched with validation metadata for strict mode. */
export interface LoadedPersonaRecord {
  definition: IPersonaDefinition;
  validation: PersonaValidationResult;
  /** Persona status after applying strict mode rules. */
  status: 'valid' | 'invalid' | 'degraded';
  /** Validation codes causing blocking (if status='invalid'). */
  blockedReasons?: string[];
}

// Simple semantic version pattern; we intentionally avoid full semver nitpicking (pre-release ok).
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;
// Lightweight BCP-47 heuristic (not exhaustive): lang subtags 2-3 letters, optional hyphen groups.
const BCP47_REGEX = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** Metaprompt trigger types the MetapromptExecutor fires. A metaprompt with any other type never runs. */
const SUPPORTED_METAPROMPT_TRIGGER_TYPES: ReadonlySet<string> = new Set(['turn_interval', 'event_based', 'manual']);
/** Event names the GMI raises, and so the only ones an `event_based` metaprompt can wait for. */
const GMI_EVENT_NAMES: ReadonlySet<string> = new Set<string>(Object.values(GMIEventType));

/**
 * Validate a single persona definition and return structured issues.
 * @param persona Persona definition to validate.
 * @param opts Validation options.
 */
export async function validatePersona(persona: IPersonaDefinition, opts: PersonaValidationOptions = {}): Promise<PersonaValidationResult> {
  const issues: PersonaValidationIssue[] = [];
  const add = (severity: PersonaValidationIssueSeverity, code: string, message: string, field?: string) => {
    issues.push({ severity, code, message, personaId: persona.id, field });
  };

  // Required fields.
  const requiredStringFields: Array<keyof IPersonaDefinition> = ['id', 'name', 'description', 'version', 'baseSystemPrompt'];
  for (const field of requiredStringFields) {
    const v: any = (persona as any)[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) {
      add('error', 'missing_required_field', `Required field '${field}' is missing or empty.`, String(field));
    }
  }

  // Reserved persona id check.
  if (opts.reservedPersonaIds && opts.reservedPersonaIds.has(persona.id)) {
    add('error', 'reserved_persona_id', `Persona id '${persona.id}' is reserved and cannot be used.`, 'id');
  }

  // Version format.
  if (persona.version && !SEMVER_REGEX.test(persona.version)) {
    add('error', 'invalid_semver', `Version '${persona.version}' does not match semantic version pattern (e.g., 1.2.3).`, 'version');
  }

  // System prompt length check (character-based) + token-based if estimator provided.
  const maxLen = opts.maxSystemPromptLength ?? 2000;
  let promptTextFragments: string[] = [];
  if (typeof persona.baseSystemPrompt === 'string') {
    promptTextFragments = [persona.baseSystemPrompt];
  } else if (Array.isArray(persona.baseSystemPrompt)) {
    promptTextFragments = persona.baseSystemPrompt.map(f => f.content || '');
  } else if (typeof persona.baseSystemPrompt === 'object' && persona.baseSystemPrompt !== null) {
    promptTextFragments = [(persona.baseSystemPrompt as any).template || ''];
  }
  const concatenatedPrompt = promptTextFragments.join('\n');
  const charLength = concatenatedPrompt.length;
  if (charLength > maxLen) {
    add('warning', 'system_prompt_too_long', `Base system prompt length ${charLength} chars exceeds recommended maximum ${maxLen}. Consider modularizing or summarizing.`, 'baseSystemPrompt');
  }
  if (opts.tokenEstimator && opts.maxSystemPromptTokens) {
    try {
      const tokenCount = await Promise.resolve(opts.tokenEstimator(concatenatedPrompt));
      if (tokenCount > opts.maxSystemPromptTokens) {
        add('warning', 'system_prompt_too_many_tokens', `Base system prompt token length ${tokenCount} exceeds recommended maximum ${opts.maxSystemPromptTokens}. Consider reducing verbosity or externalizing examples.`, 'baseSystemPrompt');
      }
    } catch (e: any) {
      add('warning', 'token_estimation_failed', `Token estimation failed: ${e.message || e}. Proceeding without token length validation.`, 'baseSystemPrompt');
    }
  }

  // Tool IDs validation.
  if (persona.toolIds) {
    const seen = new Set<string>();
    for (const t of persona.toolIds) {
      if (seen.has(t)) {
        add('error', 'duplicate_tool_id', `Duplicate toolId '${t}' in persona.toolIds.`, 'toolIds');
      }
      seen.add(t);
      if (opts.knownToolIds && !opts.knownToolIds.has(t)) {
        add('error', 'unknown_tool_id', `ToolId '${t}' not found in known tool registry.`, 'toolIds');
      }
    }
  }

  // Modalities & voice config coherence.
  if (persona.voiceConfig && (!persona.allowedOutputModalities || !persona.allowedOutputModalities.includes('audio_tts'))) {
    add('warning', 'voice_config_without_audio_output', 'Voice config provided but persona.allowedOutputModalities does not include audio_tts.', 'voiceConfig');
  }

  // BCP-47 language code.
  if (persona.defaultLanguage && !BCP47_REGEX.test(persona.defaultLanguage)) {
    add('error', 'invalid_bcp47_language', `defaultLanguage '${persona.defaultLanguage}' is not a plausible BCP-47 tag (e.g., en-US).`, 'defaultLanguage');
  }

  // Cost strategy suggestion.
  if (!persona.costSavingStrategy) {
    add('suggestion', 'missing_cost_strategy', 'Define costSavingStrategy to clarify routing preferences (e.g., balance_quality_cost).', 'costSavingStrategy');
  }

  // Model target preferences sanity.
  if (persona.modelTargetPreferences) {
    persona.modelTargetPreferences.forEach((pref, idx) => {
      if (pref.allowedModelIds) {
        const dup = findDuplicates(pref.allowedModelIds);
        if (dup.length) {
          add('error', 'duplicate_allowed_model_ids', `ModelTargetPreference at index ${idx} has duplicate allowedModelIds: ${dup.join(', ')}`, 'modelTargetPreferences');
        }
      }
      if (pref.modelId && pref.modelFamily && pref.allowedModelIds && pref.allowedModelIds.length > 0) {
        add('warning', 'over_specified_model_preference', `Preference ${idx} specifies modelId, modelFamily and allowedModelIds; consider simplifying to reduce routing ambiguity.`, 'modelTargetPreferences');
      }
    });
  }

  // Memory & RAG internal checks.
  if (persona.memoryConfig?.ragConfig) {
    const rag = persona.memoryConfig.ragConfig;
    if (rag.enabled) {
      if (rag.dataSources) {
        const ids = rag.dataSources.map(ds => ds.id);
        const dupDs = findDuplicates(ids);
        if (dupDs.length) {
          add('error', 'duplicate_rag_datasource_ids', `RAG dataSources contain duplicate ids: ${dupDs.join(', ')}`, 'memoryConfig.ragConfig.dataSources');
        }
      }
      if (rag.ingestionProcessing?.summarization?.enabled && !rag.ingestionProcessing.summarization.method) {
        add('warning', 'rag_summarization_method_missing', 'RAG ingestion summarization enabled but no method provided.', 'memoryConfig.ragConfig.ingestionProcessing.summarization.method');
      }
    }
  }

  // Metaprompt triggers. Persona JSON is cast rather than type-checked, so a
  // trigger the executor can never fire would otherwise load without notice.
  if (Array.isArray(persona.metaPrompts)) {
    persona.metaPrompts.forEach((metaPrompt, idx) => {
      const trigger = metaPrompt?.trigger as
        | { type?: unknown; intervalTurns?: unknown; eventName?: unknown }
        | undefined;
      if (!trigger) return;
      const field = `metaPrompts[${idx}].trigger`;
      const label = `Metaprompt '${metaPrompt.id}'`;

      if (typeof trigger.type !== 'string' || !SUPPORTED_METAPROMPT_TRIGGER_TYPES.has(trigger.type)) {
        add('warning', 'unsupported_metaprompt_trigger', `${label} has trigger type '${String(trigger.type)}', which never fires. Supported types: turn_interval, event_based, manual.`, field);
      } else if (trigger.type === 'turn_interval') {
        const interval = trigger.intervalTurns;
        if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1) {
          add('warning', 'invalid_metaprompt_interval', `${label} has intervalTurns ${String(interval)}; it must be a number of at least 1, or the metaprompt never fires.`, field);
        }
      } else if (trigger.type === 'event_based') {
        if (typeof trigger.eventName !== 'string' || !GMI_EVENT_NAMES.has(trigger.eventName)) {
          add('warning', 'unknown_metaprompt_event', `${label} waits for event '${String(trigger.eventName)}', which the GMI never raises. Known events: ${Array.from(GMI_EVENT_NAMES).join(', ')}.`, field);
        }
      }
    });
  }

  const summary = summarizeIssues(issues);
  return { personaId: persona.id, issues, summary };
}

/** Validate a list of personas and compute aggregate statistics & cross-persona conflicts. */
export async function validatePersonas(personas: IPersonaDefinition[], opts: PersonaValidationOptions = {}): Promise<PersonaValidationAggregateReport> {
  const results: PersonaValidationResult[] = [];
  for (const p of personas) {
    results.push(await validatePersona(p, opts));
  }
  const keywordMap = new Map<string, string[]>();
  for (const p of personas) {
    (p.activationKeywords || []).forEach(kw => {
      const existing = keywordMap.get(kw) || [];
      existing.push(p.id);
      keywordMap.set(kw, existing);
    });
  }
  const activationKeywordConflicts = Array.from(keywordMap.entries())
    .filter(([, list]) => list.length > 1)
    .map(([keyword, personaIds]) => ({ keyword, personaIds }));

  // Inject conflicts as issues (warning severity) into each affected persona's result.
  if (activationKeywordConflicts.length) {
    for (const conflict of activationKeywordConflicts) {
      for (const res of results) {
        if (conflict.personaIds.includes(res.personaId)) {
          res.issues.push({
            severity: 'warning',
            code: 'activation_keyword_conflict',
            message: `Activation keyword '${conflict.keyword}' used by multiple personas: ${conflict.personaIds.join(', ')}`,
            personaId: res.personaId,
            field: 'activationKeywords'
          });
        }
      }
    }
    // Recompute summaries after injecting keyword conflict warnings.
    results.forEach(r => (r.summary = summarizeIssues(r.issues)));
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.errors += r.summary.errorCount;
      acc.warnings += r.summary.warningCount;
      acc.suggestions += r.summary.suggestionCount;
      return acc;
    },
    { errors: 0, warnings: 0, suggestions: 0 }
  );

  return { results, totals, activationKeywordConflicts };
}

// Helpers
function findDuplicates(arr: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  arr.forEach(v => { if (seen.has(v)) dup.add(v); else seen.add(v); });
  return Array.from(dup);
}

function summarizeIssues(list: PersonaValidationIssue[]) {
  let errorCount = 0, warningCount = 0, suggestionCount = 0;
  for (const i of list) {
    if (i.severity === 'error') errorCount++; else if (i.severity === 'warning') warningCount++; else suggestionCount++;
  }
  return { errorCount, warningCount, suggestionCount };
}

/** Convenience guard: return true if persona passes with zero errors. */
export function personaIsValid(result: PersonaValidationResult): boolean {
  return result.summary.errorCount === 0;
}

/** Convenience guard: return true if all personas have zero errors. */
export function allPersonasValid(report: PersonaValidationAggregateReport): boolean {
  return report.results.every(r => r.summary.errorCount === 0);
}

/** Human-friendly summarization string for logging / CLI contexts. */
export function formatAggregateReport(report: PersonaValidationAggregateReport): string {
  const lines: string[] = [];
  lines.push(`Persona Validation: ${report.totals.errors} errors, ${report.totals.warnings} warnings, ${report.totals.suggestions} suggestions.`);
  for (const res of report.results) {
    lines.push(` - [${res.personaId}] errors=${res.summary.errorCount} warnings=${res.summary.warningCount} suggestions=${res.summary.suggestionCount}`);
    res.issues.forEach(issue => {
      lines.push(`    * (${issue.severity}) ${issue.code} ${issue.field ? '[' + issue.field + ']' : ''}: ${issue.message}`);
    });
  }
  if (report.activationKeywordConflicts.length) {
    lines.push(' Activation Keyword Conflicts:');
    report.activationKeywordConflicts.forEach(c => lines.push(`   - '${c.keyword}' => ${c.personaIds.join(', ')}`));
  }
  return lines.join('\n');
}

/**
 * Classify persona validation result as valid/invalid/degraded based on strict mode config.
 * @param result Validation result for a single persona.
 * @param strictConfig Strict mode configuration.
 * @returns Classification: status and blocked reasons if invalid.
 */
export function classifyPersonaStrict(
  result: PersonaValidationResult,
  strictConfig: PersonaValidationStrictConfig
): { status: 'valid' | 'invalid' | 'degraded'; blockedReasons: string[] } {
  if (!strictConfig.enabled || strictConfig.shadowMode) {
    // Non-enforcing: all personas treated as valid
    return { status: 'valid', blockedReasons: [] };
  }

  // Check allowlist escape hatch
  if (strictConfig.allowlistPersonaIds && strictConfig.allowlistPersonaIds.includes(result.personaId)) {
    return { status: 'valid', blockedReasons: [] };
  }

  const blockingCodes: string[] = [];

  // Determine which codes should block
  const shouldBlock = (issue: PersonaValidationIssue): boolean => {
    // If blockOnCodes is explicitly set, use that list
    if (strictConfig.blockOnCodes && strictConfig.blockOnCodes.length > 0) {
      return strictConfig.blockOnCodes.includes(issue.code);
    }
    // Otherwise: block on errors + escalated warnings
    if (issue.severity === 'error') return true;
    if (issue.severity === 'warning' && strictConfig.treatWarningsAsErrors?.includes(issue.code)) return true;
    return false;
  };

  for (const issue of result.issues) {
    if (shouldBlock(issue)) {
      blockingCodes.push(issue.code);
    }
  }

  if (blockingCodes.length > 0) {
    return { status: 'invalid', blockedReasons: blockingCodes };
  }

  // Optional: mark 'degraded' if warnings exist but not blocking
  if (result.summary.warningCount > 0) {
    return { status: 'degraded', blockedReasons: [] };
  }

  return { status: 'valid', blockedReasons: [] };
}

/**
 * Apply strict mode classification to all validation results and produce enriched persona records.
 * @param personas Array of persona definitions.
 * @param results Corresponding validation results.
 * @param strictConfig Strict mode config.
 * @returns Array of LoadedPersonaRecord with status classification.
 */
export function applyStrictMode(
  personas: IPersonaDefinition[],
  results: PersonaValidationResult[],
  strictConfig: PersonaValidationStrictConfig
): LoadedPersonaRecord[] {
  return personas.map((persona, idx) => {
    const validation = results[idx];
    const classification = classifyPersonaStrict(validation, strictConfig);
    return {
      definition: persona,
      validation,
      status: classification.status,
      blockedReasons: classification.blockedReasons.length > 0 ? classification.blockedReasons : undefined
    };
  });
}

export default {
  validatePersona,
  validatePersonas,
  personaIsValid,
  allPersonasValid,
  formatAggregateReport,
  classifyPersonaStrict,
  applyStrictMode
};
