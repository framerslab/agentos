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
 * section off. A line that shows a memory (a retrieved trace, a graph
 * association, the involuntary memory) is rendered whole or not at all: one
 * that does not fit whole in what is left of its section is left out, never
 * cut, and the lines after it are still tried, so its room goes to the next
 * line that fits. Only persistent memory's text, one document and not a ranked
 * memory, is cut to fit, with its own marker. Working memory keeps a run of
 * its leading slots. The assembled context's `lineOutcomes` reports, for
 * every trace the block was given a line for, whether the block shows it and
 * why not when it does not.
 *
 * A first pass fills each section on its share and what the sections before
 * it left unspent. A second pass spends what is still unspent and only adds to
 * the block: it adds lines the first pass left out that now fit whole (and
 * lengthens persistent memory's text when the first pass cut it), so every
 * line the first pass rendered stays, in its section and its order. A trace
 * appears once: a graph association that leads to a trace
 * the block already holds (in Relevant Memories, Recent Experiences or the
 * involuntary memory) is left out of Related Context and its room goes to the
 * next association, and a trace section does not take a trace Related Context
 * already shows through its association.
 *
 * @module agentos/memory/prompt/MemoryPromptAssembler
 */

import type {
  MemoryBudgetAllocation,
  AssembledLineOutcome,
  AssembledMemoryContext,
  MemoryTrace,
  ScoredMemoryTrace,
} from '../types.js';
import type { HexacoTraits } from '../config.js';
import { DEFAULT_BUDGET_ALLOCATION } from '../config.js';
import {
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

/**
 * The assembler's token estimate: about four characters a token, rounded up; 0 for an empty text. The GMI sizes the
 * turn's other retrieved context with it when it clamps the memory block's budget to a model's share.
 */
export const estimateMemoryTokens = (text: string): number => estimateTokens(text ?? '');

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

export type { AssembledLineOutcome } from '../types.js';

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
  /**
   * The recall pool of `retrieval: 'hybrid'`, in fused order. When set, the
   * block shows it as one Relevant Memories section, in this order, on the
   * `recall` share (unset: `semanticRecall + recentEpisodic`), with no Recent
   * Experiences section, and `retrievedTraces` is not read.
   */
  recallTraces?: ScoredMemoryTrace[];
  /**
   * Ids among `recallTraces` a memory question reserved room for (`retrieval: 'hybrid'`). Their whole lines are set
   * aside in the recall section first, in this order, while they fit; the other lines fill what is left, in their
   * order. A reserved line takes its place in `recallTraces`, so the caller puts them last to render them last. A
   * reserved line that does not fit whole is left out like any other. Not read without `recallTraces`.
   */
  reservedIds?: string[];
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

/** A section of the block; `recall` is a share of the hybrid block, which renders it in Semantic Recall's place. */
type SectionKey = Exclude<keyof MemoryBudgetAllocation, 'recall'>;

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
export const MEMORY_BUDGET_SPILL_ORDER: readonly Exclude<keyof MemoryBudgetAllocation, 'recall'>[] = [
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

/** The header of the one recall section a hybrid block shows in place of Relevant Memories and Recent Experiences. */
const RECALL_HEADER = "## Relevant Memories (facts and past events, most relevant first — use as background, don't announce)";

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
  /**
   * The line shortened to fit `maxChars`, or `''` when no useful cut fits. Only persistent memory's text has one: a
   * line that shows a memory, like every other line, is shown whole or not at all.
   */
  cut?(maxChars: number): string;
}

/** A line a section shows. */
interface ShownLine {
  text: string;
  /** Whether `text` is the whole line. Persistent memory's text, shown cut, can be lengthened in the second pass. */
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
  /**
   * The most tokens the section was offered, its header and separator included; 0 for a section that was never
   * offered any (it is off, or the budget had none for it). A line left out of a section offered nothing is left out
   * for the budget; one left out of a section offered some did not fit whole in it.
   */
  offered: number;
}

/** A section that shows none of `candidates` yet. */
function createSection(header: string, candidates: readonly Candidate[], leadingOnly = false): Section {
  return { header, candidates, shown: candidates.map(() => undefined), leadingOnly, offered: 0 };
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

/** The sections whose lines show a memory (a retrieved trace, or the trace a graph association leads to), in the block's order. */
const MEMORY_LINE_SECTIONS = ['semanticRecall', 'recentEpisodic', 'graphAssociations'] as const;

/** Tokens of a line of `chars` characters with its newline, about 4 characters a token. */
function lineTokens(chars: number): number {
  return Math.ceil((1 + chars) / 4);
}

/** The section's text: its header, then the lines it shows in rank order; `''` when it shows none. */
function sectionText(section: Section): string {
  const lines = section.shown.flatMap((line) => (line ? [line.text] : []));
  return lines.length === 0 ? '' : `${section.header}\n${lines.join('\n')}`;
}

/**
 * Spends up to `budgetTokens` on `section`, counting what it already shows, in rank order, and keeps every line it
 * shows. A candidate it does not show is added whole when it fits what is left; one that does not fit is cut to fit
 * when it has a cut form (persistent memory's text alone), and otherwise skipped for the later ones, or ends the
 * section with `leadingOnly`. A candidate `skip` names is passed over. A line shown cut is lengthened, whole when it
 * fits. The first pass fills each section from nothing; the second pass fills it again on more room, so it only adds
 * to what the first pass rendered.
 */
function fillSection(section: Section, budgetTokens: number, skip?: (candidate: Candidate) => boolean): void {
  section.offered = Math.max(section.offered, budgetTokens);
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
    // A blank line fits whole like any other; a line too long for the room is passed over, or cut when it has a cut form.
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

/** A line shown whole or not at all. */
function wholeLine(line: string): Candidate {
  return { length: line.length, whole: () => line };
}

/** A graph association's line, shown whole or not at all, with the id of the trace it leads to when it carries one. */
function associationLine(item: { traceId?: string; text: string }): Candidate {
  const line = `- ${item.text}`;
  return { id: item.traceId, length: line.length, whole: () => line };
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
 * traces still has room for one. A memory that does not fit it whole is
 * tried again, whole, on what the sections leave unspent.
 */
const INVOLUNTARY_MAX_SHARE = 0.1;

/** Characters the involuntary section takes besides its trace line: separator, header, newline and prefix. */
const INVOLUNTARY_OVERHEAD_CHARS = SECTION_SEPARATOR_CHARS + INVOLUNTARY_HEADER.length + 1 + INVOLUNTARY_PREFIX.length;

interface InvoluntarySection {
  text: string;
  tokens: number;
  id: string;
}

/** The involuntary-recall section for `trace` within `budgetTokens`, its line whole, or null when the whole line does not fit. */
function renderInvoluntary(
  trace: MemoryTrace,
  style: FormattingStyle,
  now: number,
  budgetTokens: number,
): InvoluntarySection | null {
  const roomChars = budgetTokens * 4 - INVOLUNTARY_OVERHEAD_CHARS;
  if (roomChars <= 0 || memoryTraceLineLength(trace, style, { now }) > roomChars) return null;
  const line = formatMemoryTrace(trace, style, { now });
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
 * the whole budget. The second pass only adds to the block: it adds items
 * the first pass left out at their rank, when they now fit whole, adds lines
 * to a section that rendered none, and lengthens persistent memory's text
 * when the first pass cut it. Every line the first pass rendered stays, in
 * its section and its order, whole if it was whole. An involuntary memory
 * that did not fit its tenth then takes what is still unspent, when it fits
 * that whole.
 *
 * A line that shows a memory renders whole or not at all. A retrieved trace,
 * a graph association or the involuntary memory that does not fit whole in
 * what is left of its section is left out, never cut, and the lines after it
 * in that section's order are still tried, so what drops is whole memories:
 * the ones that find no room. Only persistent memory's text is cut to fit,
 * ending with `<!-- truncated -->`. `lineOutcomes` reports each trace the
 * block was given a line for, once: `included`, under the section that shows
 * it, or `left_out` with its reason, under the first section, in the block's
 * order, that had a line for it. The reason is `budget` when that section was
 * offered no tokens at all (it is off, or the budget had none) and
 * `section_full` when the line did not fit whole in what it was offered.
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
 *
 * With `recallTraces` (`retrieval: 'hybrid'`) the recalled traces are one
 * section, Relevant Memories, in Semantic Recall's place and in the pool's
 * order, granted the `recall` share (unset: the Semantic Recall and Recent
 * Episodic shares together), and Recent Experiences is not shown. Its lines
 * are reported under `recall`, and the returned `allocation` carries that
 * share as `recall` with `semanticRecall` and `recentEpisodic` at 0.
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
  // A hybrid block: one section for every recalled trace, on the `recall` share, or the two shares it replaces.
  const pooled = input.recallTraces ?? null;
  if (pooled) {
    const share = input.allocation?.recall;
    // A share that counts as 0 (not a finite positive number) adds nothing to the one it is merged with.
    const valid = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
    alloc.semanticRecall = share != null ? share : valid(alloc.semanticRecall) + valid(alloc.recentEpisodic);
    alloc.recentEpisodic = 0;
  }
  /** A section the caller turned off by setting its share to exactly 0. */
  const off = (key: SectionKey): boolean => alloc[key] === 0;
  /** Semantic Recall's header, or the one recall section's in a hybrid block. */
  const semanticHeader = pooled ? RECALL_HEADER : HEADERS.semanticRecall;

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
  const semanticTraces: ScoredMemoryTrace[] = pooled ? [...pooled] : [];
  for (const trace of pooled ? [] : (input.retrievedTraces ?? [])) {
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
  /** The most tokens the involuntary memory was offered: its tenth, or what the sections left unspent. */
  let involuntaryOffered = 0;
  if (input.mechanismsEngine && input.allTraces) {
    const retrievedSet = new Set((pooled ?? input.retrievedTraces ?? []).map((trace) => trace.id));
    involuntaryTrace = input.mechanismsEngine.onPromptAssembly(input.allTraces, retrievedSet).involuntaryMemory;
    if (involuntaryTrace) {
      involuntaryOffered = Math.floor(afterPreamble * INVOLUNTARY_MAX_SHARE);
      involuntary = renderInvoluntary(involuntaryTrace, style, now, involuntaryOffered);
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
    semanticRecall: Math.ceil(traceChars(semanticHeader, semanticTraces) / 4),
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

  /** A retrieved trace's line in `style`, shown whole or not at all. */
  const traceLine = (trace: ScoredMemoryTrace): Candidate => ({
    id: trace.id,
    length: memoryTraceLineLength(trace, style, { now }),
    whole: () => formatMemoryTrace(trace, style, { now }),
  });
  const sections: Record<SectionKey, Section> = {
    persistentMemory: createSection(HEADERS.persistentMemory, pmText ? [persistentLine(pmText)] : []),
    workingMemory: createSection(HEADERS.workingMemory, wmLines.map(wholeLine), true),
    semanticRecall: createSection(semanticHeader, semanticTraces.map(traceLine)),
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
  /** The recall section's reserved lines (a hybrid block's memory question). */
  const reserved = new Set(pooled ? (input.reservedIds ?? []) : []);
  /** Gives section `key` up to `extra` tokens beyond what it shows, and returns the tokens it took of them. */
  const grow = (key: SectionKey, extra: number): number => {
    if (off(key)) return 0;
    const section = sections[key];
    const before = shownTokens(section);
    const skip = skipFor(key);
    if (key === 'semanticRecall' && reserved.size > 0) {
      // Room for the reserved lines first, then the rest of the section in order with what they left.
      fillSection(section, before + extra, (candidate) => candidate.id === undefined || !reserved.has(candidate.id) || Boolean(skip?.(candidate)));
    }
    fillSection(section, before + extra, skip);
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
    // Each section keeps every line it shows and may only add lines (or lengthen persistent memory's cut text), so no
    // room comes back and one pass through the order spends all a section can take.
    for (const key of MEMORY_BUDGET_SPILL_ORDER) {
      if (spare <= 0) break;
      spare -= grow(key, spare);
    }

    // --- An involuntary memory its tenth did not hold takes what is still unspent, when it fits that whole ---
    // One that Related Context already shows stays out, so the trace appears once.
    if (
      involuntaryTrace &&
      !involuntary &&
      spare > 0 &&
      !shownIds(sections.graphAssociations).includes(involuntaryTrace.id)
    ) {
      involuntaryOffered = Math.max(involuntaryOffered, spare);
      involuntary = renderInvoluntary(involuntaryTrace, style, now, spare);
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

  // --- What became of each line that shows a memory ---
  // One entry a trace, in the block's order: under the section that shows it, else under the first section that had
  // a line for it. A trace shown through its association, or a trace an association was left out for, is not
  // reported again under the section that passed it over.
  const shownSomewhere = new Set<string>(MEMORY_LINE_SECTIONS.flatMap((key) => shownIds(sections[key])));
  if (involuntary) shownSomewhere.add(involuntary.id);
  const lineOutcomes: AssembledLineOutcome[] = [];
  const reported = new Set<string>();
  for (const key of MEMORY_LINE_SECTIONS) {
    const section = sections[key];
    for (const [index, candidate] of section.candidates.entries()) {
      const id = candidate.id;
      if (id === undefined || reported.has(id)) continue;
      const shown = section.shown[index] !== undefined;
      // A trace a later line shows is reported there.
      if (!shown && shownSomewhere.has(id)) continue;
      reported.add(id);
      // A memory line is shown whole, so its tokens are the same shown or left out.
      const tokens = lineTokens(candidate.length);
      // A hybrid block's one recall section renders in Semantic Recall's place.
      const reportedAs = pooled && key === 'semanticRecall' ? 'recall' : key;
      lineOutcomes.push(
        shown
          ? { id, section: reportedAs, outcome: 'included', tokens }
          : { id, section: reportedAs, outcome: 'left_out', reason: section.offered === 0 ? 'budget' : 'section_full', tokens },
      );
    }
  }
  if (involuntaryTrace && !reported.has(involuntaryTrace.id)) {
    const tokens = lineTokens(INVOLUNTARY_PREFIX.length + memoryTraceLineLength(involuntaryTrace, style, { now }));
    lineOutcomes.push(
      involuntary
        ? { id: involuntaryTrace.id, section: 'involuntary', outcome: 'included', tokens }
        : {
            id: involuntaryTrace.id,
            section: 'involuntary',
            outcome: 'left_out',
            reason: involuntaryOffered === 0 ? 'budget' : 'section_full',
            tokens,
          },
    );
  }

  return {
    contextText: blocks.join('\n\n'),
    tokensUsed: totalTokens,
    // A hybrid block reports the share its one recall section was granted from as `recall`.
    allocation: pooled ? { ...effective, recall: effective.semanticRecall, semanticRecall: 0, recentEpisodic: 0 } : effective,
    includedMemoryIds: includedIds,
    lineOutcomes,
  };
}
