/**
 * @fileoverview Token-budgeted memory prompt assembly.
 *
 * Carves a token budget from the PromptEngine's RAG context allocation
 * and distributes it across memory sections:
 * - Persistent memory (MEMORY.md)
 * - Working memory scratchpad
 * - Semantic recall results
 * - Recent episodic memories
 * - Prospective alerts (Batch 2)
 * - Graph associations (Batch 2)
 * - Observation notes (Batch 2)
 *
 * Each section's share of the budget is a floor, not a ceiling: budget a
 * section leaves unused (it is empty, or its content is shorter than its
 * share) flows to the sections that still have content, in
 * {@link MEMORY_BUDGET_SPILL_ORDER}. A share set to exactly 0 turns its
 * section off. Traces and graph associations are rendered whole; one that
 * does not fit what is left of its section is cut to fit, at a word boundary,
 * with a visible marker, and an item that does not fit at all is skipped for
 * the later ones. Working memory keeps a run of its leading slots. A graph
 * association that leads to a trace the block already holds (in Relevant
 * Memories, Recent Experiences or the involuntary memory) is left out of
 * Related Context, so the trace appears once and its room goes to the next
 * association.
 *
 * @module agentos/memory/prompt/MemoryPromptAssembler
 */

import type {
  MemoryBudgetAllocation,
  AssembledMemoryContext,
  MemoryTrace,
  ScoredMemoryTrace,
} from '../types.js';
import type { HexacoTraits } from '../config.js';
import { DEFAULT_BUDGET_ALLOCATION } from '../config.js';
import {
  cutMemoryContent,
  formatMemoryTrace,
  memoryTraceLineLength,
  sliceWholeCodePoints,
  type FormattingStyle,
} from './MemoryFormatters.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Personality → formatting style
// ---------------------------------------------------------------------------

const clamp01 = (v: number | undefined): number =>
  v == null ? 0.5 : Math.max(0, Math.min(1, v));

/**
 * Select the memory formatting style based on HEXACO personality traits.
 * Highest trait wins: conscientiousness → structured, openness → narrative,
 * emotionality → emotional. Ties favor structured > narrative > emotional.
 *
 * @param traits - HEXACO personality traits
 * @returns Formatting style for memory trace presentation
 */
function selectFormattingStyle(traits: HexacoTraits): FormattingStyle {
  const c = clamp01(traits.conscientiousness);
  const o = clamp01(traits.openness);
  const e = clamp01(traits.emotionality);

  // Highest trait wins
  if (c >= o && c >= e) return 'structured';
  if (o >= c && o >= e) return 'narrative';
  return 'emotional';
}

/**
 * Build the memory usage preamble that teaches the LLM how to use
 * each memory type differently in its response.
 *
 * This preamble is critical for memory-aware behavior. Without it,
 * LLMs treat all memory sections as flat context and may announce
 * facts, list memories, or state relationships explicitly — all of
 * which feel unnatural.
 *
 * Personality variants add style-specific guidance:
 * - Structured (high conscientiousness): logical, organized references
 * - Narrative (high openness): flowing, associative references
 * - Emotional (high emotionality): empathetic, mood-aware references
 *
 * @param traits - HEXACO traits for personality-aware variant selection
 * @returns Formatted preamble string (~200 tokens)
 */
function buildMemoryPreamble(traits: HexacoTraits): string {
  const style = selectFormattingStyle(traits);

  // Personality-specific guidance on how to reference memories in conversation
  const styleGuidance = style === 'structured'
    ? '\nOrganize your references to past knowledge logically. Connect facts to the current discussion with clear reasoning.'
    : style === 'narrative'
      ? '\nLet memories flow into your responses as stories and associations. Draw creative connections between past and present.'
      : '\nLet emotional memories influence your mood and empathy. If you recall a time the user was struggling, let that inform your warmth now.';

  return `## How To Use Your Memories

- **Working Memory**: Reference directly — this is your active context.
- **Semantic Recall** (facts): Background truth. Don't announce — let it shape responses naturally.
- **Episodic Memories** (experiences): Weave in naturally. Never list.
- **Prospective Alerts** (reminders): Act on these. Bring up naturally.
- **Relational Signals** (trust/bonds): Modulate TONE, not words. Never state explicitly.
- **Graph Associations** (connected memories): Use for richer context and connection depth.
- **Partial Memories** (feeling-of-knowing): Express uncertainty naturally — "I feel like we talked about..."
${styleGuidance}`;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/** A graph association with the id of the trace it leads to. */
export interface MemoryGraphAssociation {
  /** The id of the associated trace. */
  traceId: string;
  /** The association's line, as it appears after the bullet in Related Context. */
  text: string;
}

export interface MemoryAssemblerInput {
  /** Token budget for all memory context. */
  totalTokenBudget: number;
  /**
   * Section shares of the budget (fractions; scaled down when they add up to
   * more than 1). A share is a floor for a section with content: budget left
   * unused flows on in {@link MEMORY_BUDGET_SPILL_ORDER}. A share set to
   * exactly 0 turns its section off (no grant and no spill); a key left out,
   * or set to `undefined`, keeps its default share.
   */
  allocation?: Partial<MemoryBudgetAllocation>;
  /** HEXACO traits for formatting style selection. */
  traits: HexacoTraits;

  // --- Data sources ---
  /** Working memory formatted string. */
  workingMemoryText?: string;
  /** Scored semantic/episodic traces from retrieval. */
  retrievedTraces?: ScoredMemoryTrace[];
  /** Prospective memory alerts (Batch 2). */
  prospectiveAlerts?: string[];
  /**
   * Graph association context (Batch 2): lines of text, or associations that
   * carry the id of the trace they lead to. An association whose trace the
   * block already holds (a retrieved trace rendered in Relevant Memories or
   * Recent Experiences, or the involuntary memory) is left out of Related
   * Context; a plain line is never left out for that.
   */
  graphContext?: (string | MemoryGraphAssociation)[];
  /** Observation notes (Batch 2). */
  observationNotes?: string[];
  /** Persistent markdown memory (MEMORY.md contents). */
  persistentMemoryText?: string;

  // --- Cognitive Mechanisms (optional) ---
  /** Optional cognitive mechanisms engine for involuntary recall. */
  mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /** All available traces for involuntary recall pool. */
  allTraces?: import('../types.js').MemoryTrace[];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type SectionKey = keyof MemoryBudgetAllocation;

/** The order the sections appear in the block. */
const BLOCK_ORDER: readonly SectionKey[] = [
  'persistentMemory',
  'workingMemory',
  'semanticRecall',
  'recentEpisodic',
  'prospectiveAlerts',
  'graphAssociations',
  'observationNotes',
];

/**
 * The order the sections draw on budget other sections leave unused: the
 * retrieved traces first (Semantic Recall, then Recent Episodic), then the
 * rest in the block's order.
 */
export const MEMORY_BUDGET_SPILL_ORDER: readonly (keyof MemoryBudgetAllocation)[] = [
  'semanticRecall',
  'recentEpisodic',
  'persistentMemory',
  'workingMemory',
  'prospectiveAlerts',
  'graphAssociations',
  'observationNotes',
];

const HEADERS: Record<SectionKey, string> = {
  persistentMemory: '## Persistent Memory\n',
  workingMemory: '## Active Context (in focus — reference directly)',
  semanticRecall: "## Relevant Memories (facts — use as background truth, don't announce)",
  recentEpisodic: '## Recent Experiences (events — weave in naturally, never list)',
  prospectiveAlerts: '## Reminders (act on these — bring up naturally)',
  graphAssociations: '## Related Context (connected memories — use for depth)',
  observationNotes: '## Observations',
};

const PERSISTENT_TRUNCATED_MARKER = '\n<!-- truncated -->';
const INVOLUNTARY_HEADER = '## Something This Reminds Me Of';
const INVOLUNTARY_PREFIX = '[spontaneous memory] ';

/**
 * Sections are joined with a blank line; each section is charged for the two
 * newline characters before it, so the charges of the parts never add up to
 * less than the estimate of the joined text.
 */
const SECTION_SEPARATOR_CHARS = 2;

/** Characters a section of `header` and `lines` takes, its separator included. */
function sectionChars(header: string, lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  return SECTION_SEPARATOR_CHARS + header.length + lines.reduce((n, line) => n + 1 + line.length, 0);
}

interface RenderedSection {
  text: string;
  tokens: number;
  includedIds: string[];
}

const EMPTY_SECTION: RenderedSection = { text: '', tokens: 0, includedIds: [] };

/** How {@link renderLines} treats a line that does not fit whole. */
interface RenderLinesOptions {
  /** The trace id of each line, by index; the ids of the kept lines become the section's `includedIds`. */
  ids?: readonly (string | undefined)[];
  /** Shortens a line to fit `maxChars`, or returns `''` when it cannot. */
  cut?: (line: string, maxChars: number) => string;
  /**
   * End the section at the first line that does not fit, so it holds a run of
   * leading lines (working memory's slots, sorted by activation, highest
   * first). Otherwise such a line is skipped for the later ones.
   */
  leadingOnly?: boolean;
}

/**
 * A section of lines, in order: each whole when it fits what is left of
 * `budgetTokens`; otherwise `cut` (when given) shortens it to fit, and a line
 * that still does not fit is skipped for the later ones, or ends the section
 * with `leadingOnly`.
 */
function renderLines(
  header: string,
  lines: readonly string[],
  budgetTokens: number,
  options: RenderLinesOptions = {},
): RenderedSection {
  const maxChars = budgetTokens * 4;
  let chars = SECTION_SEPARATOR_CHARS + header.length;
  const kept: string[] = [];
  const ids: string[] = [];
  for (const [index, line] of lines.entries()) {
    const room = maxChars - chars - 1;
    if (room <= 0) break;
    // A blank line fits whole like any other; only a line too long for the room is cut or passed over.
    const fits = line.length <= room;
    const fitted = fits ? line : options.cut ? options.cut(line, room) : '';
    if (!fits && !fitted) {
      if (options.leadingOnly) break;
      continue;
    }
    kept.push(fitted);
    const id = options.ids?.[index];
    if (id !== undefined) ids.push(id);
    chars += 1 + fitted.length;
  }
  if (kept.length === 0) return EMPTY_SECTION;
  return { text: `${header}\n${kept.join('\n')}`, tokens: Math.ceil(chars / 4), includedIds: ids };
}

/** A leading `[tag] ` on a graph association, kept whole when the association is cut. */
const LEADING_TAG = /^- \[[^\]\n]*\]\s/;

/**
 * A graph-association line cut at a word boundary to fit `maxChars`, its
 * bullet and leading `[tag]` whole and its text ending with the cut marker;
 * `''` when too little of the text would remain.
 */
function cutAssociationLine(line: string, maxChars: number): string {
  const prefix = LEADING_TAG.exec(line)?.[0] ?? '- ';
  const text = cutMemoryContent(line.slice(prefix.length), maxChars - prefix.length);
  return text ? `${prefix}${text}` : '';
}

/**
 * A section of traces, in order: each rendered whole when it fits what is left
 * of `budgetTokens`, otherwise cut to fit at a word boundary; a trace whose
 * cut would keep too little is skipped for the later ones.
 */
function renderTraces(
  header: string,
  traces: readonly ScoredMemoryTrace[],
  style: FormattingStyle,
  now: number,
  budgetTokens: number,
): RenderedSection {
  const maxChars = budgetTokens * 4;
  let chars = SECTION_SEPARATOR_CHARS + header.length;
  const kept: string[] = [];
  const ids: string[] = [];
  for (const trace of traces) {
    const room = maxChars - chars - 1;
    if (room <= 0) break;
    const line =
      memoryTraceLineLength(trace, style, { now }) <= room
        ? formatMemoryTrace(trace, style, { now })
        : formatMemoryTrace(trace, style, { now, maxChars: room });
    if (!line) continue;
    kept.push(line);
    ids.push(trace.id);
    chars += 1 + line.length;
  }
  if (kept.length === 0) return EMPTY_SECTION;
  return { text: `${header}\n${kept.join('\n')}`, tokens: Math.ceil(chars / 4), includedIds: ids };
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * The share of the budget (after the preamble) set aside for an involuntary
 * memory before the sections are granted theirs, so a block full of recalled
 * traces still has room for one. A memory that does not fit it whole also
 * takes what the sections leave unspent.
 */
const INVOLUNTARY_MAX_SHARE = 0.1;

/** Characters the involuntary section takes besides its trace line: separator, header, newline and prefix. */
const INVOLUNTARY_OVERHEAD_CHARS = SECTION_SEPARATOR_CHARS + INVOLUNTARY_HEADER.length + 1 + INVOLUNTARY_PREFIX.length;

interface InvoluntarySection {
  text: string;
  tokens: number;
  id: string;
}

/** The involuntary-recall section for `trace` within `budgetTokens`, or null when no useful line fits. */
function renderInvoluntary(
  trace: MemoryTrace,
  style: FormattingStyle,
  now: number,
  budgetTokens: number,
): InvoluntarySection | null {
  const roomChars = budgetTokens * 4 - INVOLUNTARY_OVERHEAD_CHARS;
  const line = roomChars > 0 ? formatMemoryTrace(trace, style, { now, maxChars: roomChars }) : '';
  if (!line) return null;
  const text = `${INVOLUNTARY_HEADER}\n${INVOLUNTARY_PREFIX}${line}`;
  return { text, tokens: Math.ceil((SECTION_SEPARATOR_CHARS + text.length) / 4), id: trace.id };
}

/**
 * Assemble memory context into a single formatted string within the given
 * token budget.
 *
 * The preamble's tokens come off the budget first, then an involuntary
 * memory's (at most {@link INVOLUNTARY_MAX_SHARE} of the rest) when a host
 * passes the mechanisms engine. Each section is then granted its share of
 * what remains (`allocation` over {@link DEFAULT_BUDGET_ALLOCATION}, where a
 * key set to `undefined` keeps its default; shares that are not finite
 * positive numbers count as 0, and shares adding up to more than 1 are scaled
 * down), capped at what its content needs. A section whose share is set to
 * exactly 0 is off: it gets no grant, takes no spill and is left out. What the grants leave (the shares of empty or
 * under-filled sections, the rounding, and any share left unallocated) flows
 * to the sections in {@link MEMORY_BUDGET_SPILL_ORDER}: each in turn renders
 * with its grant plus whatever the sections before it left unspent. A second
 * pass in the same order gives what is still unspent (a section that could
 * not use its grant, such as working memory too long for it) to the sections
 * that still have content left out, so the block can fill the whole budget.
 * An involuntary memory that did not fit its tenth whole then takes what is
 * still unspent. A graph association that carries the id of a trace the block
 * already holds (rendered in Relevant Memories or Recent Experiences, or the
 * involuntary memory) is left out of Related Context, and the room goes to the
 * associations after it; should a trace section take such a trace in the
 * second pass, Related Context is rendered again without it and the second
 * pass runs again, so the room the association held reaches the sections with
 * content left out. An involuntary memory Related Context shows is not added. `tokensUsed` counts
 * the headers and separators too and never exceeds `totalTokenBudget`. The
 * returned `allocation` holds the shares the sections were granted from, after
 * the defaults, the zeroing and the scaling.
 */
export function assembleMemoryContext(input: MemoryAssemblerInput): AssembledMemoryContext {
  const alloc: MemoryBudgetAllocation = { ...DEFAULT_BUDGET_ALLOCATION };
  for (const key of BLOCK_ORDER) {
    const share = input.allocation?.[key];
    if (share !== undefined) alloc[key] = share;
  }
  /** A section the caller turned off by setting its share to exactly 0. */
  const off = (key: SectionKey): boolean => alloc[key] === 0;

  const budget = Number.isFinite(input.totalTokenBudget) ? Math.max(0, Math.floor(input.totalTokenBudget)) : 0;
  const style = selectFormattingStyle(input.traits);
  const now = Date.now();

  let totalTokens = 0;

  // --- Memory Usage Preamble ---
  // Teaches the LLM how to use each memory type differently (~200 tokens).
  // Deducted from the budget before the sections are granted theirs. Skipped
  // when the budget is too small to fit the preamble meaningfully.
  const preamble = buildMemoryPreamble(input.traits);
  const preambleTokens = estimateTokens(preamble);
  const includePreamble = budget >= preambleTokens + 100;
  if (includePreamble) totalTokens += preambleTokens;
  const afterPreamble = budget - totalTokens;

  // --- Candidates per section ---
  const episodicTraces: ScoredMemoryTrace[] = [];
  const semanticTraces: ScoredMemoryTrace[] = [];
  for (const trace of input.retrievedTraces ?? []) {
    if (trace.type === 'episodic') {
      episodicTraces.push(trace);
    } else {
      semanticTraces.push(trace);
    }
  }

  // --- Involuntary Recall (Cognitive Mechanisms) ---
  // Chosen from the traces this turn did not retrieve, and set aside first.
  let involuntaryTrace: MemoryTrace | null = null;
  let involuntary: InvoluntarySection | null = null;
  if (input.mechanismsEngine && input.allTraces) {
    const retrievedSet = new Set((input.retrievedTraces ?? []).map((trace) => trace.id));
    involuntaryTrace = input.mechanismsEngine.onPromptAssembly(input.allTraces, retrievedSet).involuntaryMemory;
    if (involuntaryTrace) {
      involuntary = renderInvoluntary(involuntaryTrace, style, now, Math.floor(afterPreamble * INVOLUNTARY_MAX_SHARE));
    }
  }
  const available = afterPreamble - (involuntary?.tokens ?? 0);

  const bullets = (items: string[] | undefined): string[] => (items ?? []).map((item) => `- ${item}`);
  const prospectiveLines = bullets(input.prospectiveAlerts);
  const graphItems = (input.graphContext ?? []).map((item) =>
    typeof item === 'string' ? { traceId: undefined, text: item } : { traceId: item.traceId, text: item.text },
  );
  // The demand counts every association; one whose trace the block holds is left out when the section renders.
  const graphLines = graphItems.map((item) => `- ${item.text}`);
  const observationLines = bullets(input.observationNotes);
  const pmText = input.persistentMemoryText ?? '';
  const wmLines = input.workingMemoryText ? input.workingMemoryText.split('\n') : [];
  const traceChars = (header: string, traces: ScoredMemoryTrace[]): number =>
    traces.length === 0
      ? 0
      : traces.reduce(
          (n, trace) => n + 1 + memoryTraceLineLength(trace, style, { now }),
          SECTION_SEPARATOR_CHARS + header.length,
        );

  /** Tokens each section takes with all of its content whole; 0 for a section that is off. */
  const demand: Record<SectionKey, number> = {
    persistentMemory: pmText ? Math.ceil(sectionChars(HEADERS.persistentMemory, [pmText]) / 4) : 0,
    workingMemory: Math.ceil(sectionChars(HEADERS.workingMemory, wmLines) / 4),
    semanticRecall: Math.ceil(traceChars(HEADERS.semanticRecall, semanticTraces) / 4),
    recentEpisodic: Math.ceil(traceChars(HEADERS.recentEpisodic, episodicTraces) / 4),
    prospectiveAlerts: Math.ceil(sectionChars(HEADERS.prospectiveAlerts, prospectiveLines) / 4),
    graphAssociations: Math.ceil(sectionChars(HEADERS.graphAssociations, graphLines) / 4),
    observationNotes: Math.ceil(sectionChars(HEADERS.observationNotes, observationLines) / 4),
  };
  for (const key of BLOCK_ORDER) if (off(key)) demand[key] = 0;

  // --- Grants: each section's share, capped at its demand ---
  const shareOf = (key: SectionKey): number => {
    const share = alloc[key];
    return Number.isFinite(share) && share > 0 ? share : 0;
  };
  const shareSum = BLOCK_ORDER.reduce((sum, key) => sum + shareOf(key), 0);
  const scale = shareSum > 1 ? 1 / shareSum : 1;
  const grant = {} as Record<SectionKey, number>;
  const effective = {} as MemoryBudgetAllocation;
  let granted = 0;
  for (const key of BLOCK_ORDER) {
    effective[key] = shareOf(key) * scale;
    grant[key] = Math.min(demand[key], Math.floor(available * effective[key]));
    granted += grant[key];
  }

  const rendered = {} as Record<SectionKey, RenderedSection>;
  /** Ids of the traces the block holds outside Related Context, as rendered so far. */
  const idsOutsideGraph = (): Set<string> =>
    new Set([
      ...(rendered.semanticRecall?.includedIds ?? []),
      ...(rendered.recentEpisodic?.includedIds ?? []),
      ...(involuntary ? [involuntary.id] : []),
    ]);
  /** Related Context, leaving out the associations that lead to a trace the block already holds. */
  const renderGraph = (sectionBudget: number): RenderedSection => {
    const held = idsOutsideGraph();
    const items = graphItems.filter((item) => item.traceId === undefined || !held.has(item.traceId));
    return renderLines(
      HEADERS.graphAssociations,
      items.map((item) => `- ${item.text}`),
      sectionBudget,
      { cut: cutAssociationLine, ids: items.map((item) => item.traceId) },
    );
  };

  const renderSection = (key: SectionKey, sectionBudget: number): RenderedSection => {
    if (off(key)) return EMPTY_SECTION;
    switch (key) {
      case 'persistentMemory':
        return renderPersistent(pmText, sectionBudget);
      case 'workingMemory':
        return renderLines(HEADERS.workingMemory, wmLines, sectionBudget, { leadingOnly: true });
      case 'semanticRecall':
        return renderTraces(HEADERS.semanticRecall, semanticTraces, style, now, sectionBudget);
      case 'recentEpisodic':
        return renderTraces(HEADERS.recentEpisodic, episodicTraces, style, now, sectionBudget);
      case 'prospectiveAlerts':
        return renderLines(HEADERS.prospectiveAlerts, prospectiveLines, sectionBudget);
      case 'graphAssociations':
        return renderGraph(sectionBudget);
      case 'observationNotes':
        return renderLines(HEADERS.observationNotes, observationLines, sectionBudget);
      default:
        return EMPTY_SECTION;
    }
  };

  // --- Pass 1, in spill order: grant + whatever is unspent so far ---
  let spare = Math.max(0, available - granted);
  for (const key of MEMORY_BUDGET_SPILL_ORDER) {
    const sectionBudget = grant[key] + spare;
    rendered[key] = renderSection(key, sectionBudget);
    spare = sectionBudget - rendered[key].tokens;
  }

  // --- Pass 2, same order: what is still unspent goes to sections with content left out ---
  // A trace section that grows here may take a trace Related Context shows; the association then goes, and the
  // pass runs again so the room it held reaches the sections with content left out. A round ends with Related
  // Context holding no trace another section holds, and the rounds stop at one more than the associations.
  for (let round = 0; round <= graphItems.length; round++) {
    for (const key of MEMORY_BUDGET_SPILL_ORDER) {
      if (spare <= 0) break;
      if (rendered[key].tokens >= demand[key]) continue;
      const sectionBudget = rendered[key].tokens + spare;
      const again = renderSection(key, sectionBudget);
      if (again.tokens <= rendered[key].tokens) continue;
      rendered[key] = again;
      spare = sectionBudget - again.tokens;
    }
    const heldOutside = idsOutsideGraph();
    if (!rendered.graphAssociations.includedIds.some((id) => heldOutside.has(id))) break;
    const sectionBudget = rendered.graphAssociations.tokens + spare;
    rendered.graphAssociations = renderGraph(sectionBudget);
    spare = sectionBudget - rendered.graphAssociations.tokens;
  }

  // --- An involuntary memory left out of its tenth, or cut to it, takes what is still unspent ---
  // The sections hold `available - spare` tokens, so the memory may grow to its own tokens plus `spare`.
  // One that Related Context already shows stays out, so the trace appears once.
  if (involuntaryTrace && spare > 0 && !rendered.graphAssociations.includedIds.includes(involuntaryTrace.id)) {
    const held = involuntary?.tokens ?? 0;
    const wider = renderInvoluntary(involuntaryTrace, style, now, held + spare);
    if (wider && wider.tokens > held) involuntary = wider;
  }

  const sections: string[] = includePreamble ? [preamble] : [];
  for (const key of BLOCK_ORDER) {
    const section = rendered[key];
    if (!section.text) continue;
    sections.push(section.text);
    totalTokens += section.tokens;
  }
  // Ids in the order the sections that hold them appear.
  const includedIds = [...rendered.semanticRecall.includedIds, ...rendered.recentEpisodic.includedIds];
  if (involuntary) {
    sections.push(involuntary.text);
    totalTokens += involuntary.tokens;
    includedIds.push(involuntary.id);
  }

  return {
    contextText: sections.join('\n\n'),
    tokensUsed: totalTokens,
    allocation: effective,
    includedMemoryIds: includedIds,
  };
}

/**
 * The persistent-memory section: the text whole when it fits `budgetTokens`,
 * otherwise cut to fit and ended with `<!-- truncated -->`.
 */
function renderPersistent(text: string, budgetTokens: number): RenderedSection {
  if (!text) return EMPTY_SECTION;
  const header = HEADERS.persistentMemory;
  const maxChars = budgetTokens * 4;
  const wholeChars = sectionChars(header, [text]);
  if (wholeChars <= maxChars) {
    return { text: `${header}\n${text}`, tokens: Math.ceil(wholeChars / 4), includedIds: [] };
  }
  const room = maxChars - SECTION_SEPARATOR_CHARS - header.length - 1 - PERSISTENT_TRUNCATED_MARKER.length;
  if (room <= 0) return EMPTY_SECTION;
  const cut = `${sliceWholeCodePoints(text, room)}${PERSISTENT_TRUNCATED_MARKER}`;
  return {
    text: `${header}\n${cut}`,
    tokens: Math.ceil(sectionChars(header, [cut]) / 4),
    includedIds: [],
  };
}
