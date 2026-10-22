/**
 * @fileoverview An HTML page, as a page's own `DOMParser` or any DOM parsed it, read into its title and its body as
 * Markdown in the line-based profile the library's readers write: headings of levels one to three (deeper ones as the
 * third), paragraphs, lists nested by indentation with checklists, quotes, fenced code, dividers and tables of pipe
 * lines, with bold, italic, struck words and inline code. Links keep their words and images are counted, never read.
 * It walks the nodes it is given and fetches nothing; it imports nothing outside the readers.
 * @module agentos/cognition/library/readers/html
 */

import { boundOf } from './bounds.js';
import {
  CDATA_SECTION_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_NODE,
  ELEMENT_NODE,
  TEXT_NODE,
  type HtmlDocumentLike,
  type HtmlNodeLike,
} from './dom.js';
import { DIVIDER, escapeStart, writeCodeBlock, writeHeading, writeInline, writeTable, type MarkedRun } from './markdown.js';

/** How `readHtml` reads a page. */
export interface ReadHtmlOptions {
  /**
   * The most characters of Markdown. The text is cut at the last whole block that fits; past it, a paragraph keeps
   * its words up to a space that fits, a code block the lines that fit with its closing fence, a list the lines that
   * fit, a table its header and the rows that fit, and a quote the blocks that fit with the next one cut by its own
   * rule, however deep the quote sits, each line's quote marks counted. 0, any positive number or `Infinity`; a bound
   * below 0, `NaN` or no number at all is refused with a `RangeError`.
   * @default Infinity
   */
  maxCharacters?: number;
  /** The most rows a table keeps, its header row among them. Bounded as `maxCharacters` is. @default 500 */
  maxTableRows?: number;
  /** The most columns a table keeps. Bounded as `maxCharacters` is. @default 30 */
  maxTableColumns?: number;
}

/** What `readHtml` answers. */
export interface HtmlRead {
  /** The text of `<title>`, else of the first `h1`, which is then not written in the body; else `null`. */
  title: string | null;
  /** The body as Markdown, its blocks apart by one empty line; `''` for a page with no words. */
  markdown: string;
  /**
   * The images left out of the body: the `img` elements outside the parts of the page that are not read, those in
   * rows or text a bound left out among them.
   */
  images: number;
  /** True when anything was left out to keep within the bounds: characters, or a table's rows or columns. */
  cut: boolean;
}

/** The marks a run of words carries from the elements around it. */
interface Marks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
}

/** One block of the body, before it is written. */
type Block =
  | { kind: 'paragraph'; lines: MarkedRun[][] }
  | HeadingBlock
  | { kind: 'list'; list: List }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'table'; rows: MarkedRun[][][]; columns: number };

/** A heading, with its words, and whether it is the first `h1` and gave the title its words or holds the title's. */
interface HeadingBlock {
  kind: 'heading';
  level: number;
  runs: MarkedRun[];
  words: string;
  omitted: boolean;
}

/** A list and its items. */
interface List {
  ordered: boolean;
  start: number;
  items: Item[];
}

/** A list item: its words, its checkbox's state where it has one, and the lists under it. */
interface Item {
  runs: MarkedRun[];
  checked: boolean | null;
  lists: List[];
}

/** What a reading gathers beside the blocks. */
interface Reading {
  images: number;
  cut: boolean;
  /** The text of `<title>`, read before the body; `null` for a page with none or an empty one. */
  readonly named: string | null;
  /** The words of the page's first `h1` with words, once it is read. */
  firstH1: string | undefined;
  readonly maxTableRows: number;
  readonly maxTableColumns: number;
}

/** No marks. */
const PLAIN: Marks = { bold: false, italic: false, strike: false };

/** HTML's white space, with the no-break space a page writes as `&nbsp;`, which a run of words collapses to one space. */
const WHITE = /[\t\n\f\r \u00a0]+/g;

/**
 * The elements never read, with all they hold: the head and its title, scripts, styles, templates, the page's
 * navigation, header, footer and asides, frames, forms and their controls, embedded media and drawings, and the
 * annotations of ruby text.
 */
const DROPPED = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe',
  'frame',
  'frameset',
  'form',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'object',
  'embed',
  'rt',
  'rp',
]);

/** The elements that hold blocks or stand as one: each starts a paragraph of its own. */
const CONTAINERS = new Set([
  'html',
  'body',
  'main',
  'article',
  'section',
  'div',
  'p',
  'address',
  'center',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'hgroup',
  'search',
  'fieldset',
  'legend',
  'li',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

/** The list elements. */
const LISTS = new Set(['ul', 'ol', 'menu', 'dir']);

/** The elements whose text is code, as written. */
const PREFORMATTED = new Set(['pre', 'listing', 'xmp', 'plaintext']);

/** The elements whose words are inline code. */
const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

/** The elements that make their words bold, italic or struck. */
const BOLD = new Set(['b', 'strong']);
const ITALIC = new Set(['i', 'em']);
const STRUCK = new Set(['del', 's', 'strike']);

/** Every element that stands as a block: inside a line, its edges are spaces. */
const BLOCK_LEVEL = new Set([...CONTAINERS, ...LISTS, ...PREFORMATTED, 'blockquote', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** What a cell of a table holds that marks the table as one laid out for the page, not a table of data. */
const LAYOUT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'hr', ...PREFORMATTED]);

/** A table's row, its cells and its caption, by their elements' names. */
const ROW: ReadonlySet<string> = new Set(['tr']);
const CELL: ReadonlySet<string> = new Set(['td', 'th']);
const CAPTION: ReadonlySet<string> = new Set(['caption']);

/** A heading element's level, or 0. */
function headingLevel(name: string): number {
  return /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
}

/** An element's name in lower case, without a namespace's prefix. */
function nameOf(node: HtmlNodeLike): string {
  const name = node.nodeName.toLowerCase();
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Whether a node holds text: a text node or a CDATA section. */
function isText(node: HtmlNodeLike): boolean {
  return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
}

/** A node's children, in order. */
function childrenOf(node: HtmlNodeLike): HtmlNodeLike[] {
  const found: HtmlNodeLike[] = [];
  const list = node.childNodes;
  for (let at = 0; at < list.length; at += 1) {
    const child = list[at];
    if (child !== undefined && child !== null) found.push(child);
  }
  return found;
}

/** Whether an element is hidden: by `hidden`, by `aria-hidden="true"`, or by an inline style of `display: none`. */
function hidden(node: HtmlNodeLike): boolean {
  if (node.hasAttribute?.('hidden') === true) return true;
  if ((node.getAttribute?.('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
  return /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i.test(node.getAttribute?.('style') ?? '');
}

/** Whether an element and all it holds are left unread. */
function skipped(node: HtmlNodeLike, name: string): boolean {
  return DROPPED.has(name) || hidden(node);
}

/** The marks inside an element, from the marks outside it. */
function marked(marks: Marks, name: string): Marks {
  if (BOLD.has(name) && !marks.bold) return { ...marks, bold: true };
  if (ITALIC.has(name) && !marks.italic) return { ...marks, italic: true };
  if (STRUCK.has(name) && !marks.strike) return { ...marks, strike: true };
  return marks;
}

/** Adds words to a line under HTML's rule for white space: each run of it one space, none at the line's start. */
function addWords(line: MarkedRun[], text: string, marks: Marks, code: boolean): void {
  let words = text.replace(WHITE, ' ');
  const last = line[line.length - 1];
  if ((last === undefined || last.text.endsWith(' ')) && words.startsWith(' ')) words = words.slice(1);
  if (words === '') return;
  const run: MarkedRun = { text: words, bold: !code && marks.bold, italic: !code && marks.italic, strike: !code && marks.strike, code };
  if (last !== undefined && !last.code && !code && last.bold === run.bold && last.italic === run.italic && last.strike === run.strike) {
    last.text += words;
  } else {
    line.push(run);
  }
}

/** Takes the spaces off a line's end, and any run they leave empty. */
function trimEnd(line: MarkedRun[]): void {
  for (;;) {
    const last = line[line.length - 1];
    if (last === undefined) return;
    const text = last.text.replace(/ +$/, '');
    if (text !== '') {
      last.text = text;
      return;
    }
    line.pop();
  }
}

/** A line's words, without their marks. */
function plainOf(line: readonly MarkedRun[]): string {
  return line.map((run) => run.text).join('');
}

/**
 * An element's text as written, for code: text nodes as they are, a line break for `br` and at a block's edges (as a
 * highlighter that writes a line to a `div` shows it), images counted, the parts of a page that are not read left out.
 */
function textOf(node: HtmlNodeLike, reading: Reading): string {
  let text = '';
  for (const child of childrenOf(node)) {
    if (isText(child)) {
      text += child.textContent ?? '';
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name)) continue;
    if (name === 'img') {
      reading.images += 1;
      continue;
    }
    if (name === 'br') {
      text += '\n';
      continue;
    }
    const block = BLOCK_LEVEL.has(name);
    if (block && text !== '' && !text.endsWith('\n')) text += '\n';
    text += textOf(child, reading);
    if (block && text !== '' && !text.endsWith('\n')) text += '\n';
  }
  return text;
}

/** What a line's reader does with a list inside it, and with a checkbox before its words. */
interface LineHooks {
  list?: (element: HtmlNodeLike, ordered: boolean) => void;
  checkbox?: (element: HtmlNodeLike, first: boolean) => void;
}

/**
 * An element's content read as one line of words: a line break, and a block's edges, as one space; code as inline
 * code; images counted. A list inside it goes to `hooks.list` where given, and is read into the line otherwise.
 */
function lineOf(node: HtmlNodeLike, marks: Marks, reading: Reading, hooks: LineHooks = {}): MarkedRun[] {
  const line: MarkedRun[] = [];
  const visit = (current: HtmlNodeLike, at: Marks): void => {
    if (isText(current)) {
      addWords(line, current.textContent ?? '', at, false);
      return;
    }
    if (current.nodeType !== ELEMENT_NODE) return;
    const name = nameOf(current);
    if (skipped(current, name)) return;
    if (name === 'img') {
      reading.images += 1;
      return;
    }
    if (name === 'br') {
      addWords(line, ' ', at, false);
      return;
    }
    if (name === 'input') {
      hooks.checkbox?.(current, line.length === 0);
      return;
    }
    if (hooks.list !== undefined && LISTS.has(name)) {
      hooks.list(current, name === 'ol');
      return;
    }
    if (CODE.has(name) || PREFORMATTED.has(name)) {
      addWords(line, textOf(current, reading), at, true);
      return;
    }
    if (headingLevel(name) === 1 && reading.firstH1 === undefined) {
      // the page's first h1 read into a line, as a list item's words: noted for the title, and left out with its words
      // when it gives the title
      const runs = lineOf(current, at, reading);
      if (firstH1Leaves(plainOf(runs), reading)) return;
      addWords(line, ' ', at, false);
      for (const run of runs) addWords(line, run.text, run, run.code);
      addWords(line, ' ', at, false);
      return;
    }
    const block = BLOCK_LEVEL.has(name);
    if (block) addWords(line, ' ', at, false);
    const inside = marked(at, name);
    for (const child of childrenOf(current)) visit(child, inside);
    if (block) addWords(line, ' ', at, false);
  };
  for (const child of childrenOf(node)) visit(child, marks);
  trimEnd(line);
  return line;
}

/** The paragraphs a flow of block content gathers between its blocks, and the blocks. */
class Flow {
  readonly blocks: Block[] = [];
  private lines: MarkedRun[][] = [[]];

  /** Adds words to the paragraph being gathered. */
  text(text: string, marks: Marks, code: boolean): void {
    addWords(this.current(), text, marks, code);
  }

  /** Starts a new line in the paragraph being gathered, as `br` does. */
  lineBreak(): void {
    trimEnd(this.current());
    this.lines.push([]);
  }

  /**
   * Ends the paragraph being gathered: its lines trimmed, the empty ones at its edges left out and a run of them made
   * one, which reads as the empty line between two paragraphs.
   */
  flush(): void {
    const lines = this.lines;
    this.lines = [[]];
    const kept: MarkedRun[][] = [];
    for (const line of lines) {
      trimEnd(line);
      const previous = kept[kept.length - 1];
      if (line.length > 0 || (previous !== undefined && previous.length > 0)) kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1]?.length === 0) kept.pop();
    if (kept.length > 0) this.blocks.push({ kind: 'paragraph', lines: kept });
  }

  /** Ends the paragraph being gathered and adds a block after it. */
  push(block: Block | null): void {
    this.flush();
    if (block !== null) this.blocks.push(block);
  }

  private current(): MarkedRun[] {
    const line = this.lines[this.lines.length - 1];
    if (line !== undefined) return line;
    const fresh: MarkedRun[] = [];
    this.lines.push(fresh);
    return fresh;
  }
}

/**
 * Notes a page's first `h1` with words, and answers whether its words leave the body: they give a page with no
 * `<title>` its title, and they are the title's own words when `<title>` holds them.
 */
function firstH1Leaves(words: string, reading: Reading): boolean {
  if (reading.firstH1 !== undefined || words === '') return false;
  reading.firstH1 = words;
  return reading.named === null || words === reading.named;
}

/** A heading's block, `null` for a heading with no words; the first `h1` is noted for the title. */
function headingOf(node: HtmlNodeLike, level: number, marks: Marks, reading: Reading): HeadingBlock | null {
  const runs = lineOf(node, marks, reading);
  if (runs.length === 0) return null;
  const words = plainOf(runs);
  const omitted = level === 1 && firstH1Leaves(words, reading);
  return { kind: 'heading', level: Math.min(level, 3), runs, words, omitted };
}

/** A list's start: its `start` attribute when that is a number a line can write, else 1. */
function startOf(node: HtmlNodeLike): number {
  const start = Number.parseInt(node.getAttribute?.('start') ?? '', 10);
  return Number.isInteger(start) && start >= 0 && start <= 999_999_999 ? start : 1;
}

/** A list item: its words read as one line, a checkbox before them read as its state, the lists inside it under it. */
function itemOf(node: HtmlNodeLike, ordered: boolean, marks: Marks, reading: Reading): Item {
  const lists: List[] = [];
  const box: { checked: boolean | null } = { checked: null };
  const runs = lineOf(node, marks, reading, {
    list: (element, isOrdered) => {
      const list = listOf(element, isOrdered, marks, reading);
      if (list !== null) lists.push(list);
    },
    checkbox: (element, first) => {
      // a numbered list has no checklist form, so its boxes are left out
      if (ordered || !first || box.checked !== null) return;
      if ((element.getAttribute?.('type') ?? '').trim().toLowerCase() !== 'checkbox') return;
      box.checked = element.hasAttribute?.('checked') === true;
    },
  });
  return { runs, checked: box.checked, lists };
}

/**
 * A list's items, `null` for a list with no words. A list written straight inside a list goes under the item before
 * it, or under an empty item when it opens the list. A numbered list keeps an item with no words, so the numbers after
 * it stay the page's, but not one at its end; a bulleted list keeps one only for its checkbox or the lists under it.
 */
function listOf(node: HtmlNodeLike, ordered: boolean, marks: Marks, reading: Reading): List | null {
  const items: Item[] = [];
  for (const child of childrenOf(node)) {
    if (isText(child)) {
      const runs: MarkedRun[] = [];
      addWords(runs, child.textContent ?? '', marks, false);
      trimEnd(runs);
      if (runs.length > 0) items.push({ runs, checked: null, lists: [] });
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name)) continue;
    if (LISTS.has(name)) {
      const nested = listOf(child, name === 'ol', marks, reading);
      if (nested === null) continue;
      const previous = items[items.length - 1];
      if (previous !== undefined) previous.lists.push(nested);
      else items.push({ runs: [], checked: null, lists: [nested] });
      continue;
    }
    items.push(itemOf(child, ordered, marks, reading));
  }
  const holds = (item: Item): boolean => item.runs.length > 0 || item.checked !== null || item.lists.length > 0;
  const kept = ordered ? items.slice() : items.filter(holds);
  while (kept.length > 0 && !holds(kept[kept.length - 1] as Item)) kept.pop();
  return kept.length > 0 ? { ordered, start: ordered ? startOf(node) : 1, items: kept } : null;
}

/** A code block's language: a `language-` or `lang-` class on the `pre` or on the `code` inside it. */
function languageOf(pre: HtmlNodeLike): string {
  const fromClass = (element: HtmlNodeLike): string => /(?:^|\s)lang(?:uage)?-([^\s`]+)/.exec(element.getAttribute?.('class') ?? '')?.[1] ?? '';
  const own = fromClass(pre);
  if (own !== '') return own;
  const code = childrenOf(pre).find((child) => child.nodeType === ELEMENT_NODE && nameOf(child) === 'code');
  return code === undefined ? '' : fromClass(code);
}

/** A code block of a `pre`'s text, its blank lines at either end left out; `null` for one with no code. */
function codeOf(node: HtmlNodeLike, reading: Reading): Block | null {
  const lines = textOf(node, reading).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  return lines.length > 0 ? { kind: 'code', language: languageOf(node), lines } : null;
}

/** An element's children that are elements of the names given and are read. */
function childElements(node: HtmlNodeLike, names: ReadonlySet<string>): HtmlNodeLike[] {
  return childrenOf(node).filter((child) => {
    if (child.nodeType !== ELEMENT_NODE) return false;
    const name = nameOf(child);
    return names.has(name) && !skipped(child, name);
  });
}

/**
 * A table's row groups in reading order, each its rows: its head, then its bodies and each run of rows written straight
 * in the table, then its foot. A cell spans rows within its group alone.
 */
function rowGroupsOf(table: HtmlNodeLike): HtmlNodeLike[][] {
  const head: HtmlNodeLike[][] = [];
  const body: HtmlNodeLike[][] = [];
  const foot: HtmlNodeLike[][] = [];
  let loose: HtmlNodeLike[] | null = null;
  for (const child of childrenOf(table)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name)) continue;
    if (name === 'tr') {
      if (loose === null) {
        loose = [];
        body.push(loose);
      }
      loose.push(child);
    } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      loose = null;
      (name === 'thead' ? head : name === 'tfoot' ? foot : body).push(childElements(child, ROW));
    }
  }
  return [...head, ...body, ...foot];
}

/** Whether an element holds, at any depth, something that marks its table as laid out for the page. */
function holdsLayout(node: HtmlNodeLike): boolean {
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name)) continue;
    if (LAYOUT.has(name) || holdsLayout(child)) return true;
  }
  return false;
}

/** A cell's `colspan` or `rowspan`: a whole number within HTML's bounds; a `rowspan` of 0 runs to the table's end. */
function spanOf(cell: HtmlNodeLike, attribute: 'colspan' | 'rowspan'): number {
  const value = Number.parseInt(cell.getAttribute?.(attribute) ?? '', 10);
  if (attribute === 'rowspan' && value === 0) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, attribute === 'colspan' ? 1_000 : 65_534);
}

/**
 * Reads a table into the flow. A table laid out for the page (marked `role="presentation"`, of one cell, or with a
 * cell that holds a heading, a table, a quote, code or a divider) is read as the blocks its cells hold. A table of
 * data is one table block: a cell spanning columns or rows keeps its words in its first place and leaves the others
 * empty; a row with no words is left out, and so are the columns after the last that holds one.
 */
function readTable(table: HtmlNodeLike, flow: Flow, marks: Marks, reading: Reading): void {
  const [caption] = childElements(table, CAPTION);
  if (caption !== undefined) {
    flow.flush();
    for (const child of childrenOf(caption)) readInto(child, flow, marks, reading);
    flow.flush();
  }
  const groups = rowGroupsOf(table).map((group) => group.map((row) => childElements(row, CELL)));
  const role = (table.getAttribute?.('role') ?? '').trim().toLowerCase();
  const all = groups.flat(2);
  if (role === 'presentation' || role === 'none' || all.length === 1 || all.some(holdsLayout)) {
    for (const cell of all) {
      flow.flush();
      for (const child of childrenOf(cell)) readInto(child, flow, marks, reading);
      flow.flush();
    }
    return;
  }

  const rows: MarkedRun[][][] = [];
  for (const group of groups) {
    // how many rows below each column's cell still covers, within the group
    const pending: number[] = [];
    for (const rowCells of group) {
      const occupied = pending.map((left) => left > 0);
      pending.forEach((left, column) => {
        if (left > 0) pending[column] = left - 1;
      });
      const row: MarkedRun[][] = [];
      let column = 0;
      for (const cell of rowCells) {
        while (occupied[column] === true) column += 1;
        const across = spanOf(cell, 'colspan');
        const down = spanOf(cell, 'rowspan');
        const runs = lineOf(cell, marks, reading);
        for (const run of runs) run.text = run.text.replace(/\|/g, '/');
        if (column >= reading.maxTableColumns) {
          if (runs.length > 0) reading.cut = true;
        } else {
          row[column] = runs;
        }
        for (let place = column; place < Math.min(column + across, reading.maxTableColumns); place += 1) {
          pending[place] = Math.max(pending[place] ?? 0, down - 1);
        }
        column += across;
      }
      if (!row.some((runs) => runs !== undefined && runs.length > 0)) continue;
      // a row past the bound is still read, so the images in it are counted as every image left out is
      if (rows.length >= reading.maxTableRows) {
        reading.cut = true;
        continue;
      }
      rows.push(row);
    }
  }

  let columns = 0;
  for (const row of rows) {
    row.forEach((runs, column) => {
      if (runs !== undefined && runs.length > 0) columns = Math.max(columns, column + 1);
    });
  }
  if (rows.length === 0 || columns === 0) return;
  flow.push({ kind: 'table', rows: rows.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? [])), columns });
}

/** Reads a node into the flow of blocks: an element by what it is, text into the paragraph being gathered. */
function readInto(node: HtmlNodeLike, flow: Flow, marks: Marks, reading: Reading, root = false): void {
  if (isText(node)) {
    flow.text(node.textContent ?? '', marks, false);
    return;
  }
  if (node.nodeType === DOCUMENT_NODE || node.nodeType === DOCUMENT_FRAGMENT_NODE) {
    for (const child of childrenOf(node)) readInto(child, flow, marks, reading);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const name = nameOf(node);
  // the element a caller hands over is read whatever it is; only what it holds can be left out
  if (!root && skipped(node, name)) return;
  const level = headingLevel(name);
  if (level > 0) {
    flow.push(headingOf(node, level, marks, reading));
    return;
  }
  if (LISTS.has(name)) {
    const list = listOf(node, name === 'ol', marks, reading);
    flow.push(list === null ? null : { kind: 'list', list });
    return;
  }
  if (name === 'blockquote') {
    const inner = new Flow();
    for (const child of childrenOf(node)) readInto(child, inner, marks, reading);
    inner.flush();
    // a quote whose only block is the h1 that named the page writes nothing, and is left out with it
    const writes = inner.blocks.some((block) => !(block.kind === 'heading' && block.omitted));
    flow.push(writes ? { kind: 'quote', blocks: inner.blocks } : null);
    return;
  }
  if (PREFORMATTED.has(name)) {
    flow.push(codeOf(node, reading));
    return;
  }
  if (name === 'hr') {
    flow.push({ kind: 'rule' });
    return;
  }
  if (name === 'table') {
    readTable(node, flow, marks, reading);
    return;
  }
  if (name === 'br') {
    flow.lineBreak();
    return;
  }
  if (name === 'img') {
    reading.images += 1;
    return;
  }
  if (CODE.has(name)) {
    flow.text(textOf(node, reading), marks, true);
    return;
  }
  if (CONTAINERS.has(name)) {
    flow.flush();
    for (const child of childrenOf(node)) readInto(child, flow, marks, reading);
    flow.flush();
    return;
  }
  const inside = marked(marks, name);
  for (const child of childrenOf(node)) readInto(child, flow, inside, reading);
}

/**
 * The characters of a node's text and CDATA descendants, in order, as a DOM's `textContent` gives an element's. The
 * reader reads `textContent` from text nodes alone, so a DOM whose elements answer `null` for it reads alike.
 */
function textWithin(node: HtmlNodeLike): string {
  let text = '';
  for (const child of childrenOf(node)) {
    if (isText(child)) text += child.textContent ?? '';
    else if (child.nodeType === ELEMENT_NODE) text += textWithin(child);
  }
  return text;
}

/** The first `title` element, outside a drawing, a formula and a template; `null` when there is none. */
function titleElement(node: HtmlNodeLike): HtmlNodeLike | null {
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (name === 'title') return child;
    if (name === 'svg' || name === 'math' || name === 'template') continue;
    const found = titleElement(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Adds lines to the end of a list of lines one at a time: a spread would pass every line as an argument, and a list or
 * a code block of many lines passes more than an engine's stack or argument cap takes.
 */
function append(lines: string[], more: readonly string[]): void {
  for (const line of more) lines.push(line);
}

/** A list's lines, its items' words escaped, the lists under each indented to the item's words. */
function writeList(list: List, indent: number): string[] {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);
  list.items.forEach((item, place) => {
    const marker = list.ordered ? `${list.start + place}. ` : item.checked === null ? '- ' : `- [${item.checked ? 'x' : ' '}] `;
    const words = escapeStart(writeInline(item.runs), true);
    // the marker and the words together could read as a divider ('- --'): the words' first character is escaped
    const head = words !== '' && DIVIDER.test(`${marker}${words}`) ? `\\${words}` : words;
    lines.push(head === '' ? `${pad}${marker.trimEnd()}` : `${pad}${marker}${head}`);
    for (const nested of item.lists) append(lines, writeList(nested, indent + (list.ordered ? marker.length : 2)));
  });
  return lines;
}

/** A paragraph's line as written: its words, a backslash before a character that would start a block. */
function paragraphLine(runs: readonly MarkedRun[]): string {
  return runs.length === 0 ? '' : escapeStart(writeInline(runs), false);
}

/** The blocks' lines, one empty line between two blocks; a heading that gave the title its words is left out. */
function writeBlocks(blocks: readonly Block[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const written = writeBlock(block);
    if (written.length === 0) continue;
    if (lines.length > 0) lines.push('');
    append(lines, written);
  }
  return lines;
}

/** One block's lines. */
function writeBlock(block: Block): string[] {
  switch (block.kind) {
    case 'paragraph':
      return block.lines.map(paragraphLine);
    case 'heading':
      return block.omitted ? [] : [writeHeading(block.level, writeInline(block.runs))];
    case 'list':
      return writeList(block.list, 0);
    case 'quote':
      return writeBlocks(block.blocks).map((line) => (line === '' ? '>' : `> ${line}`));
    case 'code':
      return writeCodeBlock(block.lines, block.language);
    case 'rule':
      return ['---'];
    default:
      return writeTable(
        block.rows.map((row) => row.map((runs) => writeInline(runs))),
        block.columns,
      );
  }
}

/** The fewest characters a list's lines can take: its items' words, which escapes and markers only add to. */
function listFloor(list: List): number {
  return list.items.reduce((sum, item) => sum + plainOf(item.runs).length + item.lists.reduce((under, inner) => under + listFloor(inner), 0), 0);
}

/** The fewest characters a block's lines can take: its words, which escapes, marks and markers only add to. */
function floorOf(block: Block): number {
  switch (block.kind) {
    case 'paragraph':
      return block.lines.reduce((sum, line) => sum + plainOf(line).length, 0) + block.lines.length - 1;
    case 'heading':
      return block.omitted ? 0 : block.words.length;
    case 'list':
      return listFloor(block.list);
    case 'quote':
      return block.blocks.reduce((sum, inner) => sum + floorOf(inner), 0);
    case 'code':
      return block.lines.reduce((sum, line) => sum + line.length, 0);
    case 'rule':
      return 3;
    default:
      return block.rows.reduce((sum, row) => sum + row.reduce((cells, runs) => cells + plainOf(runs).length, 0), 0);
  }
}

/**
 * A line's length as written inside so many quotes: an empty line is the quotes' marks alone (`>`, `> >`), any other
 * line their marks and a space each (`> > words`).
 */
function lineCost(line: string, depth: number): number {
  if (depth === 0) return line.length;
  return line === '' ? 2 * depth - 1 : line.length + 2 * depth;
}

/** Lines' length as written inside so many quotes, one line feed between two. */
function linesCost(lines: readonly string[], depth: number): number {
  return lines.reduce((sum, line) => sum + lineCost(line, depth), 0) + Math.max(0, lines.length - 1);
}

/**
 * The lines that fit in so many characters, written inside so many quotes, one line feed between two; `''` when fewer
 * than `least` fit.
 */
function linesPart(lines: readonly string[], room: number, least: number, depth: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const gap = kept.length > 0 ? 1 : 0;
    const cost = lineCost(line, depth);
    if (used + gap + cost > room) break;
    kept.push(line);
    used += gap + cost;
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.length >= least ? kept.join('\n') : '';
}

/**
 * A line's words up to the last space between words at which the written line fits; `''` when no such space fits. A
 * written line is never shorter than its words, so only the spaces within `room` are tried, and a long line is never
 * written whole.
 */
function wordsThatFit(runs: readonly MarkedRun[], room: number): string {
  const places: number[] = [];
  let offset = 0;
  for (const run of runs) {
    if (offset > room) break;
    if (!run.code) {
      for (let at = run.text.indexOf(' '); at >= 0 && offset + at <= room; at = run.text.indexOf(' ', at + 1)) places.push(offset + at);
    }
    offset += run.text.length;
  }
  const before = (end: number): MarkedRun[] => {
    const kept: MarkedRun[] = [];
    let start = 0;
    for (const run of runs) {
      if (start >= end) break;
      kept.push({ ...run, text: run.text.slice(0, end - start) });
      start += run.text.length;
    }
    trimEnd(kept);
    return kept;
  };
  let best = '';
  let low = 0;
  let high = places.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const written = paragraphLine(before(places[middle] ?? 0));
    if (written !== '' && written.length <= room) {
      best = written;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * What of a paragraph's lines fits, written inside so many quotes: the whole lines that fit, then the next one's words
 * up to a space.
 */
function paragraphPart(lines: readonly MarkedRun[][], room: number, depth: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const runs of lines) {
    const gap = kept.length > 0 ? 1 : 0;
    const left = room - used - gap;
    if (left < 0) break;
    if (lineCost(plainOf(runs), depth) <= left) {
      const line = paragraphLine(runs);
      const cost = lineCost(line, depth);
      if (cost <= left) {
        kept.push(line);
        used += gap + cost;
        continue;
      }
    }
    // a line with words carries a quote mark and a space for each quote around it
    const words = runs.length > 0 ? wordsThatFit(runs, left - 2 * depth) : '';
    if (words !== '') kept.push(words);
    break;
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

/**
 * What of a code block's lines fits, written inside so many quotes: its fence, the code lines that fit, and its closing
 * fence; `''` for no code line.
 */
function codePart(lines: readonly string[], room: number, depth: number): string {
  const open = lines[0] ?? '';
  const close = lines[lines.length - 1] ?? '';
  let used = lineCost(open, depth) + 1 + lineCost(close, depth);
  const kept = [open];
  for (const line of lines.slice(1, -1)) {
    const cost = lineCost(line, depth) + 1;
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  return kept.length > 1 ? [...kept, close].join('\n') : '';
}

/** Lines written inside a quote. */
function quoted(lines: readonly string[]): string[] {
  return lines.map((line) => (line === '' ? '>' : `> ${line}`));
}

/**
 * What of a quote's blocks fits, the quote written inside so many quotes, each block cut by its own rule: the whole
 * blocks that fit, then the most of the next one, so a table inside keeps its header and separator together and a code
 * block its closing fence. Its blocks' lines are counted one quote deeper, so a quote inside it is cut in the same pass,
 * whatever its depth.
 */
function quotePart(blocks: readonly Block[], room: number, depth: number): string {
  const inside = depth + 1;
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (block.kind === 'heading' && block.omitted) continue;
    // an empty quote line stands between two blocks, with a line feed each side
    const gap = kept.length > 0 ? lineCost('', inside) + 2 : 0;
    const left = room - used - gap;
    if (left <= 0) break;
    if (floorOf(block) <= left) {
      const whole = writeBlock(block);
      const cost = linesCost(whole, inside);
      if (cost <= left) {
        if (gap > 0) kept.push('');
        append(kept, whole);
        used += gap + cost;
        continue;
      }
    }
    const part = partOf(block, left, inside);
    if (part !== '') {
      if (gap > 0) kept.push('');
      append(kept, part.split('\n'));
    }
    break;
  }
  return quoted(kept).join('\n');
}

/**
 * What of a block fits in so many characters, written inside so many quotes, cut by the block's own rule, as the
 * block's own lines joined; `''` when nothing fits.
 */
function partOf(block: Block, room: number, depth: number): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraphPart(block.lines, room, depth);
    case 'code':
      return codePart(writeBlock(block), room, depth);
    case 'table':
      return linesPart(writeBlock(block), room, 2, depth);
    case 'list':
      return linesPart(writeBlock(block), room, 1, depth);
    case 'quote':
      return quotePart(block.blocks, room, depth);
    default:
      return '';
  }
}

/**
 * The blocks written within so many characters, cut as `ReadHtmlOptions.maxCharacters` says, and whether any was cut. A
 * block whose words alone pass the room is cut without being written whole.
 */
function writeWithin(blocks: readonly Block[], maxCharacters: number): { markdown: string; cut: boolean } {
  const parts: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (block.kind === 'heading' && block.omitted) continue;
    const gap = parts.length > 0 ? 2 : 0;
    const room = maxCharacters - used - gap;
    if (floorOf(block) <= room) {
      const text = writeBlock(block).join('\n');
      if (text.length <= room) {
        parts.push(text);
        used += gap + text.length;
        continue;
      }
    }
    const part = room > 0 ? partOf(block, room, 0) : '';
    if (part !== '') parts.push(part);
    return { markdown: parts.join('\n\n'), cut: true };
  }
  return { markdown: parts.join('\n\n'), cut: false };
}

/**
 * Reads a parsed HTML page into its title and its body as Markdown. The body leaves out the head, scripts, styles,
 * templates, `noscript`, the page's `nav`, `header`, `footer` and `aside`, frames, forms and their controls, embedded
 * media, drawings in SVG and formulas in MathML, and any element marked `hidden`, `aria-hidden="true"` or styled
 * `display: none`. Comments are not read. An element handed over is read as a document is, whatever its own name.
 *
 * @param document - A parsed document, or an element, as a page's `DOMParser` gives it; nothing is fetched.
 * @param options - The bounds on the Markdown and on each table.
 * @throws RangeError for a bound below 0, `NaN` or no number at all (`null`, a numeric text, `true`).
 */
export function readHtml(document: HtmlDocumentLike, options?: ReadHtmlOptions): HtmlRead {
  const given = options ?? {};
  const maxCharacters = boundOf('readHtml', 'maxCharacters', given.maxCharacters, Number.POSITIVE_INFINITY);
  const element = titleElement(document);
  const named = element === null ? '' : textWithin(element).replace(WHITE, ' ').trim();
  const reading: Reading = {
    images: 0,
    cut: false,
    named: named === '' ? null : named,
    firstH1: undefined,
    maxTableRows: boundOf('readHtml', 'maxTableRows', given.maxTableRows, 500, true),
    maxTableColumns: boundOf('readHtml', 'maxTableColumns', given.maxTableColumns, 30, true),
  };
  const flow = new Flow();
  readInto(document, flow, PLAIN, reading, true);
  flow.flush();
  const written = writeWithin(flow.blocks, maxCharacters);
  return {
    title: reading.named ?? reading.firstH1 ?? null,
    markdown: written.markdown,
    images: reading.images,
    cut: written.cut || reading.cut,
  };
}
