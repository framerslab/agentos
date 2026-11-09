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
 * the later ones. Working memory keeps a run of its leading slots.
 *
 * A first pass fills each section on its share and what the sections before
 * it left unspent. A second pass spends what is still unspent and only adds to
 * the block: it lengthens a line the first pass cut and adds items the first
 * pass skipped, so every line the first pass rendered stays, in its section and
 * its order. A trace appears once: a graph association that leads to a trace
 * the block already holds (in Relevant Memories, Recent Experiences or the
 * involuntary memory) is left out of Related Context and its room goes to the
 * next association, and a trace section does not take a trace Related Context
 * already shows through its association.
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
   * or set to `undefined` or `null`, keeps its default share.
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
   *
   * Through 0.15.121 the field was `string[]`. Code that reads its elements as
   * strings no longer type-checks; narrow each element first
   * (`typeof item === 'string' ? item : item.text`).
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

/** A line a section can show. */
interface Candidate {
  /** The id of the trace the line shows: a retrieved trace, or the trace a graph association leads to. */
  id?: string;
  /** The length of the whole line. */
  length: number;
  /** The whole line. */
  whole(): string;
  /** The line shortened to fit `maxChars`, or `''` when no useful cut fits; absent for a line shown whole or not at all. */
  cut?(maxChars: number): string;
}

/** A line a section shows. */
interface ShownLine {
  text: string;
  /** Whether `text` is the whole line. A cut line can be lengthened in the second pass. */
  whole: boolean;
}

/** A section of the block: its candidate lines, in rank order, and the lines it shows. */
interface Section {
  header: string;
  candidates: readonly Candidate[];
  /** The line shown for each candidate, by index; `undefined` for a candidate the section does not show. */
  shown: (ShownLine | undefined)[];
  /**
   * End the section at the first line that does not fit, so it holds a run of leading lines (working memory's slots,
   * sorted by activation, highest first). Otherwise such a line is skipped for the later ones.
   */
  leadingOnly: boolean;
}

/** A section that shows none of `candidates` yet. */
function createSection(header: string, candidates: readonly Candidate[], leadingOnly = false): Section {
  return { header, candidates, shown: candidates.map(() => undefined), leadingOnly };
}

/** Characters `section` takes as shown, its separator and header included; 0 when it shows no line. */
function shownChars(section: Section): number {
  let chars = 0;
  let lines = 0;
  for (const line of section.shown) {
    if (!line) continue;
    lines++;
    chars += 1 + line.text.length;
  }
  return lines === 0 ? 0 : SECTION_SEPARATOR_CHARS + section.header.length + chars;
}

/** Tokens `section` takes as shown. */
function shownTokens(section: Section): number {
  return Math.ceil(shownChars(section) / 4);
}

/** The trace ids of the lines `section` shows, in order. */
function shownIds(section: Section): string[] {
  return section.candidates.flatMap((candidate, index) =>
    section.shown[index] && candidate.id !== undefined ? [candidate.id] : [],
  );
}

/** The section's text: its header, then the lines it shows in rank order; `''` when it shows none. */
function sectionText(section: Section): string {
  const lines = section.shown.flatMap((line) => (line ? [line.text] : []));
  return lines.length === 0 ? '' : `${section.header}\n${lines.join('\n')}`;
}

/**
 * Spends up to `budgetTokens` on `section`, counting what it already shows, in rank order, and keeps every line it
 * shows. A candidate it does not show is added whole when it fits what is left, otherwise cut to fit (when it can be
 * cut); one that still does not fit is skipped for the later ones, or ends the section with `leadingOnly`. A candidate
 * `skip` names is passed over. A line shown cut is lengthened, whole when it fits. The first pass fills each section
 * from nothing; the second pass fills it again on more room, so it only adds to what the first pass rendered.
 */
function fillSection(section: Section, budgetTokens: number, skip?: (candidate: Candidate) => boolean): void {
  const maxChars = budgetTokens * 4;
  let chars = SECTION_SEPARATOR_CHARS + section.header.length;
  for (const line of section.shown) if (line) chars += 1 + line.text.length;
  for (const [index, candidate] of section.candidates.entries()) {
    const free = maxChars - chars;
    if (free <= 0) break;
    const shown = section.shown[index];
    if (shown?.whole) continue;
    if (!shown && skip?.(candidate)) continue;
    // A line shown cut can grow by what is free; a new line also takes its newline.
    const room = shown ? shown.text.length + free : free - 1;
    if (room <= 0) {
      if (section.leadingOnly) break;
      continue;
    }
    // A blank line fits whole like any other; only a line too long for the room is cut or passed over.
    const fits = candidate.length <= room;
    const text = fits ? candidate.whole() : candidate.cut ? candidate.cut(room) : '';
    if (shown) {
      if (fits || text.length > shown.text.length) {
        chars += text.length - shown.text.length;
        section.shown[index] = { text, whole: fits };
      }
      continue;
    }
    if (!fits && !text) {
      if (section.leadingOnly) break;
      continue;
    }
    section.shown[index] = { text, whole: fits };
    chars += 1 + text.length;
  }
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

/** A line shown whole or not at all. */
function wholeLine(line: string): Candidate {
  return { length: line.length, whole: () => line };
}

/** A graph association's line: whole, or cut at a word boundary with its bullet and tag whole. */
function associationLine(item: { traceId?: string; text: string }): Candidate {
  const line = `- ${item.text}`;
  return {
    id: item.traceId,
    length: line.length,
    whole: () => line,
    cut: (maxChars) => cutAssociationLine(line, maxChars),
  };
}

/** Persistent memory's text: whole, or cut to fit and ended with `<!-- truncated -->`. */
function persistentLine(text: string): Candidate {
  return {
    length: text.length,
    whole: () => text,
    cut: (maxChars) => {
      const room = maxChars - PERSISTENT_TRUNCATED_MARKER.length;
      return room > 0 ? `${sliceWholeCodePoints(text, room)}${PERSISTENT_TRUNCATED_MARKER}` : '';
    },
  };
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
 * key set to `undefined` or `null` keeps its default; shares that are not finite
 * positive numbers count as 0, and shares adding up to more than 1 are scaled
 * down), capped at what its content needs. A section whose share is set to
 * exactly 0 is off: it gets no grant, takes no spill and is left out.
 *
 * The first pass goes through the sections in {@link MEMORY_BUDGET_SPILL_ORDER}:
 * each renders on its grant plus whatever the sections before it left unspent
 * (the shares of empty or under-filled sections, the rounding, and any share
 * left unallocated). The second pass, in the same order, gives what is still
 * unspent (a section that could not use its grant, such as working memory too
 * long for it) to the sections with content left out, so the block can fill
 * the whole budget. The second pass only adds to the block: it lengthens a
 * line the first pass cut, adds items the first pass skipped at their rank,
 * whole or cut to fit, and adds lines to a section that rendered none. Every
 * line the first pass rendered stays, in its section and its order, whole if
 * it was whole. An involuntary memory that did not fit its tenth whole then
 * takes what is still unspent.
 *
 * A trace appears once. A graph association that carries the id of a trace
 * the block already holds (rendered in Relevant Memories or Recent
 * Experiences, or the involuntary memory) is left out of Related Context, and
 * the room goes to the associations after it. In the second pass a trace
 * section leaves out a trace Related Context already shows through its
 * association, and an involuntary memory Related Context shows is not added.
 * As no line leaves the block, a trace an association was left out for stays
 * in the block. `tokensUsed` counts the headers and separators too and never
 * exceeds `totalTokenBudget`. The returned `allocation` holds the shares the
 * sections were granted from, after the defaults, the zeroing and the scaling.
 */
export function assembleMemoryContext(input: MemoryAssemblerInput): AssembledMemoryContext {
  return assemble(input, true);
}

/**
 * The block {@link assembleMemoryContext} renders for `input` before its
 * second pass: each section on its grant and what the sections before it left
 * unspent, and an involuntary memory on its tenth. Every line in it is in the
 * block `assembleMemoryContext` returns for the same input, in its section and
 * its order, whole if it is whole here. The mechanisms engine picks the
 * involuntary memory at random among its candidates, so a comparison of the
 * two blocks gives it one candidate.
 *
 * @internal For tests of that guarantee; not part of the package's API.
 */
export function assembleMemoryContextFirstPass(input: MemoryAssemblerInput): AssembledMemoryContext {
  return assemble(input, false);
}

/** The block for `input`: the first pass, then, with `secondPass`, the second pass and a late involuntary memory. */
function assemble(input: MemoryAssemblerInput, secondPass: boolean): AssembledMemoryContext {
  const alloc: MemoryBudgetAllocation = { ...DEFAULT_BUDGET_ALLOCATION };
  for (const key of BLOCK_ORDER) {
    const share = input.allocation?.[key];
    if (share != null) alloc[key] = share;
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

  /** A retrieved trace's line in `style`: whole, or cut at a word boundary with the cut marker. */
  const traceLine = (trace: ScoredMemoryTrace): Candidate => ({
    id: trace.id,
    length: memoryTraceLineLength(trace, style, { now }),
    whole: () => formatMemoryTrace(trace, style, { now }),
    cut: (maxChars) => formatMemoryTrace(trace, style, { now, maxChars }),
  });
  const sections: Record<SectionKey, Section> = {
    persistentMemory: createSection(HEADERS.persistentMemory, pmText ? [persistentLine(pmText)] : []),
    workingMemory: createSection(HEADERS.workingMemory, wmLines.map(wholeLine), true),
    semanticRecall: createSection(HEADERS.semanticRecall, semanticTraces.map(traceLine)),
    recentEpisodic: createSection(HEADERS.recentEpisodic, episodicTraces.map(traceLine)),
    prospectiveAlerts: createSection(HEADERS.prospectiveAlerts, prospectiveLines.map(wholeLine)),
    graphAssociations: createSection(HEADERS.graphAssociations, graphItems.map(associationLine)),
    observationNotes: createSection(HEADERS.observationNotes, observationLines.map(wholeLine)),
  };

  /**
   * What section `key` passes over so a trace appears once: Related Context an association to a trace the block holds
   * elsewhere (in a trace section, or the involuntary memory), and a trace section a trace Related Context shows
   * through its association.
   */
  const skipFor = (key: SectionKey): ((candidate: Candidate) => boolean) | undefined => {
    if (key === 'graphAssociations') {
      const held = new Set([
        ...shownIds(sections.semanticRecall),
        ...shownIds(sections.recentEpisodic),
        ...(involuntary ? [involuntary.id] : []),
      ]);
      return (candidate) => candidate.id !== undefined && held.has(candidate.id);
    }
    if (key === 'semanticRecall' || key === 'recentEpisodic') {
      const inGraph = new Set(shownIds(sections.graphAssociations));
      return (candidate) => candidate.id !== undefined && inGraph.has(candidate.id);
    }
    return undefined;
  };
  /** Gives section `key` up to `extra` tokens beyond what it shows, and returns the tokens it took of them. */
  const grow = (key: SectionKey, extra: number): number => {
    if (off(key)) return 0;
    const section = sections[key];
    const before = shownTokens(section);
    fillSection(section, before + extra, skipFor(key));
    return shownTokens(section) - before;
  };

  // --- Pass 1, in spill order: each section on its grant and whatever the sections before it left unspent ---
  let spare = Math.max(0, available - granted);
  for (const key of MEMORY_BUDGET_SPILL_ORDER) {
    spare += grant[key];
    spare -= grow(key, spare);
  }

  if (secondPass) {
    // --- Pass 2, same order: what is still unspent goes to the sections with content left out ---
    // Each section keeps every line it shows and may only lengthen a cut line or add lines, so no room comes back and
    // one pass through the order spends all a section can take.
    for (const key of MEMORY_BUDGET_SPILL_ORDER) {
      if (spare <= 0) break;
      spare -= grow(key, spare);
    }

    // --- An involuntary memory left out of its tenth, or cut to it, takes what is still unspent ---
    // The sections hold `available - spare` tokens, so the memory may grow to its own tokens plus `spare`.
    // One that Related Context already shows stays out, so the trace appears once.
    if (involuntaryTrace && spare > 0 && !shownIds(sections.graphAssociations).includes(involuntaryTrace.id)) {
      const held = involuntary?.tokens ?? 0;
      const wider = renderInvoluntary(involuntaryTrace, style, now, held + spare);
      if (wider && wider.tokens > held) involuntary = wider;
    }
  }

  const blocks: string[] = includePreamble ? [preamble] : [];
  for (const key of BLOCK_ORDER) {
    const text = sectionText(sections[key]);
    if (!text) continue;
    blocks.push(text);
    totalTokens += shownTokens(sections[key]);
  }
  // Ids in the order the sections that hold them appear.
  const includedIds = [...shownIds(sections.semanticRecall), ...shownIds(sections.recentEpisodic)];
  if (involuntary) {
    blocks.push(involuntary.text);
    totalTokens += involuntary.tokens;
    includedIds.push(involuntary.id);
  }

  return {
    contextText: blocks.join('\n\n'),
    tokensUsed: totalTokens,
    allocation: effective,
    includedMemoryIds: includedIds,
  };
}
