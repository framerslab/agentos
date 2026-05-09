/**
 * @fileoverview Memory Reflector — consolidates observation notes into long-term traces.
 *
 * Activates when accumulated observation notes exceed a token threshold.
 * Uses a persona-configured LLM to:
 * 1. Merge redundant observations
 * 2. Elevate important facts to long-term memory traces
 * 3. Detect conflicts against existing memories
 * 4. Resolve conflicts based on personality (high honesty → update, high agreeableness → coexist)
 *
 * Target compression: 5-40x (many observations → few traces).
 *
 * @module agentos/memory/observation/MemoryReflector
 */

import { createHash } from 'node:crypto';
import type { MemoryTrace, MemoryType, MemoryScope } from '../../core/types.js';
import type { HexacoTraits, PADState, ReflectorConfig } from '../../core/config.js';
import type { ObservationNote } from './MemoryObserver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a reflection cycle.
 *
 * Contains the consolidated long-term traces (typed as episodic, semantic,
 * procedural, prospective, or relational), any superseded trace IDs, the
 * consumed note IDs, and the compression ratio achieved.
 */
export interface MemoryReflectionResult {
  /** New long-term memory traces to store. */
  traces: (Omit<MemoryTrace, 'id' | 'encodingStrength' | 'stability' | 'retrievalCount' | 'lastAccessedAt' | 'accessCount' | 'reinforcementInterval' | 'createdAt' | 'updatedAt'> & {
    /**
     * Reflector's chain-of-thought reasoning for why this trace matters.
     * Available for devtools/debugging; stripped before the trace is
     * passed to `CognitiveMemoryManager.encode()` for storage.
     */
    reasoning?: string;
  })[];
  /** IDs of existing traces that should be superseded. */
  supersededTraceIds: string[];
  /** IDs of observation notes that were consumed. */
  consumedNoteIds: string[];
  /** Compression ratio achieved. */
  compressionRatio: number;
}

// ---------------------------------------------------------------------------
// Personality-aware system prompt
// ---------------------------------------------------------------------------

/**
 * Build a personality-biased system prompt for the memory reflector.
 *
 * Personality influences (grounded in HEXACO model of personality):
 * - High honesty → prefer newer info over old on contradiction (source monitoring)
 * - High agreeableness → keep both versions on contradiction (cognitive flexibility)
 * - High conscientiousness → structured, categorized output (organizational encoding)
 * - High openness → rich, associative output (spreading activation style)
 * - High emotionality → heightened sensitivity to relational/emotional signals
 * - High extraversion → captures social dynamics and group interactions
 *
 * The chain-of-thought `<thinking>` block asks the LLM to reason about
 * each memory type before extraction, improving classification accuracy
 * and ensuring relational signals are not overlooked.
 *
 * @param traits - HEXACO personality traits of the agent
 * @returns System prompt string for the LLM reflector call
 */
function buildReflectorSystemPrompt(traits: HexacoTraits): string {
  const clamp = (v: number | undefined): number => v == null ? 0.5 : Math.max(0, Math.min(1, v));

  // Conflict resolution strategy — mirrors source monitoring in cognitive psychology.
  // High honesty agents trust newer information; high agreeableness agents preserve both.
  const conflictStrategy = clamp(traits.honesty) > 0.6
    ? 'When you detect a contradiction with existing knowledge, prefer the newer information and flag the old memory for supersession.'
    : clamp(traits.agreeableness) > 0.6
      ? 'When you detect a contradiction, keep both versions and note the discrepancy.'
      : 'When you detect a contradiction, keep the version with higher confidence.';

  // Memory organization style — mirrors encoding specificity principle.
  const memoryStyle = clamp(traits.conscientiousness) > 0.6
    ? 'Produce structured, well-organized memory traces with clear categories.'
    : clamp(traits.openness) > 0.6
      ? 'Produce rich, associative memory traces that capture connections and context.'
      : 'Produce concise, factual memory traces focused on key information.';

  // Relational sensitivity — emotionality and agreeableness heighten
  // detection of trust signals, boundary events, and social cues.
  const relationalEmphases: string[] = [];
  if (clamp(traits.emotionality) > 0.6) {
    relationalEmphases.push('Pay special attention to emotional subtleties, vulnerability signals, and shifts in emotional tone — these are important relational memories.');
  }
  if (clamp(traits.agreeableness) > 0.6) {
    relationalEmphases.push('Notice rapport cues, harmony signals, and moments of mutual understanding.');
  }
  if (clamp(traits.extraversion) > 0.6) {
    relationalEmphases.push('Capture social dynamics, group interactions, and interpersonal energy shifts.');
  }
  const relationalBlock = relationalEmphases.length > 0
    ? `\n\nRelational sensitivity:\n${relationalEmphases.map((e) => `- ${e}`).join('\n')}`
    : '';

  return `You are a memory reflector. Your job is to consolidate observation notes into long-term memory traces.

Before producing traces, reason step by step inside <thinking> tags:
1. What new FACTS did the user reveal? (semantic)
2. What EVENTS happened worth remembering? (episodic)
3. What PATTERNS or PREFERENCES emerged? (procedural)
4. What FUTURE INTENTIONS were expressed? (prospective)
5. What RELATIONSHIP SIGNALS appeared — vulnerability, trust, conflict, warmth? (relational)
6. What SPECIFIC TOKENS must be preserved verbatim? (names, dates, numeric amounts, addresses, phone numbers, product/model names, proper nouns, organization names, URLs)
7. Do any of these CONTRADICT existing memories? If so, which is more reliable?
8. What can be MERGED from multiple notes into a single trace?

Rules:
1. Merge redundant or overlapping observations into single traces
2. Assign each trace a type. Pick by what the trace IS, not by how the user phrased the request:
   - "semantic" — discrete FACTS or knowledge that can be stated as a static piece of information. ALWAYS use this for arbitrary tokens the user asks the assistant to retain (a word, a code, a phone number, a name, an address). "Remember the word YAMS" → semantic (the FACT is "YAMS is a word the user asked me to remember"). User biographical facts (occupation, age, location, family members) are also semantic.
   - "episodic" — concrete EVENTS or experiences anchored to a moment ("the user got engaged on Saturday", "we played chess yesterday"). Has a when. Has a what-happened.
   - "procedural" — HOW the user prefers things done — communication style, formatting preferences, conversational habits, skills they want demonstrated. Examples: "user prefers short replies", "user wants me to use bullet points for technical questions", "user always greets me before asking a question". NOT for what content to remember; FOR how to interact.
   - "prospective" — FUTURE intentions or reminders ("remind me to call mom on Friday", "I'll be on vacation next month").
   - "relational" — trust signals, vulnerability, boundary events, emotional bonds, relationship shifts.

   Common misclassifications to avoid:
   - User says "remember X" where X is a fact/word/datum → SEMANTIC, not procedural. The instruction "remember" is preference-flavored but the TRACE content is the fact itself.
   - User shares a biographical detail ("I live in Austin") → SEMANTIC, not episodic. No event happened; it's a static fact.
   - User states a single-turn opinion ("this conversation is fun") → relational, not semantic — it's a connection signal, not a durable fact.
   - User asks about HOW to do something during conversation ("can you keep replies short?") → PROCEDURAL — that IS a how-to/preference about interaction style.
3. Assign a scope: "user" (about the user), "thread" (conversation-specific), "persona" (about the agent), or "organization" (shared)
4. ${conflictStrategy}
5. ${memoryStyle}
6. Target 5-40x compression: many notes → few high-quality traces
7. PRESERVE LITERAL TOKENS. When a note contains specific values — names ("Alice", "Wells Fargo"), dates ("March 15, 2024"), numeric amounts ("$350,000", "3 days"), addresses, phone numbers, product or model names ("iPhone 15 Pro"), organization names, URLs — copy them VERBATIM into the consolidated trace's \`content\` field. Do NOT paraphrase, generalize, round, or abbreviate. Example:
   ❌ "The user mentioned a recent residence change."
   ✓ "User moved to Berlin on March 15, 2024."
   ❌ "User was pre-approved for a mortgage."
   ✓ "User pre-approved by Wells Fargo for $350,000 mortgage."${relationalBlock}

After your <thinking> block, output JSON objects, one per line:
{
  "reasoning": "brief explanation of why this trace matters",
  "type": "episodic|semantic|procedural|prospective|relational",
  "scope": "user|thread|persona|organization",
  "scopeId": "relevant_id",
  "content": "consolidated memory content",
  "entities": ["entity1", "entity2"],
  "tags": ["tag1", "tag2"],
  "confidence": 0.0-1.0,
  "sourceType": "observation|reflection",
  "supersedes": ["existing_trace_id_if_contradicted"],
  "consumedNotes": ["note_id1", "note_id2"]
}

Output your <thinking> block first, then ONLY valid JSON objects, one per line.`;
}

/**
 * Content-addressed hash of the reflector system prompt, computed at
 * module load time from the prompt rendered with neutral HEXACO traits.
 * Exported so consumers (bench cache-key fingerprinting, observability)
 * can auto-invalidate caches whenever the prompt text changes — no
 * manual version bumping needed.
 */
const NEUTRAL_HEXACO_TRAITS: HexacoTraits = {
  honesty: 0.5,
  emotionality: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  conscientiousness: 0.5,
  openness: 0.5,
} as HexacoTraits;

export const REFLECTOR_PROMPT_HASH: string = createHash('sha256')
  .update(buildReflectorSystemPrompt(NEUTRAL_HEXACO_TRAITS))
  .digest('hex');

// ---------------------------------------------------------------------------
// MemoryReflector
// ---------------------------------------------------------------------------

export class MemoryReflector {
  private pendingNotes: ObservationNote[] = [];
  private traits: HexacoTraits;
  private llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  private config: ReflectorConfig;

  constructor(
    traits: HexacoTraits,
    config?: Partial<ReflectorConfig>,
  ) {
    this.traits = traits;
    this.config = {
      activationThresholdTokens: config?.activationThresholdTokens ?? 40_000,
      modelId: config?.modelId,
      llmInvoker: config?.llmInvoker,
    };
    this.llmInvoker = config?.llmInvoker;
  }

  /**
   * Add observation notes for future reflection.
   * Returns a MemoryReflectionResult if the note threshold is reached.
   */
  async addNotes(notes: ObservationNote[]): Promise<MemoryReflectionResult | null> {
    this.pendingNotes.push(...notes);

    if (!this.shouldActivate()) return null;
    if (!this.llmInvoker) return null;

    return this.reflect();
  }

  /** Whether accumulated notes exceed the reflection threshold. */
  shouldActivate(): boolean {
    const totalTokens = this.pendingNotes.reduce(
      (sum, note) => sum + Math.ceil(note.content.length / 4),
      0,
    );
    return totalTokens >= this.config.activationThresholdTokens;
  }

  /**
   * Force reflection over all pending notes.
   */
  async reflect(existingMemoryContext?: string): Promise<MemoryReflectionResult> {
    if (!this.llmInvoker || this.pendingNotes.length === 0) {
      return { traces: [], supersededTraceIds: [], consumedNoteIds: [], compressionRatio: 1 };
    }

    const notesText = this.pendingNotes
      .map((n) => `[${n.id}] (${n.type}, importance=${n.importance.toFixed(2)}) ${n.content}`)
      .join('\n');

    const userPrompt = existingMemoryContext
      ? `## Existing Memory Context\n${existingMemoryContext}\n\n## New Observation Notes\n${notesText}`
      : `## Observation Notes\n${notesText}`;

    const systemPrompt = buildReflectorSystemPrompt(this.traits);

    try {
      const response = await this.llmInvoker(systemPrompt, userPrompt);
      const result = this.parseReflection(response);

      // Clear consumed notes
      const consumedSet = new Set(result.consumedNoteIds);
      this.pendingNotes = this.pendingNotes.filter((n) => !consumedSet.has(n.id));

      // Compute compression ratio
      const inputTokens = notesText.length / 4;
      const outputTokens = result.traces.reduce((sum, t) => sum + t.content.length / 4, 0);
      result.compressionRatio = outputTokens > 0 ? inputTokens / outputTokens : 1;

      return result;
    } catch {
      return { traces: [], supersededTraceIds: [], consumedNoteIds: [], compressionRatio: 1 };
    }
  }

  /** Get pending note count. */
  getPendingNoteCount(): number {
    return this.pendingNotes.length;
  }

  /** Clear all pending notes. */
  clear(): void {
    this.pendingNotes = [];
  }

  // --- Internal ---

  /**
   * Parse the LLM's reflection response into structured trace data.
   *
   * Handles:
   * - Stripping `<thinking>...</thinking>` blocks (chain-of-thought reasoning)
   * - Parsing one JSON object per line
   * - Validating and normalizing type/scope enums
   * - Preserving the optional `reasoning` field for devtools
   * - Collecting superseded and consumed note IDs
   *
   * @param llmResponse - Raw LLM output containing optional thinking block + JSON lines
   * @returns Parsed reflection result with typed traces
   */
  private parseReflection(llmResponse: string): MemoryReflectionResult {
    const traces: MemoryReflectionResult['traces'] = [];
    const supersededTraceIds: string[] = [];
    const consumedNoteIds: string[] = [];

    // Strip <thinking>...</thinking> blocks before parsing JSON lines.
    // The thinking block contains the reflector's chain-of-thought reasoning
    // which is useful for debugging but not part of the trace data.
    const cleaned = llmResponse.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    const lines = cleaned.split('\n').filter((l) => l.trim());
    const now = Date.now();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (!parsed.content) continue;

        // Validate memory type — defaults to 'semantic' for unrecognized types.
        // All 5 Tulving-extended types are accepted: episodic, semantic,
        // procedural, prospective, and relational.
        const type = (['episodic', 'semantic', 'procedural', 'prospective', 'relational'].includes(parsed.type)
          ? parsed.type
          : 'semantic') as MemoryType;

        // Validate memory scope — defaults to 'user' for unrecognized scopes.
        const scope = (['user', 'thread', 'persona', 'organization'].includes(parsed.scope)
          ? parsed.scope
          : 'user') as MemoryScope;

        traces.push({
          type,
          scope,
          scopeId: parsed.scopeId ?? '',
          content: parsed.content,
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          provenance: {
            sourceType: 'reflection',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
            verificationCount: 0,
            sourceTimestamp: now,
          },
          emotionalContext: {
            valence: 0,
            arousal: 0,
            dominance: 0,
            intensity: 0,
            gmiMood: '',
          },
          associatedTraceIds: [],
          isActive: true,
          // Preserve reasoning for devtools — CognitiveMemoryManager strips
          // this before passing to encode() since it's not part of MemoryTrace.
          reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
        });

        if (Array.isArray(parsed.supersedes)) {
          supersededTraceIds.push(...parsed.supersedes);
        }
        if (Array.isArray(parsed.consumedNotes)) {
          consumedNoteIds.push(...parsed.consumedNotes);
        }
      } catch {
        // Skip malformed lines — common when LLM outputs markdown fences or commentary
      }
    }

    // If no specific notes were claimed, consider all pending consumed.
    // This handles the case where the LLM omits consumedNotes fields
    // but still produces valid traces from the input notes.
    if (consumedNoteIds.length === 0 && traces.length > 0) {
      consumedNoteIds.push(...this.pendingNotes.map((n) => n.id));
    }

    return { traces, supersededTraceIds, consumedNoteIds, compressionRatio: 1 };
  }
}
