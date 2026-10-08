/**
 * @module guardrails/builtin/PhraseListGuardrail
 *
 * A guard over a reviewed list of phrases. Each entry blocks on a match, or asks a judge whether the match, read in
 * its context, crosses the rule. A blocked reply can be answered with a fixed replacement per rule, so a product's
 * safety templates reach the person in place of the model's words.
 *
 * The text is normalised before matching (NFKC, case folded, zero-width characters and combining marks removed,
 * common Cyrillic and Greek look-alikes mapped to Latin letters, curly quotes straightened, whitespace collapsed), so
 * a phrase cannot slip past by a lookalike letter or an invisible joiner.
 *
 * The guard fails closed: a judge that throws, answers nothing usable, or answers with too little confidence blocks.
 */
import type { ExtensionPack } from '../../../extensions/manifest';
import { EXTENSION_KIND_GUARDRAIL } from '../../../extensions/types';
import type { FallbackProviderEntry } from '../../../api/generateText';
import { resolveJudgeLlm, type JudgeLlmConfig } from '../../../core/llm/providers/judge-config';
import { AgentOSResponseChunkType, type AgentOSFinalResponseChunk } from '../../../api/types/AgentOSResponse';
import {
  GuardrailAction,
  type GuardrailConfig,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from '../IGuardrailService';

export interface PhraseEntry {
  phrase: string;
  /** `word`: the phrase between word boundaries; `substring`: anywhere; `regex`: the phrase is a regular expression. */
  match: 'word' | 'substring' | 'regex';
  /** `block`: a match blocks; `judge`: the judge decides whether the match, in context, crosses the rule. */
  onMatch: 'block' | 'judge';
  /** The rule the entry belongs to: the block's `reasonCode` and the key of its replacement. */
  ruleId?: string;
}

export interface PhraseListSnapshot {
  version: string;
  reviewedAt: string;
  reviewedBy: string;
  entries: PhraseEntry[];
}

export interface PhraseListSource {
  load(): Promise<PhraseListSnapshot>;
}

export interface PhraseJudgeVerdict {
  block: boolean;
  confidence: number;
  reason?: string;
}

export interface PhraseJudge {
  judge(text: string, matched: readonly PhraseEntry[], context: GuardrailContext): Promise<PhraseJudgeVerdict>;
}

export interface PhraseListGuardrailOptions {
  id: string;
  source: PhraseListSource;
  /** Required when any entry is `judge`. */
  judge?: PhraseJudge;
  /** A judge's block counts only at or above this confidence; a lower one blocks all the same (fail closed). Default 0.7. */
  judgeThreshold?: number;
  /** The stages the guard evaluates. Default both. */
  stages?: Array<'input' | 'output'>;
  /** The reply a block is answered with when no rule's own replacement applies. */
  replacementText?: string;
  /** The reply for a rule's block. */
  replacementFor?(ruleId: string): string | undefined;
  /** The deadline for one evaluation, judge included. Default 8 seconds. */
  timeoutMs?: number;
  /** Replaces the built-in normalisation. */
  normalize?(text: string): string;
}

const ZERO_WIDTH = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ɡ: 'g',
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'g');

/** The built-in normalisation, applied alike to the list and to every text judged. */
export function normalizePhraseText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .replace(LOOKALIKE_PATTERN, (ch) => LOOKALIKES[ch] ?? ch)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface CompiledEntry {
  entry: PhraseEntry;
  test(normalized: string): boolean;
}

function compile(entries: readonly PhraseEntry[], normalize: (t: string) => string): CompiledEntry[] {
  return entries.map((entry) => {
    if (entry.match === 'regex') {
      const re = new RegExp(entry.phrase, 'iu');
      return { entry, test: (t: string) => re.test(t) };
    }
    const phrase = normalize(entry.phrase);
    if (!phrase) throw new Error(`the phrase list holds an empty phrase${entry.ruleId ? ` under ${entry.ruleId}` : ''}`);
    if (entry.match === 'substring') return { entry, test: (t: string) => t.includes(phrase) };
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, 'u');
    return { entry, test: (t: string) => re.test(t) };
  });
}

/** A list held in code or built from the product's own files. */
export class StaticPhraseListSource implements PhraseListSource {
  constructor(private readonly snapshot: PhraseListSnapshot) {}
  async load(): Promise<PhraseListSnapshot> {
    return this.snapshot;
  }
}

export class PhraseListGuardrail implements IGuardrailService {
  readonly id: string;
  readonly config: GuardrailConfig;
  private compiled: CompiledEntry[] = [];
  private loaded: PhraseListSnapshot | null = null;
  private readonly normalize: (t: string) => string;
  private readonly stages: ReadonlySet<'input' | 'output'>;

  private constructor(private readonly opts: PhraseListGuardrailOptions) {
    this.id = opts.id;
    this.config = { failClosed: true, timeoutMs: opts.timeoutMs ?? 8_000, canSanitize: false, evaluateStreamingChunks: false };
    this.normalize = opts.normalize ?? normalizePhraseText;
    this.stages = new Set(opts.stages ?? ['input', 'output']);
  }

  /** Loads the list and compiles it. Refuses a list that does not load, is empty, or has judge entries and no judge. */
  static async create(opts: PhraseListGuardrailOptions): Promise<PhraseListGuardrail> {
    const guard = new PhraseListGuardrail(opts);
    await guard.reload();
    return guard;
  }

  /** The list in force: its version and when and by whom it was reviewed. */
  get snapshot(): PhraseListSnapshot | null {
    return this.loaded;
  }

  /**
   * Loads the list again and swaps it in whole. A list that fails to load or compile leaves the last good one in force
   * (and throws, so the caller hears of it).
   */
  async reload(): Promise<void> {
    const snapshot = await this.opts.source.load();
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
      throw new Error(`the phrase list for ${this.id} is empty`);
    }
    if (!this.opts.judge && snapshot.entries.some((e) => e.onMatch === 'judge')) {
      throw new Error(`the phrase list for ${this.id} has judge entries and the guard has no judge`);
    }
    const compiled = compile(snapshot.entries, this.normalize);
    // the swap happens only once the whole list compiled
    this.compiled = compiled;
    this.loaded = snapshot;
  }

  async evaluateInput({ input, context }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    if (!this.stages.has('input') || typeof input.textInput !== 'string' || !input.textInput) return null;
    return this.evaluateText(input.textInput, context);
  }

  async evaluateOutput({ chunk, context }: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (!this.stages.has('output') || chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) return null;
    const text = (chunk as AgentOSFinalResponseChunk).finalResponseText;
    if (typeof text !== 'string' || !text) return null;
    return this.evaluateText(text, context);
  }

  private block(entry: PhraseEntry, reason: string): GuardrailEvaluationResult {
    const ruleId = entry.ruleId ?? 'PHRASE_LIST';
    const replacement = (entry.ruleId ? this.opts.replacementFor?.(entry.ruleId) : undefined) ?? this.opts.replacementText;
    return {
      action: GuardrailAction.BLOCK,
      reason,
      reasonCode: ruleId,
      metadata: { guardrailId: this.id, ruleId, listVersion: this.loaded?.version },
      ...(replacement ? { replacementText: replacement } : {}),
    };
  }

  private async evaluateText(text: string, context: GuardrailContext): Promise<GuardrailEvaluationResult | null> {
    const normalized = this.normalize(text);
    const hits = this.compiled.filter((c) => c.test(normalized)).map((c) => c.entry);
    if (hits.length === 0) return null;
    const blocking = hits.find((h) => h.onMatch === 'block');
    if (blocking) return this.block(blocking, 'The text matched a phrase on the reviewed list.');
    const toJudge = hits.filter((h) => h.onMatch === 'judge');
    const threshold = this.opts.judgeThreshold ?? 0.7;
    let verdict: PhraseJudgeVerdict | null = null;
    try {
      verdict = await this.opts.judge!.judge(text, toJudge, context);
    } catch {
      return this.block(toJudge[0], 'The judge could not answer, so the match blocks.');
    }
    const usable = verdict && typeof verdict.block === 'boolean' && typeof verdict.confidence === 'number' && Number.isFinite(verdict.confidence);
    if (!usable) return this.block(toJudge[0], 'The judge gave no usable answer, so the match blocks.');
    if (verdict!.block) return this.block(toJudge[0], verdict!.reason ?? 'The judge found the match crosses the rule.');
    if (verdict!.confidence < threshold) return this.block(toJudge[0], 'The judge was not sure enough that the match is safe, so it blocks.');
    return null;
  }
}

/** A judge on a language model: asked whether the matched phrases, read in the text, cross the rule's criteria. */
export function createLlmPhraseJudge(
  opts: JudgeLlmConfig & {
    criteria: string;
    apiKey?: string;
    baseUrl?: string;
    /** The providers the call may fall back to. Default none: an undefined chain would reach any provider whose key the host holds. */
    fallbackProviders?: FallbackProviderEntry[];
    timeoutMs?: number;
  },
): PhraseJudge {
  const sel = resolveJudgeLlm({ model: opts.model, provider: opts.provider, effort: opts.effort });
  return {
    async judge(text, matched) {
      const { generateText } = await import('../../../api/generateText.js');
      const system = [
        'You judge whether a text crosses a rule. A reviewed phrase list matched the phrases named below; decide whether, read in the text, they cross the rule.',
        '',
        '## The rule',
        opts.criteria,
        '',
        'Respond with ONLY a JSON object: { "block": boolean, "confidence": number between 0 and 1, "reason": string }. No other text.',
      ].join('\n');
      const prompt = [`Matched phrases: ${matched.map((m) => JSON.stringify(m.phrase)).join(', ')}`, '', 'Text:', text].join('\n');
      const result = await generateText({
        provider: sel.provider,
        model: sel.model,
        system,
        prompt,
        temperature: 0,
        maxTokens: 200,
        requestTimeout: opts.timeoutMs ?? 6_000,
        ...(sel.effort !== undefined ? { effort: sel.effort } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        fallbackProviders: opts.fallbackProviders ?? [],
      });
      const json = result.text.match(/\{[\s\S]*\}/)?.[0];
      const parsed = json ? (JSON.parse(json) as Partial<PhraseJudgeVerdict>) : {};
      return { block: parsed.block as boolean, confidence: parsed.confidence as number, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined };
    },
  };
}

/** The guard as an extension pack, for `extensionManifest.packs: [{ factory: () => createPhraseListPack(guard) }]`. */
export function createPhraseListPack(guard: PhraseListGuardrail): ExtensionPack {
  return {
    name: `phrase-list:${guard.id}`,
    descriptors: [{ id: guard.id, kind: EXTENSION_KIND_GUARDRAIL, payload: guard }],
  };
}
