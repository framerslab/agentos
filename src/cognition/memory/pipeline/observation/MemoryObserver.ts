/**
 * @fileoverview Memory Observer — personality-biased background note extraction
 * with LLM-based compression and reflection tiers.
 *
 * Monitors accumulated conversation tokens via ObservationBuffer.
 * When the threshold is reached, extracts concise observation notes
 * via a persona-configured LLM (defaults to cheap model).
 *
 * Three-tier agentic memory pipeline (Mastra-style):
 *   1. Raw notes — extracted per-turn when token threshold is reached.
 *   2. Compressed observations — produced by ObservationCompressor when
 *      accumulated notes exceed the compression threshold (default: 50 notes).
 *   3. Reflections — produced by ObservationReflector when compressed
 *      observations exceed the reflection token threshold (default: 40,000 tokens).
 *
 * Personality bias:
 * - High emotionality → notes emotional shifts
 * - High conscientiousness → notes commitments/deadlines
 * - High openness → notes creative tangents
 * - High agreeableness → notes user preferences and rapport cues
 * - High honesty → notes corrections and retractions
 *
 * @module agentos/memory/observation/MemoryObserver
 */

import type { HexacoTraits, PADState, ObserverConfig } from '../../core/config.js';
import { ObservationBuffer, type BufferedMessage } from './ObservationBuffer.js';
import { ObservationCompressor, type CompressedObservation } from './ObservationCompressor.js';
import { ObservationReflector, type Reflection } from './ObservationReflector.js';
import { relativeTimeLabel } from './temporal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservationNote {
  id: string;
  /** Category of observation. */
  type: 'factual' | 'emotional' | 'commitment' | 'preference' | 'creative' | 'correction';
  /** Short summary of the observation. */
  content: string;
  /** 0-1 importance score. */
  importance: number;
  /** Entities mentioned. */
  entities: string[];
  /** Emotional context at observation time. */
  emotionalContext?: { valence: number; arousal: number };
  timestamp: number;
  /** Three-date temporal metadata. */
  temporal?: {
    /** When this observation was made (Unix ms). Same as timestamp. */
    observedAt: number;
    /** When the referenced event actually occurred (Unix ms). */
    referencedAt: number;
    /** Human-friendly relative time label. */
    relativeLabel: string;
  };
}

// ---------------------------------------------------------------------------
// Personality-aware system prompt builder
// ---------------------------------------------------------------------------

function buildObserverSystemPrompt(traits: HexacoTraits): string {
  const clamp = (v: number | undefined): number => v == null ? 0.5 : Math.max(0, Math.min(1, v));

  const emphases: string[] = [];
  if (clamp(traits.emotionality) > 0.6) emphases.push('Pay special attention to emotional shifts, tone changes, and sentiment transitions.');
  if (clamp(traits.conscientiousness) > 0.6) emphases.push('Note any commitments, deadlines, action items, or structured plans.');
  if (clamp(traits.openness) > 0.6) emphases.push('Capture creative tangents, novel ideas, and exploratory topics.');
  if (clamp(traits.agreeableness) > 0.6) emphases.push('Track user preferences, rapport cues, and communication style patterns.');
  if (clamp(traits.honesty) > 0.6) emphases.push('Flag any corrections, retractions, or contradictions to prior statements.');

  const emphasisBlock = emphases.length > 0
    ? `\n\nPriority focus areas:\n${emphases.map((e) => `- ${e}`).join('\n')}`
    : '';

  return `You are a memory observer. Extract concise observation notes from the conversation below.

For each observation, output a JSON object on its own line with these fields:
- type: "factual" | "emotional" | "commitment" | "preference" | "creative" | "correction"
- content: brief summary (1-2 sentences max)
- importance: 0.0-1.0 (how important is this for future recall?)
- entities: string[] (key entities mentioned)

Important rules:
- NEVER preserve raw profanity, slurs, or insults in observation content. Summarize the emotional context instead.
- Distinguish between user attributes and frustration directed at the AI. "You're an idiot" is feedback about assistant quality, NOT a user characteristic — store as "user expressed frustration with response" not the raw insult.
- Users talking to AI may use extreme language — this is normal venting, not a personality trait to record.

Output ONLY valid JSON objects, one per line. No markdown, no explanation.${emphasisBlock}`;
}

// ---------------------------------------------------------------------------
// MemoryObserver
// ---------------------------------------------------------------------------

let noteIdCounter = 0;

/** Default number of accumulated notes before compression triggers. */
const DEFAULT_COMPRESSION_THRESHOLD = 50;

/** Default token count of compressed observations before reflection triggers. */
const DEFAULT_REFLECTION_THRESHOLD_TOKENS = 40_000;

export class MemoryObserver {
  private buffer: ObservationBuffer;
  private traits: HexacoTraits;
  private llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  private config: ObserverConfig;

  // --- Compression / reflection tier state ---
  private accumulatedNotes: ObservationNote[] = [];
  private accumulatedCompressed: CompressedObservation[] = [];
  private compressor: ObservationCompressor | null = null;
  private reflector: ObservationReflector | null = null;
  private compressionThreshold: number;
  private reflectionThresholdTokens: number;

  constructor(
    traits: HexacoTraits,
    config?: Partial<ObserverConfig>,
  ) {
    this.traits = traits;
    this.config = {
      activationThresholdTokens: config?.activationThresholdTokens ?? 30_000,
      modelId: config?.modelId,
      llmInvoker: config?.llmInvoker,
    };
    this.llmInvoker = config?.llmInvoker;
    this.buffer = new ObservationBuffer({
      activationThresholdTokens: this.config.activationThresholdTokens,
      activationThresholdMessages: config?.activationThresholdMessages,
    });

    // Default thresholds for compression and reflection tiers.
    this.compressionThreshold = DEFAULT_COMPRESSION_THRESHOLD;
    this.reflectionThresholdTokens = DEFAULT_REFLECTION_THRESHOLD_TOKENS;

    // Initialize compressor and reflector if LLM invoker is provided.
    if (this.llmInvoker) {
      this.compressor = new ObservationCompressor(this.llmInvoker, this.traits);
      this.reflector = new ObservationReflector(this.llmInvoker);
    }
  }

  /**
   * Feed a message into the observation buffer.
   * Returns observation notes if the buffer has reached activation threshold.
   */
  async observe(
    role: BufferedMessage['role'],
    content: string,
    mood?: PADState,
  ): Promise<ObservationNote[] | null> {
    const shouldActivate = this.buffer.push(role, content);

    if (!shouldActivate) return null;
    if (!this.llmInvoker) return null;

    return this.extractNotes(mood);
  }

  /**
   * Force extraction of observation notes from buffered messages.
   */
  async extractNotes(mood?: PADState): Promise<ObservationNote[]> {
    if (!this.llmInvoker) return [];

    const messages = this.buffer.drain();
    if (messages.length === 0) return [];

    // Build conversation text for the LLM
    const conversationText = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n');

    const systemPrompt = buildObserverSystemPrompt(this.traits);

    try {
      const response = await this.llmInvoker(systemPrompt, conversationText);
      const notes = this.parseNotes(response, mood, messages);

      // Accumulate notes for the compression tier.
      this.accumulatedNotes.push(...notes);

      return notes;
    } catch {
      return [];
    }
  }

  /**
   * Run compression if accumulated notes exceed the compression threshold.
   *
   * When the number of accumulated raw notes exceeds the configured threshold
   * (default: 50), the ObservationCompressor is invoked to produce denser
   * compressed observations. The raw notes are then cleared.
   *
   * @returns Compressed observations if threshold was met, null otherwise.
   */
  async compressIfNeeded(): Promise<CompressedObservation[] | null> {
    if (!this.compressor) return null;
    if (this.accumulatedNotes.length < this.compressionThreshold) return null;

    const compressed = await this.compressor.compress(this.accumulatedNotes);

    // Clear consumed notes and accumulate compressed observations.
    this.accumulatedNotes = [];
    this.accumulatedCompressed.push(...compressed);

    return compressed;
  }

  /**
   * Run reflection if accumulated compressed observations exceed the token threshold.
   *
   * When the total estimated tokens of accumulated compressed observations
   * exceeds the configured threshold (default: 40,000 tokens), the
   * ObservationReflector is invoked to extract higher-level patterns.
   *
   * @returns Reflections if threshold was met, null otherwise.
   */
  async reflectIfNeeded(): Promise<Reflection[] | null> {
    if (!this.reflector) return null;

    const totalTokens = this.accumulatedCompressed.reduce(
      (sum, o) => sum + Math.ceil(o.summary.length / 4),
      0,
    );
    if (totalTokens < this.reflectionThresholdTokens) return null;

    const reflections = await this.reflector.reflect(this.accumulatedCompressed);

    // Clear consumed compressed observations.
    this.accumulatedCompressed = [];

    return reflections;
  }

  /** Get the underlying buffer for inspection. */
  getBuffer(): ObservationBuffer {
    return this.buffer;
  }

  /** Check if observation should be triggered. */
  shouldActivate(): boolean {
    return this.buffer.shouldActivate();
  }

  /** Get the count of accumulated raw notes awaiting compression. */
  getAccumulatedNoteCount(): number {
    return this.accumulatedNotes.length;
  }

  /** Get the count of accumulated compressed observations awaiting reflection. */
  getAccumulatedCompressedCount(): number {
    return this.accumulatedCompressed.length;
  }

  /** Get the accumulated compressed observations (read-only snapshot). */
  getAccumulatedCompressed(): readonly CompressedObservation[] {
    return this.accumulatedCompressed;
  }

  /** Set the compression threshold (number of notes before compression triggers). */
  setCompressionThreshold(threshold: number): void {
    this.compressionThreshold = threshold;
  }

  /** Set the reflection token threshold (estimated tokens before reflection triggers). */
  setReflectionThresholdTokens(threshold: number): void {
    this.reflectionThresholdTokens = threshold;
  }

  /** Reset the observer. */
  clear(): void {
    this.buffer.clear();
    this.accumulatedNotes = [];
    this.accumulatedCompressed = [];
  }

  // --- Internal ---

  /**
   * Parse LLM response into ObservationNote objects.
   *
   * Attaches three-date temporal metadata from conversation message timestamps
   * when available, using the earliest message timestamp as `referencedAt`
   * and the current time as `observedAt`.
   */
  private parseNotes(
    llmResponse: string,
    mood?: PADState,
    messages?: BufferedMessage[],
  ): ObservationNote[] {
    const notes: ObservationNote[] = [];
    const lines = llmResponse.split('\n').filter((l) => l.trim());

    // Determine the earliest message timestamp for the referencedAt field.
    const earliestMessageTime = messages && messages.length > 0
      ? Math.min(...messages.map((m) => m.timestamp))
      : undefined;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.type && parsed.content) {
          const now = Date.now();
          const referencedAt = earliestMessageTime ?? now;

          notes.push({
            id: `obs_${Date.now()}_${++noteIdCounter}`,
            type: parsed.type,
            content: parsed.content,
            importance: typeof parsed.importance === 'number' ? parsed.importance : 0.5,
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            emotionalContext: mood ? { valence: mood.valence, arousal: mood.arousal } : undefined,
            timestamp: now,
            temporal: {
              observedAt: now,
              referencedAt,
              relativeLabel: relativeTimeLabel(referencedAt, now),
            },
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return notes;
  }
}
