/**
 * @fileoverview An IUtilityAI implementation that primarily uses Large Language Models (LLMs)
 * via an AIModelProviderManager to perform its tasks. For tasks not suited to LLMs,
 * it may provide basic fallbacks or indicate non-support.
 *
 * @module backend/agentos/nlp/ai_utilities/LLMUtilityAI
 * @see ./IUtilityAI.ts
 * @see ../../core/llm/providers/AIModelProviderManager.ts
 */

import {
  IUtilityAI,
  UtilityAIConfigBase,
  ParseJsonOptions,
  SummarizationOptions,
  ClassificationOptions,
  ClassificationResult,
  KeywordExtractionOptions,
  TokenizationOptions,
  StemmingOptions,
  SimilarityOptions,
  SentimentAnalysisOptions,
  SentimentResult,
  LanguageDetectionOptions,
  LanguageDetectionResult,
  TextNormalizationOptions,
  NGramOptions,
  ReadabilityOptions,
  ReadabilityResult,
} from './IUtilityAI';
import { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import { ModelCompletionOptions, ChatMessage } from '../../../core/llm/providers/IProvider';
import { IPromptEngineUtilityAI, ModelTargetInfo } from '../../../core/llm/IPromptEngine';
import { ConversationMessage as Message, MessageRole } from '../../../core/conversation/ConversationMessage';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import { uuidv4 } from '../../../core/utils/uuid';
import Ajv from 'ajv';

type AjvValidationError = {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  params?: Record<string, unknown>;
};

type AjvValidateFn = ((data: unknown) => boolean) & { errors?: AjvValidationError[] | null };

export interface LLMUtilityAIConfig extends UtilityAIConfigBase {
  llmProviderManager: AIModelProviderManager; // Must be injected
  defaultModelId?: string; // Default model for various utility tasks if not specified per task
  defaultProviderId?: string; // Default provider if modelId doesn't specify one

  // Task-specific model preferences:
  summarizationModelId?: string;
  classificationModelId?: string;
  keywordModelId?: string;
  sentimentModelId?: string;
  languageDetectionModelId?: string;
  jsonFixerModelId?: string; // Model good at fixing/understanding JSON
  semanticSimilarityModelId?: string;
  textNormalizationModelId?: string;
  readabilityEstimationModelId?: string;
}

export class LLMUtilityAI implements IUtilityAI, IPromptEngineUtilityAI {
  public readonly utilityId: string;
  private config!: LLMUtilityAIConfig;
  private llmProviderManager!: AIModelProviderManager;
  private isInitialized: boolean = false;
  private ajv: Ajv;

  constructor(utilityId?: string) {
    this.utilityId = utilityId || `llm-utility-${uuidv4()}`;
    this.ajv = new Ajv({allErrors: true, coerceTypes: true});
  }

  public async initialize(config: LLMUtilityAIConfig): Promise<void> { // Config type is now specific
    if (this.isInitialized) {
        console.warn(`LLMUtilityAI (ID: ${this.utilityId}) already initialized. Re-initializing.`);
    }
    if (!config.llmProviderManager) {
      throw new GMIError("LLMUtilityAI requires an AIModelProviderManager instance in its configuration.", GMIErrorCode.CONFIG_ERROR, { utilityId: this.utilityId });
    }
    this.config = config;
    this.llmProviderManager = config.llmProviderManager;
    this.isInitialized = true;
    console.log(`LLMUtilityAI (ID: ${this.utilityId}) initialized.`);
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(`${this.utilityId} not initialized. Call initialize() first.`, GMIErrorCode.NOT_INITIALIZED);
    }
  }

  private getModelAndProvider(taskSpecificModelId?: string, taskSpecificProviderId?: string): {modelId: string, providerId: string} {
      const modelId = taskSpecificModelId || this.config.defaultModelId;
      const providerId = taskSpecificProviderId || this.config.defaultProviderId;

      if (!modelId) throw new GMIError("LLMUtilityAI: No modelId configured for task or as default.", GMIErrorCode.CONFIG_ERROR);
      // ProviderId can sometimes be inferred by AIModelProviderManager if modelId includes it (e.g., "openai/gpt-4o")
      // but explicit is better if available.
      if (!providerId && !modelId.includes('/')) {
          throw new GMIError(`LLMUtilityAI: No providerId configured for model '${modelId}' and cannot be inferred.`, GMIErrorCode.CONFIG_ERROR);
      }
      // If modelId is like "openai/gpt-4o", providerId can be extracted if not explicitly given.
      // AIModelProviderManager should handle this.
      return { modelId, providerId: providerId || modelId.split('/')[0] };
  }

  private async makeLLMCall(
    prompt: string,
    systemPrompt: string | undefined,
    taskHint: string,
    modelId?: string,
    providerId?: string,
    completionOptions?: Partial<ModelCompletionOptions>
  ): Promise<string> {
    this.ensureInitialized();
    const { modelId: effectiveModelId, providerId: effectiveProviderId } = this.getModelAndProvider(modelId, providerId);
    const provider = this.llmProviderManager.getProvider(effectiveProviderId);
    const canGenerate = provider && typeof (provider as any).generate === 'function';
    const canGenerateCompletion = provider && typeof (provider as any).generateCompletion === 'function';
    if (!canGenerate && !canGenerateCompletion) {
      throw new GMIError(
        `Provider '${effectiveProviderId}' is not initialized or does not support generation.`,
        GMIErrorCode.PROVIDER_NOT_FOUND
      );
    }

    const finalOptions: Record<string, any> = {
      temperature: 0.3,
      maxTokens: 1024,
      ...completionOptions,
    };
    if(systemPrompt){
        // Pass as messages if provider.generate supports it, or prepend to prompt
        // This depends on IProvider.generate signature. Assuming it takes full prompt string for now.
        // A more robust way is to use chat-like messages if IProvider.generate takes ModelChatMessage[]
    }

    // Prefer generateCompletion (chat-style) if available; fall back to raw generate.
    if (canGenerateCompletion) {
      const messages: ChatMessage[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const completionResult = await (provider as any).generateCompletion(
        effectiveModelId,
        messages,
        finalOptions,
      );
      const choice = completionResult?.choices?.[0];
      const content = choice?.message?.content ?? (choice as any)?.text;
      if (!content) {
        throw new GMIError(
          `LLM call for ${taskHint} returned no content or failed.`,
          GMIErrorCode.PROVIDER_ERROR,
          { modelId: effectiveModelId },
        );
      }
      return typeof content === 'string' ? content.trim() : String(content);
    }

    const fullPromptForGenerate = systemPrompt ? `${systemPrompt}\n\nUser: ${prompt}\n\nAssistant:` : prompt;
    const generator = provider as any;
    const result = await generator.generate(effectiveModelId, fullPromptForGenerate, finalOptions);

    if (!result.choices || result.choices.length === 0 || !result.choices[0].text) {
      throw new GMIError(`LLM call for ${taskHint} returned no content or failed.`, GMIErrorCode.PROVIDER_ERROR, { modelId: effectiveModelId });
    }
    return result.choices[0].text.trim();
  }

  public async summarize(textToSummarize: string, options?: SummarizationOptions): Promise<string> {
    const method = options?.method || 'abstractive_llm';
    if (method !== 'abstractive_llm' && method !== 'key_points_llm') {
      throw new GMIError(`LLMUtilityAI only supports 'abstractive_llm' or 'key_points_llm' for summarization. Requested: ${method}`, GMIErrorCode.NOT_SUPPORTED);
    }

    let lengthInstruction = "medium length";
    if (options?.desiredLength === 'short') lengthInstruction = "a very short, concise summary (1-2 sentences)";
    else if (options?.desiredLength === 'long') lengthInstruction = "a detailed, longer summary (multiple paragraphs if needed)";
    else if (typeof options?.desiredLength === 'number') {
        if (options.desiredLength <=1 && options.desiredLength > 0) lengthInstruction = `a summary that is approximately ${Math.round(options.desiredLength * 100)}% of the original length`;
        else if (options.desiredLength > 1) lengthInstruction = `a summary of about ${options.desiredLength} sentences`;
    }

    const styleInstruction = method === 'key_points_llm' ? "as a list of key bullet points" : "in a paragraph_format";
    const systemPrompt = `Summarize the following text to a ${lengthInstruction}, formatted ${styleInstruction}. Focus on the main ideas and key information.`;

    return this.makeLLMCall(
      textToSummarize.substring(0, options?.maxInputLength || 8000), // Limit input for safety
      systemPrompt,
      'summarization',
      options?.modelId || this.config.summarizationModelId,
      options?.methodOptions?.providerId, // Allow provider override for summarization
      { maxTokens: (typeof options?.desiredLength === 'number' && options.desiredLength > 100) ? Math.floor(options.desiredLength * 0.75) : 500 , ...options?.methodOptions }
    );
  }

  public async parseJsonSafe<T = any>(jsonString: string, options?: ParseJsonOptions<T>): Promise<T | null> {
    this.ensureInitialized();
    try {
      const parsed = JSON.parse(jsonString);
      if (options?.targetSchema) {
        const validate = this.ajv.compile(options.targetSchema) as AjvValidateFn;
        if (!validate(parsed)) {
          const validationErrors = Array.isArray(validate.errors) ? validate.errors : [];
          console.warn(`LLMUtilityAI (${this.utilityId}): Parsed JSON failed schema validation.`, validationErrors);
          throw new GMIError("Parsed JSON failed schema validation.", GMIErrorCode.VALIDATION_ERROR, { errors: validationErrors });
        }
      }
      return parsed as T;
    } catch (initialError: any) {
      if (options?.attemptFixWithLLM) {
        console.warn(`LLMUtilityAI (${this.utilityId}): Standard JSON parsing failed for input (length ${jsonString.length}). Attempting LLM fix. Error: ${initialError.message}`);
        try {
          const fixPrompt = `The following text is supposed to be a valid JSON object but failed to parse. Please correct it and return ONLY the valid JSON object. If it's unrecoverable or not JSON, return an empty JSON object {}. Text to fix:\n\n${jsonString.substring(0, 2000)}`; // Limit length of potentially broken JSON
          const fixedJsonString = await this.makeLLMCall(
            fixPrompt,
            "You are an expert JSON correction assistant. Output only valid JSON.",
            'json_fix',
            options.llmModelIdForFix || this.config.jsonFixerModelId,
            options.llmProviderIdForFix,
            { temperature: 0.0, maxTokens: Math.min(4000, Math.max(500, jsonString.length * 2)) } // Give enough tokens for fixed output
          );
          try {
            const reparsed = JSON.parse(fixedJsonString);
             if (options?.targetSchema) {
                const validate = this.ajv.compile(options.targetSchema) as AjvValidateFn;
                if (!validate(reparsed)) {
                  const validationErrors = Array.isArray(validate.errors) ? validate.errors : [];
                  console.warn(`LLMUtilityAI (${this.utilityId}): LLM-fixed JSON failed schema validation.`, validationErrors);
                  // Optionally try more repair attempts if options.maxRepairAttempts > 0
                  return null;
                }
            }
            return reparsed as T;
          } catch (reparseError: any) {
            console.error(`LLMUtilityAI (${this.utilityId}): Failed to parse LLM-fixed JSON string: ${reparseError.message}. Fixed string was: "${fixedJsonString.substring(0,200)}..."`);
            return null;
          }
        } catch (fixLlmError: any) {
          console.error(`LLMUtilityAI (${this.utilityId}): LLM call to fix JSON failed: ${fixLlmError.message}`);
          return null;
        }
      }
      console.log(`LLMUtilityAI (${this.utilityId}): JSON parsing failed and LLM fix not attempted or failed. String (start): "${jsonString.substring(0,100)}..."`);
      return null;
    }
  }


  public async classifyText(textToClassify: string, options: ClassificationOptions): Promise<ClassificationResult> {
    this.ensureInitialized();
    const systemPrompt = `Classify the following text into one or more of these classes: [${options.candidateClasses.join(', ')}].
Respond with ONLY a JSON object with "bestClass" (string or array of strings if multiLabel=${!!options.multiLabel}), "confidence" (float 0-1, or array of floats for multiLabel), and optionally "allScores" (array of {classLabel: string, score: float}).`;

    const responseText = await this.makeLLMCall(
      textToClassify,
      systemPrompt,
      'classification',
      options.modelId || this.config.classificationModelId,
      options.methodOptions?.providerId,
      { temperature: 0.2, responseFormat: { type: "json_object" }, ...options.methodOptions }
    );

    const parsed = await this.parseJsonSafe<Partial<ClassificationResult>>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId});
    if (!parsed || !parsed.bestClass || parsed.confidence === undefined) {
      throw new GMIError("Failed to parse valid classification from LLM response.", GMIErrorCode.PARSING_ERROR, { responseText });
    }
    return {
        bestClass: parsed.bestClass,
        confidence: parsed.confidence,
        allScores: parsed.allScores || options.candidateClasses.map(c => ({
            classLabel: c,
            score: (Array.isArray(parsed.bestClass) ? (parsed.bestClass as string[]).includes(c) : parsed.bestClass === c)
                   ? (Array.isArray(parsed.confidence) ? (parsed.confidence as number[])[ (parsed.bestClass as string[]).indexOf(c) ] || 0.5 : parsed.confidence as number)
                   : 0.1 // Default low score for non-selected
        }))
    };
  }

  public async extractKeywords(textToAnalyze: string, options?: KeywordExtractionOptions): Promise<string[]> {
    this.ensureInitialized();
    const maxKeywords = options?.maxKeywords || 5;
    const systemPrompt = `Extract the top ${maxKeywords} most important keywords or keyphrases (each phrase 1-4 words long) from the following text.
Respond with ONLY a JSON array of strings, e.g., ["keyword1", "keyphrase two"].`;

    const responseText = await this.makeLLMCall(
      textToAnalyze,
      systemPrompt,
      'keyword_extraction',
      options?.modelId || this.config.keywordModelId,
      options?.methodOptions?.providerId,
      { temperature: 0.3, responseFormat: { type: "json_object" }, ...options?.methodOptions }
    );
    const parsed = await this.parseJsonSafe<string[]>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId });
    if (!parsed || !Array.isArray(parsed)) {
      console.warn("LLMUtilityAI: Keyword extraction did not return a valid array, returning empty. Raw: ", responseText);
      return [];
    }
    return parsed.slice(0, maxKeywords);
  }

  public async analyzeSentiment(text: string, options?: SentimentAnalysisOptions): Promise<SentimentResult> {
    this.ensureInitialized();
    const systemPrompt = `Analyze the sentiment of the following text.
Respond with ONLY a JSON object containing "score" (float, -1.0 to 1.0, where -1 is very negative, 1 is very positive), "polarity" ("positive", "negative", or "neutral"), and optionally "intensity" (float 0-1). Provide "positiveTokens" and "negativeTokens" as arrays of strings if identifiable.`;

    const responseText = await this.makeLLMCall(
      text,
      systemPrompt,
      'sentiment_analysis',
      options?.modelId || this.config.sentimentModelId,
      options?.methodOptions?.providerId,
      { temperature: 0.3, responseFormat: { type: "json_object" }, ...options?.methodOptions }
    );
    const parsed = await this.parseJsonSafe<Partial<SentimentResult>>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId });
    if (!parsed || parsed.score === undefined || !parsed.polarity) {
        throw new GMIError("Failed to parse valid sentiment from LLM response.", GMIErrorCode.PARSING_ERROR, { responseText });
    }
    return {
      score: parsed.score,
      polarity: parsed.polarity,
      comparative: parsed.comparative ?? parsed.score, // Default comparative to score
      intensity: parsed.intensity ?? Math.abs(parsed.score),
      positiveTokens: parsed.positiveTokens || [],
      negativeTokens: parsed.negativeTokens || [],
      neutralTokens: parsed.neutralTokens || [],
    };
  }

  public async detectLanguage(text: string, options?: LanguageDetectionOptions): Promise<LanguageDetectionResult[]> {
    this.ensureInitialized();
    const maxCandidates = options?.maxCandidates || 1;
    const systemPrompt = `Detect the language of the following text.
Respond with ONLY a JSON array of objects, each with "language" (BCP-47 code like "en-US", "es", "zh-CN") and "confidence" (float 0-1), sorted by confidence. Limit to ${maxCandidates} result(s). If unsure, return an empty array or a guess with low confidence.`;

    const responseText = await this.makeLLMCall(
      text.substring(0, 1000), // Send a decent sample for detection
      systemPrompt,
      'language_detection',
      options?.modelId || this.config.languageDetectionModelId,
      options?.methodOptions?.providerId,
      { temperature: 0.1, responseFormat: { type: "json_object" }, ...options?.methodOptions }
    );
    const parsed = await this.parseJsonSafe<LanguageDetectionResult[]>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId });
    if (!parsed || !Array.isArray(parsed)) {
        console.warn("LLMUtilityAI: Language detection did not return valid array, returning unknown. Raw: ", responseText);
        return [{ language: 'und', confidence: 0.1 }]; // 'und' for undetermined
    }
    return parsed.slice(0, maxCandidates);
  }

  // --- Methods typically better suited for statistical approaches or basic JS ---
  public async tokenize(text: string, options?: TokenizationOptions): Promise<string[]> {
    this.ensureInitialized(); // Basic check
    // LLM for tokenization is overkill and often not what's meant by "tokenize" in NLP context.
    // This provides a very basic JS-based word/sentence tokenization as a fallback.
    // For BPE or other subword tokenization, one would use a dedicated tokenizer model/library.
    if(options?.type === 'subword_bpe' && options.modelId) {
        console.warn(`LLMUtilityAI (${this.utilityId}): Subword BPE tokenization with model '${options.modelId}' requested. This implementation provides basic word/sentence tokenization only. For BPE, use a dedicated tokenizer.`);
        // Fall through to basic word tokenization.
    }

    let processedText = text;
    if (options?.toLowerCase !== false) processedText = processedText.toLowerCase(); // Default true
    
    // Basic punctuation removal for word tokenization, less aggressive for sentence.
    if (options?.type !== 'sentence' && options?.removePunctuation !== false) { // Default true for words
        processedText = processedText.replace(/[.,/#!$%^&*;:{}=\-_`~()?"]/g, " "); // Keep apostrophes for contractions
    } else if (options?.type === 'sentence' && options?.removePunctuation === true) { // Only if explicitly true for sentences
        processedText = processedText.replace(/[!?"]/g, "."); // Normalize sentence enders for easier splitting, remove quotes
    }


    if (options?.type === 'sentence') {
      // Basic sentence splitting. More robust splitting needs advanced rules or libraries.
      return processedText.match(/[^.!?]+[.!?]+/g)?.map(s => s.trim()).filter(Boolean) || [processedText.trim()].filter(Boolean);
    }
    // Default to word tokenization
    return processedText.split(/\s+/).map(s => s.trim()).filter(Boolean);
  }

  public async stemTokens(tokens: string[], _options?: StemmingOptions): Promise<string[]> {
    this.ensureInitialized();
    console.warn(`LLMUtilityAI (${this.utilityId}): Stemming is an algorithmic task. This LLM-based utility will return original tokens. Use StatisticalUtilityAI for stemming.`);
    return tokens;
  }

  public async calculateSimilarity(text1: string, text2: string, options?: SimilarityOptions): Promise<number> {
    this.ensureInitialized();
    const method = options?.method || 'llm_semantic'; // Default to LLM for semantic if not specified
    if (method !== 'llm_semantic') {
        throw new GMIError(`LLMUtilityAI currently only supports 'llm_semantic' for similarity. Requested: ${method}. Use StatisticalUtilityAI for other methods.`, GMIErrorCode.NOT_SUPPORTED);
    }

    const systemPrompt = `Rate the semantic similarity of the following two texts on a scale from 0.0 (completely different) to 1.0 (semantically identical).
Respond with ONLY a JSON object: {"similarityScore": float_value_between_0_and_1}.`;
    const combinedText = `Text 1: ${text1}\n\nText 2: ${text2}`;

    const responseText = await this.makeLLMCall(
        combinedText,
        systemPrompt,
        'semantic_similarity',
        options?.llmModelId || this.config.semanticSimilarityModelId,
        options?.llmProviderId,
        {temperature: 0.1, responseFormat: { type: "json_object" } }
    );
    const parsed = await this.parseJsonSafe<{similarityScore: number}>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId});
    if (parsed && typeof parsed.similarityScore === 'number') {
        return Math.max(0, Math.min(1, parsed.similarityScore)); // Clamp to 0-1
    }
    throw new GMIError("Failed to parse valid similarity score from LLM.", GMIErrorCode.PARSING_ERROR, { responseText });
  }

  public async normalizeText(text: string, options?: TextNormalizationOptions): Promise<string> {
    this.ensureInitialized();
    // LLM-based normalization can be powerful for complex cases but slower.
    let instructions = "Normalize the following text according to these rules: ";
    if (options?.toLowerCase !== false) instructions += "Convert to lowercase. ";
    if (options?.expandContractions) instructions += "Expand common contractions (e.g., 'don't' to 'do not'). ";
    if (options?.removePunctuation) instructions += "Remove punctuation unless it's essential for meaning (like in numbers or acronyms). ";
    if (options?.stripHtml) instructions += "Remove HTML tags. ";
    if (options?.replaceNumbersWith !== undefined) {
        instructions += options.replaceNumbersWith === null ? "Remove all numbers. " : `Replace all numbers with the placeholder '${options.replaceNumbersWith}'. `;
    }
    // Stop word removal and stemming are generally too rule-based for reliable LLM execution without very specific prompting.

    const systemPrompt = instructions + "\nReturn only the fully normalized text.";
    return this.makeLLMCall(
        text,
        systemPrompt,
        'text_normalization',
        options?.language === 'en' ? (this.config.textNormalizationModelId || this.config.defaultModelId) : options?.language ? undefined : this.config.defaultModelId, // Use general model or allow specific
        undefined, // Provider
        {temperature: 0.0}
    );
  }

  public async generateNGrams(tokens: string[], options: NGramOptions): Promise<Record<number, string[][]>> {
    this.ensureInitialized();
    // This is purely algorithmic, LLM not suitable.
    console.warn(`LLMUtilityAI (${this.utilityId}): N-gram generation is algorithmic. Returning basic JS implementation. Use StatisticalUtilityAI for more robust version.`);
    const nValues = Array.isArray(options.n) ? options.n : [options.n];
    const result: Record<number, string[][]> = {};
    nValues.forEach(n => {
      if (n <= 0) { result[n] = []; return; }
      const ngrams: string[][] = [];
      const limit = options.includePartial ? tokens.length : tokens.length - n + 1;
      for (let i = 0; i < limit; i++) {
        const ngram = tokens.slice(i, i + n);
        if (!options.includePartial && ngram.length < n) continue;
        if(ngram.length > 0) ngrams.push(ngram);
      }
      result[n] = ngrams;
    });
    return result;
  }

  public async calculateReadability(text: string, options: ReadabilityOptions): Promise<ReadabilityResult> {
    this.ensureInitialized();
    const systemPrompt = `Estimate the readability of the following text using the concept of the ${options.formula} score.
Respond with ONLY a JSON object with "score" (float, the estimated score), "interpretation" (string, a brief explanation of what the score means), and optionally "gradeLevel" (string, e.g., "Approx. Grade 8").
Text: "${text.substring(0, 1500)}..."`; // Send a substantial sample

    const responseText = await this.makeLLMCall(
        text, // Full text for estimation
        systemPrompt,
        'readability_estimation',
        this.config.readabilityEstimationModelId || this.config.defaultModelId,
        undefined,
        { temperature: 0.1, responseFormat: { type: "json_object" } }
    );
    const parsed = await this.parseJsonSafe<Partial<ReadabilityResult>>(responseText, { attemptFixWithLLM: true, llmModelIdForFix: this.config.jsonFixerModelId });
    if (parsed && parsed.score !== undefined) {
      return {
        score: Number(parsed.score),
        interpretation: String(parsed.interpretation || "LLM-based estimation."),
        gradeLevel: parsed.gradeLevel ? String(parsed.gradeLevel) : undefined,
      };
    }
    throw new GMIError("Failed to parse valid readability estimation from LLM.", GMIErrorCode.PARSING_ERROR, { responseText });
  }

  private formatConversationHistory(messages: ReadonlyArray<Message>): string {
    return messages
      .map(message => {
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return `${message.role.toUpperCase()}: ${text}`;
      })
      .join('\n');
  }

  private formatRagContext(
    context: string | ReadonlyArray<{ source: string; content: string; relevance?: number }>
  ): { serialized: string; sources: string[] } {
    if (typeof context === 'string') {
      return { serialized: context, sources: [] };
    }
    const sources: string[] = [];
    const serialized = context
      .map(entry => {
        sources.push(entry.source);
        const relevance = entry.relevance !== undefined ? ` (relevance ${entry.relevance})` : '';
        return `Source: ${entry.source}${relevance}\n${entry.content}`;
      })
      .join('\n---\n');
    return { serialized, sources };
  }

  public async summarizeConversationHistory(
    messages: ReadonlyArray<Message>,
    targetTokenCount: number,
    modelInfo: Readonly<ModelTargetInfo>,
    preserveImportantMessages?: boolean
  ): Promise<{ summaryMessages: Message[]; originalTokenCount: number; finalTokenCount: number; messagesSummarized: number }> {
    this.ensureInitialized();
    const serializedHistory = this.formatConversationHistory(messages);
    const guidance = preserveImportantMessages
      ? 'Preserve critical tasks, open questions, and decisions verbatim when possible.'
      : 'Focus on outcomes and next steps.';
    const systemPrompt = `You are assisting an AgentOS orchestrator. Summarize the following conversation history for ${modelInfo.promptFormatType || 'the target model'} in approximately ${targetTokenCount} tokens. ${guidance}`;

    const summaryText = (
      await this.makeLLMCall(
        serializedHistory,
        systemPrompt,
        'conversation_summary',
        this.config.summarizationModelId,
        this.config.defaultProviderId,
        { maxTokens: Math.max(256, targetTokenCount), temperature: 0.2 }
      )
    ).trim();

    const summaryMessage: Message = {
      id: `summary-${uuidv4()}`,
      role: MessageRole.SUMMARY,
      content: summaryText,
      timestamp: Date.now(),
      metadata: {
        modificationInfo: {
          strategy: 'summarized',
          originalMessageCount: messages.length,
        },
      },
    };

    return {
      summaryMessages: [summaryMessage],
      originalTokenCount: serializedHistory.length,
      finalTokenCount: summaryText.length,
      messagesSummarized: messages.length,
    };
  }

  public async summarizeRAGContext(
    context: string | ReadonlyArray<{ source: string; content: string; relevance?: number }>,
    targetTokenCount: number,
    modelInfo: Readonly<ModelTargetInfo>,
    preserveSourceAttribution?: boolean
  ): Promise<{ summary: string; originalTokenCount: number; finalTokenCount: number; preservedSources?: string[] }> {
    this.ensureInitialized();
    const { serialized, sources } = this.formatRagContext(context);
    const systemPrompt = `You are assisting an AgentOS retrieval pipeline. Summarize the provided knowledge context for ${modelInfo.promptFormatType || 'the downstream model'} in approximately ${targetTokenCount} tokens. Preserve key facts and cite source names inline when appropriate.`;

    const summaryText = (
      await this.makeLLMCall(
        serialized,
        systemPrompt,
        'rag_context_summary',
        this.config.summarizationModelId,
        this.config.defaultProviderId,
        { maxTokens: Math.max(256, targetTokenCount), temperature: 0.2 }
      )
    ).trim();

    return {
      summary: summaryText,
      originalTokenCount: serialized.length,
      finalTokenCount: summaryText.length,
      preservedSources: preserveSourceAttribution ? sources : undefined,
    };
  }

  public async checkHealth(): Promise<{ isHealthy: boolean; details?: any; dependencies?: Array<{name: string; isHealthy: boolean; details?: any}> }> {
    if (!this.isInitialized) {
      return { isHealthy: false, details: { message: `LLMUtilityAI (ID: ${this.utilityId}) not initialized.` } };
    }
    // Check if AIModelProviderManager is available and can provide a default provider
    const providerHealth = typeof (this.llmProviderManager as any)?.checkHealth === 'function'
      ? await (this.llmProviderManager as any).checkHealth()
      : undefined;
    const providerManagerHealthy =
      providerHealth?.isOverallHealthy ??
      (this.llmProviderManager as any)?.isInitialized ??
      !!this.llmProviderManager;
    const providerManagerDetails = providerHealth || (providerManagerHealthy ? { status: 'initialized' } : { message: 'AIModelProviderManager not initialized.' });

    return {
      isHealthy: providerManagerHealthy,
      details: { utilityId: this.utilityId, status: 'Initialized', defaultModelId: this.config.defaultModelId },
      dependencies: [{ name: 'AIModelProviderManager', isHealthy: providerManagerHealthy, details: providerManagerDetails }]
    };
  }

  // Training methods are not applicable for this LLM-proxy utility AI
  public async trainModel(): Promise<{success: boolean; message?: string; modelId?: string}> {
    return { success: false, message: "Training not supported by LLMUtilityAI." };
  }
  public async saveTrainedModel(): Promise<{success: boolean; pathOrStoreId?: string; message?: string}> {
    return { success: false, message: "Model saving not supported by LLMUtilityAI." };
  }
  public async loadTrainedModel(): Promise<{success: boolean; message?: string}> {
    return { success: false, message: "Model loading not supported by LLMUtilityAI." };
  }

   public async shutdown(): Promise<void> {
    this.isInitialized = false;
    console.log(`LLMUtilityAI (ID: ${this.utilityId}) shut down.`);
    // Does not own llmProviderManager, so doesn't shut it down.
  }
}

