/**
 * @file LanguageService.ts
 * @description Lightweight reference implementation of a multilingual orchestration service.
 */
import {
  ILanguageService,
  DetectedLanguageResult,
  LanguageNegotiationParams,
  LanguageNegotiationResult,
  ILanguageDetectionProvider,
  ITranslationProvider,
  TranslationOptions,
  TranslationResult,
  isLikelyCodeBlock,
  partitionCodeAndProse,
  recombineCodeAndProse,
} from './interfaces';
import { OpenAITranslationProvider } from './providers/OpenAITranslationProvider';
import { DeepLTranslationProvider } from './providers/DeepLTranslationProvider';
import { languageLog } from './log';
import { listedErrorFields, safeWord } from '../../../core/logging/events.js';

export interface AgentOSLanguageConfig {
  defaultLanguage: string;
  supportedLanguages: string[];
  fallbackLanguages?: string[];
  pivotLanguage?: string;
  autoDetect?: boolean;
  preferSourceLanguageResponses?: boolean;
  /** Detection provider configs (ordered by priority). */
  detectionProviderConfigs?: Array<{ id: string; priority?: number; params?: Record<string, any> }>;
  /** Translation provider configs. */
  translationProviderConfigs?: Array<{ id: string; priority?: number; costTier?: 'low' | 'medium' | 'high'; supportedLanguages?: string[]; params?: Record<string, any> }>;
  /** Maximum characters to attempt direct single-shot translation before chunking. */
  maxDirectCharsPerTranslation?: number;
  /** Enable partitioning of code blocks from prose during translation for better fidelity. */
  enableCodeAwareTranslation?: boolean;
  /** Optional caching of translation outputs. */
  enableCaching?: boolean;
  /** Approximate max entries in translation cache (LRU). */
  translationCacheMaxEntries?: number;
  /** If true, attempt pivot normalization (source->pivot) before generation. */
  enablePivotNormalization?: boolean;
}

export class LanguageService implements ILanguageService {
  private detectionProviders: ILanguageDetectionProvider[] = [];
  private translationProviders: ITranslationProvider[] = [];
  private initialized = false;
  private translationCache?: Map<string, { output: string; providerId: string; ts: number }>;

  constructor(private readonly config: AgentOSLanguageConfig) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Initialize detection providers
    if (this.config.autoDetect) {
      this.detectionProviders.push(new BasicHeuristicDetectionProvider('basic_heuristic', this.config.defaultLanguage));
      // No configurable detector is built: whisper_stub (WhisperDetectionProvider) refuses text
      // detection, since Whisper detects a language only from audio, and no other id is known.
      for (const d of (this.config.detectionProviderConfigs || [])) {
        languageLog.warn('language.detector_unsupported', { detector: safeWord(d.id) });
      }
    }
    // Initialize translation providers (at least a noop)
    for (const t of (this.config.translationProviderConfigs || [])) {
      if (t.id === 'openai_chat') {
        const apiKey = process.env.OPENAI_API_KEY || (t.params?.apiKey as string);
        if (apiKey) this.translationProviders.push(new OpenAITranslationProvider(t.id, { apiKey, model: t.params?.model as string, baseUrl: t.params?.baseUrl as string | undefined }));
      } else if (t.id === 'deepl') {
        const apiKey = process.env.DEEPL_API_KEY || (t.params?.apiKey as string);
        if (apiKey) this.translationProviders.push(new DeepLTranslationProvider(t.id, { apiKey, endpoint: t.params?.endpoint as string | undefined }));
      }
    }
    // Always ensure at least one provider
    if (!this.translationProviders.length) this.translationProviders.push(new NoOpTranslationProvider('noop_translation'));
    // Initialize providers (ignore init errors to allow fallback)
    for (const p of this.translationProviders) { try { await p.initialize(); } catch {/* ignore */} }
    for (const p of this.detectionProviders) { try { if (!p.isInitialized) await p.initialize(); } catch {/* ignore */} }
    // Sort providers by priority if provided (future extension)
    this.translationProviders.sort((_a, _b) => 0);
    if (this.config.enableCaching) {
      this.translationCache = new Map();
    }
    this.initialized = true;
  }

  async detectLanguages(text: string): Promise<DetectedLanguageResult[]> {
    if (!this.initialized || !this.config.autoDetect) return [];
    const aggregated: DetectedLanguageResult[] = [];
    for (const provider of this.detectionProviders) {
      try {
        const results = await provider.detect(text);
        results.forEach(r => aggregated.push(r));
      } catch (err) {
        // One provider's failure leaves the others' results.
        languageLog.warn('language.detection_failed', { detector: safeWord(provider.id), ...listedErrorFields(err) });
      }
    }
    const byCode: Record<string, DetectedLanguageResult> = {};
    for (const r of aggregated) {
      const existing = byCode[r.code];
      if (!existing || existing.confidence < r.confidence) byCode[r.code] = r;
    }
    return Object.values(byCode).sort((a,b)=> b.confidence - a.confidence);
  }

  negotiate(params: LanguageNegotiationParams): LanguageNegotiationResult {
    const path: string[] = [];
    const supportedSet = new Set(params.supported.map(s => s.toLowerCase()));
    let source = params.explicitUserLanguage?.toLowerCase();
    let confidence = 1;
    if (!source && params.detectedLanguages && params.detectedLanguages.length > 0) {
      source = params.detectedLanguages[0].code.toLowerCase();
      confidence = params.detectedLanguages[0].confidence;
      path.push(`detected:${source}`);
    }
    if (!source) {
      source = params.configDefault.toLowerCase();
      confidence = 0.5;
      path.push(`default:${source}`);
    }
    if (params.explicitUserLanguage) path.push(`explicit:${params.explicitUserLanguage}`);
    if (params.conversationPreferred) path.push(`conversation:${params.conversationPreferred}`);
    if (params.personaDefault) path.push(`persona:${params.personaDefault}`);
    let target = params.targetLanguage || params.explicitUserLanguage || '';
    if (!target) {
      if (params.preferSourceLanguageResponses && supportedSet.has(source)) {
        target = source; path.push('preferSource');
      } else if (params.personaDefault && supportedSet.has(params.personaDefault.toLowerCase())) {
        target = params.personaDefault.toLowerCase(); path.push('personaDefault');
      } else if (supportedSet.has(source)) {
        target = source; path.push('sourceSupported');
      } else {
        const chain = params.fallbackChain || [params.configDefault];
        target = chain.find(l => supportedSet.has(l.toLowerCase()))?.toLowerCase() || params.configDefault.toLowerCase();
        path.push('fallbackChain');
      }
    }
    const pivotCandidate = this.config.pivotLanguage && this.config.pivotLanguage.toLowerCase();
    const pivotLanguage = (this.config.enablePivotNormalization && pivotCandidate && pivotCandidate !== target) ? pivotCandidate : undefined;

    return {
      sourceLanguage: source,
      targetLanguage: target,
      pivotLanguage,
      confidence,
      negotiationPath: path,
    };
  }
  /** Attempt pivot normalization of content (source->pivot) if pivot provided. */
  async maybeNormalizeForPivot(content: string, source: string, pivot?: string): Promise<{ normalized: string; providerId?: string } | null> {
    if (!pivot || pivot === source) return null;
    const translation = await this.performTranslation(content, source, pivot, { domain: 'prompt' });
    if (!translation) return null;
    return { normalized: translation.output, providerId: translation.providerId };
  }

  async maybeTranslateForDisplay(content: string, source: string, target: string): Promise<TranslationResult | null> {
    if (source === target) return null;
    return this.performTranslation(content, source, target, { domain: 'general' });
  }

  async translateQueryForRag(query: string, source: string, pivot: string): Promise<TranslationResult | null> {
    if (source === pivot) return null;
    return this.performTranslation(query, source, pivot, { domain: 'rag' });
  }

  async translateRagResults(results: Array<{ content: string; language: string }>, target: string): Promise<Array<{ content: string; sourceLanguage: string; translated?: string }>> {
    const out: Array<{ content: string; sourceLanguage: string; translated?: string }> = [];
    for (const r of results) {
      if (r.language === target) {
        out.push({ content: r.content, sourceLanguage: r.language });
      } else {
        const translated = await this.performTranslation(r.content, r.language, target, { domain: 'rag' });
        out.push({ content: r.content, sourceLanguage: r.language, translated: translated?.output });
      }
    }
    return out;
  }

  async translateToolArguments(args: Record<string, any>, source: string, toolLanguage: string): Promise<{ translatedArgs: Record<string, any>; providerId?: string } | null> {
    if (source === toolLanguage) return null;
    const serialized = JSON.stringify(args);
    const res = await this.performTranslation(serialized, source, toolLanguage, { domain: 'prompt', preserveFormatting: true });
    if (!res) return null;
    try {
      return { translatedArgs: JSON.parse(res.output), providerId: res.providerId };
    } catch {
      return { translatedArgs: args, providerId: res.providerId }; // fallback
    }
  }

  async translateToolResult(result: any, source: string, target: string): Promise<{ translatedResult: any; providerId?: string } | null> {
    if (source === target) return null;
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    const res = await this.performTranslation(serialized, source, target, { domain: 'general', preserveFormatting: true });
    if (!res) return null;
    try {
      return { translatedResult: JSON.parse(res.output), providerId: res.providerId };
    } catch {
      return { translatedResult: res.output, providerId: res.providerId };
    }
  }

  async shutdown() {
    for (const p of this.detectionProviders) if (p.shutdown) await p.shutdown();
    for (const p of this.translationProviders) if (p.shutdown) await p.shutdown();
    this.translationCache?.clear();
    this.initialized = false;
  }

  /**
   * Internal provider selection & execution with caching, code-block awareness.
   *
   * @throws {TranslationProviderError} When the provider's call fails or answers with no text;
   *   nothing is cached then, and the input is never returned as a translation.
   */
  private async performTranslation(input: string, source: string, target: string, options?: TranslationOptions): Promise<TranslationResult | null> {
    if (!this.initialized) return null;
    if (!this.translationProviders.length) return null;
    const cacheKey = this.config.enableCaching ? `${source}|${target}|${this.hashContent(input)}` : undefined;
    if (cacheKey && this.translationCache?.has(cacheKey)) {
      const cached = this.translationCache.get(cacheKey)!;
      return { output: cached.output, providerId: cached.providerId, sourceLanguage: source, targetLanguage: target };
    }
    // Select provider: first that declares support or noop fallback
    const provider = this.pickTranslationProvider(source, target) || this.translationProviders[0];
    let toTranslate = input;
    let codeBlocks: string[] = [];
    if (this.config.enableCodeAwareTranslation && !isLikelyCodeBlock(input)) {
      const partition = partitionCodeAndProse(input);
      toTranslate = partition.prose;
      codeBlocks = partition.codeBlocks;
    }
    const result = await provider.translate(toTranslate, source, target, options);
    let finalOutput = result.output;
    if (codeBlocks.length) {
      finalOutput = recombineCodeAndProse(finalOutput, codeBlocks);
    }
    if (cacheKey) {
      this.translationCache!.set(cacheKey, { output: finalOutput, providerId: provider.id, ts: Date.now() });
      // Simple LRU eviction
      if (this.translationCache!.size > (this.config.translationCacheMaxEntries ?? 500)) {
        const oldestKey = [...this.translationCache!.entries()].sort((a,b)=> a[1].ts - b[1].ts)[0][0];
        this.translationCache!.delete(oldestKey);
      }
    }
    return {
      output: finalOutput,
      providerId: provider.id,
      sourceLanguage: source,
      targetLanguage: target,
      ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
    };
  }

  private pickTranslationProvider(source: string, target: string): ITranslationProvider | undefined {
    // Future: ranking by costTier, latency, success history.
    for (const p of this.translationProviders) {
      const cfg = (this.config.translationProviderConfigs || []).find(c => c.id === p.id);
      if (!cfg || !cfg.supportedLanguages) return p; // assume universal
      const lowerSet = new Set(cfg.supportedLanguages.map(l => l.toLowerCase()));
      if (lowerSet.has(source.toLowerCase()) && lowerSet.has(target.toLowerCase())) return p;
    }
    return undefined;
  }

  private hashContent(content: string): string {
    let hash = 0, i, chr;
    if (content.length === 0) return '0';
    for (i = 0; i < content.length; i++) {
      chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(16);
  }
}

class BasicHeuristicDetectionProvider implements ILanguageDetectionProvider {
  isInitialized = true;
  constructor(public readonly id: string, private readonly defaultLang: string) {}
  async initialize() { this.isInitialized = true; }
  async detect(text: string): Promise<DetectedLanguageResult[]> {
    const lower = text.toLowerCase();
    const checks: Array<[string, RegExp]> = [
      ['en', /\b(the|and|you|of|to)\b/],
      ['es', /\b(el|la|que|de|y)\b/],
      ['fr', /\b(le|la|et|de|que)\b/],
      ['de', /\b(der|die|und|ist|nicht)\b/],
      ['it', /\b(il|la|che|e|di)\b/],
      ['pt', /\b(que|de|e|o|a)\b/],
      ['ja', /[ぁ-んァ-ン一-龯]/],
      ['zh', /[\u4e00-\u9fff]/],
      ['ko', /[\uac00-\ud7af]/],
    ];
    const results: DetectedLanguageResult[] = [];
    for (const [code, rx] of checks) if (rx.test(lower)) results.push({ code, confidence: 0.6 });
    if (results.length === 0) results.push({ code: this.defaultLang, confidence: 0.5 });
    return results.sort((a,b)=> b.confidence - a.confidence);
  }
  shutdown() { return Promise.resolve(); }
}

class NoOpTranslationProvider implements ITranslationProvider {
  isInitialized = true;
  constructor(public readonly id: string) {}
  async initialize() { this.isInitialized = true; }
  async translate(input: string, source: string, target: string) {
    return { output: input, providerId: this.id, sourceLanguage: source, targetLanguage: target };
  }
  shutdown() { return Promise.resolve(); }
}
