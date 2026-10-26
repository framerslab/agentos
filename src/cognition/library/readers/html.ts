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
  /**
   * The most rows a table keeps, its header row among them, and the most rows of cells a table laid out for the page
   * keeps; a row that writes nothing is not counted. Bounded as `maxCharacters` is.
   * @default 500
   */
  maxTableRows?: number;
  /** The most columns a table keeps, a table laid out for the page among them. Bounded as `maxCharacters` is. @default 30 */
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
  /**
   * The page's own header, footer and asides, which no article or section holds but one that wraps the page, left out
   * with all they hold.
   */
  readonly pageOwn: ReadonlySet<HtmlNodeLike>;
  /** The forms that hold a page, read as the blocks they hold; any other form is left out with all it holds. */
  readonly forms: ReadonlySet<HtmlNodeLike>;
}

/** No marks. */
const PLAIN: Marks = { bold: false, italic: false, strike: false };

/** HTML's white space, with the no-break space a page writes as `&nbsp;`, which a run of words collapses to one space. */
const WHITE = /[\t\n\f\r \u00a0]+/g;

/**
 * The elements never read, with all they hold: the head and its title, scripts, styles, templates, navigation, a search
 * (https://html.spec.whatwg.org/multipage/grouping-content.html#the-search-element), whose controls and words serve the
 * search, frames, the controls of a form that hold words of their own (a button, a select with its options, a textarea)
 * and a datalist with its choices, which HTML renders as nothing, embedded media and drawings, and the annotations of
 * ruby text. The one button a heading's words all sit in is read for them, as `soleButton` finds it. A form is read as
 * the blocks it holds when it holds a page, as `PAGE_PARTS` marks one, and left out with all it holds otherwise.
 */
const DROPPED = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'search',
  'iframe',
  'frame',
  'frameset',
  'button',
  'select',
  'textarea',
  'datalist',
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

/**
 * The elements HTML scopes to the article or section that holds them
 * (https://html.spec.whatwg.org/multipage/dom.html#sectioning-content): one that no article or section holds is the
 * page's own header, footer or aside, left out with all it holds; one inside an article or a section is that part's,
 * read with it, as a header there usually holds the part's heading.
 */
const SCOPED = new Set(['header', 'footer', 'aside']);

/**
 * The elements that hold their own header, footer and asides, which are read with them, but a section that holds the
 * page's main content: that one wraps the page, as a `div` would, and the header, footer and asides it holds are the
 * page's. An article is a composition of its own, so one that holds the main element still holds its own.
 */
const SECTIONS = new Set(['article', 'section']);

/**
 * What marks a form as holding a page rather than a set of controls, with the page's main content: a heading, HTML's
 * sectioning content (https://html.spec.whatwg.org/multipage/dom.html#sectioning-content), a header or a footer, and a
 * table's header cell (https://html.spec.whatwg.org/multipage/tables.html#the-th-element), which a table of data holds,
 * as the list of a category's articles Joomla writes in a form does. A page whose whole body sits in one form, as an
 * ASP.NET Web Forms page's does, usually holds one, and `noteParts` takes the body's one form as a page whatever it
 * holds; a blog post's comment form or a search box, a set of notes, labels and controls beside the page, holds none,
 * and neither does a form laid out in a table of plain cells, as a hotel search is.
 */
const PAGE_PARTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'aside', 'nav', 'section', 'header', 'footer', 'th']);

/**
 * The elements that hold blocks or stand as one: each starts a paragraph of its own. A header, footer or aside is one
 * when it is read; so is a form that holds a page, and so is an open dialog, which HTML draws as a block
 * (https://html.spec.whatwg.org/multipage/rendering.html#flow-content-3).
 */
const CONTAINERS = new Set([
  'html',
  'body',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'aside',
  'form',
  'dialog',
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

/**
 * Every element that stands as a block, read or left out: its edges end the paragraph being gathered, and are a space
 * inside a line and a line break in code, so the words on either side of it stay apart.
 */
const BLOCK_LEVEL = new Set([
  ...CONTAINERS,
  ...LISTS,
  ...PREFORMATTED,
  'blockquote',
  'table',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'nav',
  'search',
]);

/**
 * The elements a page draws in a line as a box, whose words are not read: HTML's embedded content
 * (https://html.spec.whatwg.org/multipage/dom.html#embedded-content-2), images, frames, media, drawings and formulas
 * among it, and a form's controls (https://html.spec.whatwg.org/multipage/rendering.html#widgets). Each, read or left
 * out, is a space between the words on either side of it, as a block's edges are, so
 * `<label>Name</label><input><label>Email</label>` reads `Name Email`. An input of type hidden and an audio element with
 * no controls, which a page draws as nothing, are a space as well, as a hidden block's edges are. Code keeps its
 * characters as written, with nothing added for one.
 */
const BOXES = new Set([
  'audio',
  'canvas',
  'embed',
  'iframe',
  'img',
  'math',
  'object',
  'svg',
  'video',
  'button',
  'input',
  'select',
  'textarea',
]);

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

/**
 * Whether an element is hidden: by `hidden`, by `aria-hidden="true"`, by an inline style of `display: none`, or as a
 * dialog that is not open, which HTML does not draw (https://html.spec.whatwg.org/multipage/rendering.html#flow-content-3).
 */
function hidden(node: HtmlNodeLike): boolean {
  if (node.hasAttribute?.('hidden') === true) return true;
  if (node.hasAttribute?.('open') === false && nameOf(node) === 'dialog') return true;
  if ((node.getAttribute?.('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
  return /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i.test(node.getAttribute?.('style') ?? '');
}

/**
 * Whether an element and all it holds are left unread: by its name, as the page's own header, footer or aside, as a
 * form that holds no page, or hidden.
 */
function skipped(node: HtmlNodeLike, name: string, reading: Reading): boolean {
  return DROPPED.has(name) || reading.pageOwn.has(node) || (name === 'form' && !reading.forms.has(node)) || hidden(node);
}

/**
 * Whether an element holds the page's main content itself: a `main` element, or one whose role is `main`, the first
 * word of its `role` as WAI-ARIA reads a role's (https://www.w3.org/TR/wai-aria-1.2/#host_general_role).
 */
function isMain(node: HtmlNodeLike, name: string): boolean {
  if (name === 'main') return true;
  const [role = ''] = (node.getAttribute?.('role') ?? '').trim().toLowerCase().split(/[\t\n\f\r ]+/);
  return role === 'main';
}

/** What `noteParts` answers a part of a page holds, as bits: the page's main content, and anything that marks a page. */
const HOLDS_MAIN = 1;
const HOLDS_PAGE = 2;

/** The forms that hold a page, and the sections that hold the page's main content and so wrap the page. */
interface Parts {
  readonly forms: Set<HtmlNodeLike>;
  readonly wrappers: Set<HtmlNodeLike>;
}

/**
 * Notes, in one walk of what a node holds, the forms that hold a page and the sections that hold the page's main content,
 * and answers what the node holds as `HOLDS_MAIN` and `HOLDS_PAGE` bits. A form holds a page when it holds the page's
 * main content or an element of `PAGE_PARTS`, a `nav` among them, though a nav is never read; when it is the page's main
 * content itself, its role `main`; or when it is the one element the body holds that is read, with no words of the
 * body's own beside it, as an ASP.NET Web Forms page's form is, headings or none. A hidden element marks nothing, and
 * neither does anything inside it or inside an element left out by its name.
 */
function noteParts(node: HtmlNodeLike, parts: Parts): number {
  let holds = 0;
  // the elements the node holds that are read, and whether it holds words of its own beside them, for the body's one form
  const read: HtmlNodeLike[] = [];
  let words = false;
  for (const child of childrenOf(node)) {
    if (isText(child)) {
      if ((child.textContent ?? '').replace(WHITE, '') !== '') words = true;
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE || hidden(child)) continue;
    const name = nameOf(child);
    if (DROPPED.has(name)) {
      if (PAGE_PARTS.has(name)) holds |= HOLDS_PAGE;
      continue;
    }
    read.push(child);
    const main = isMain(child, name);
    if (main) holds |= HOLDS_MAIN | HOLDS_PAGE;
    else if (PAGE_PARTS.has(name)) holds |= HOLDS_PAGE;
    const inner = noteParts(child, parts);
    if (name === 'form' && (main || (inner & HOLDS_PAGE) !== 0)) parts.forms.add(child);
    if (name === 'section' && (inner & HOLDS_MAIN) !== 0) parts.wrappers.add(child);
    holds |= inner;
  }
  const [only] = read;
  const body = node.nodeType === ELEMENT_NODE && nameOf(node) === 'body';
  if (body && !words && read.length === 1 && only !== undefined && nameOf(only) === 'form') parts.forms.add(only);
  return holds;
}

/**
 * What introduces the content a header heads: its headings and paragraphs. HTML's header holds "a group of introductory
 * or navigational aids" (https://html.spec.whatwg.org/multipage/sections.html#the-header-element), usually a heading
 * or an `hgroup`, and may hold a table of contents, a search form or a logo beside them.
 */
const INTRODUCTION = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'p']);

/**
 * Whether a node holds an `h1`, the title of the content a header inside the page's main content introduces. The parts
 * never read, by their name or as hidden, are not looked in.
 */
function holdsH1(node: HtmlNodeLike): boolean {
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (DROPPED.has(name) || hidden(child)) continue;
    if (name === 'h1' || holdsH1(child)) return true;
  }
  return false;
}

/**
 * Whether a part of a header holds an element of `INTRODUCTION`, with the elements under it that hold none: the
 * header's navigational aids, each to be left out with all it holds. The words a part holds beside its elements are
 * read with it. The parts never read, by their name or as hidden, are not looked in.
 */
function introductionOf(node: HtmlNodeLike): { holds: boolean; aids: HtmlNodeLike[] } {
  let holds = false;
  const aids: HtmlNodeLike[] = [];
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (DROPPED.has(name) || hidden(child)) continue;
    if (INTRODUCTION.has(name)) {
      holds = true;
      continue;
    }
    const inner = introductionOf(child);
    if (inner.holds) {
      holds = true;
      for (const aid of inner.aids) aids.push(aid);
    } else {
      // a part that holds no introduction is an aid, left out whole with what its own walk found
      aids.push(child);
    }
  }
  return { holds, aids };
}

/**
 * The page's own header, footer and asides: those that no article or section holds, between them and the node handed
 * over, but one that wraps the page. A section that holds the page's main content wraps the page, as the Read the Docs
 * theme's section around its content column and footer does, so it holds no header, footer or aside of its own; an
 * article, and any other section, holds its own, and so does the node handed over when it is one. A header inside the
 * page's main content, a `main` element or one whose role is `main`, that holds an `h1` introduces that content, as the
 * title of an archive or of a search page does: its headings and paragraphs are read, and the rest of it, its
 * navigational aids, is the page's own, as the menu of other languages Wikipedia's title bar holds beside an article's
 * title is. A header there that holds no `h1` is the page's own whole, as a GitHub repository page's bar of tabs and its
 * title bar are. A footer or an aside there is still the page's. The walk stops at an article or a section that holds
 * its own and at an element left out with all it holds, since nothing inside either is the page's own or is read.
 *
 * @param wrappers - The sections that hold the page's main content, as `noteParts` notes them.
 */
function pageOwnOf(root: HtmlNodeLike, wrappers: ReadonlySet<HtmlNodeLike>): Set<HtmlNodeLike> {
  const found = new Set<HtmlNodeLike>();
  const holdsOwn = (node: HtmlNodeLike, name: string): boolean => SECTIONS.has(name) && !wrappers.has(node);
  const isElement = root.nodeType === ELEMENT_NODE;
  const rootName = isElement ? nameOf(root) : '';
  const holders: Array<{ node: HtmlNodeLike; inMain: boolean }> =
    isElement && holdsOwn(root, rootName) ? [] : [{ node: root, inMain: isElement && isMain(root, rootName) }];
  for (let holder = holders.pop(); holder !== undefined; holder = holders.pop()) {
    for (const child of childrenOf(holder.node)) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      const name = nameOf(child);
      if (holdsOwn(child, name) || DROPPED.has(name) || hidden(child)) continue;
      if (name === 'header' && holder.inMain) {
        // a header inside the page's main content that holds its title introduces it: what introduces it is read, and
        // its aids are the page's; one that holds no h1 is the page's whole
        if (holdsH1(child)) for (const aid of introductionOf(child).aids) found.add(aid);
        else found.add(child);
        continue;
      }
      if (SCOPED.has(name)) found.add(child);
      else holders.push({ node: child, inMain: holder.inMain || isMain(child, name) });
    }
  }
  return found;
}

/**
 * The one button a heading's words all sit in, as the header of an accordion holds its title
 * (https://www.w3.org/WAI/ARIA/apg/patterns/accordion/), read for the heading's words; `null` when the heading has words
 * outside its buttons, or holds no button or more than one. A hidden button is not counted, and the parts of the heading
 * left out with all they hold are not looked in.
 */
function soleButton(heading: HtmlNodeLike, reading: Reading): HtmlNodeLike | null {
  const buttons: HtmlNodeLike[] = [];
  const holders = [heading];
  for (let holder = holders.pop(); holder !== undefined; holder = holders.pop()) {
    for (const child of childrenOf(holder)) {
      if (isText(child)) {
        if ((child.textContent ?? '').replace(WHITE, '') !== '') return null;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const name = nameOf(child);
      if (name === 'button' && !hidden(child)) buttons.push(child);
      else if (!skipped(child, name, reading)) holders.push(child);
    }
  }
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
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
 * highlighter that writes a line to a `div` shows it), a block left out among them, images counted, the parts of a page
 * that are not read left out.
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
    const block = BLOCK_LEVEL.has(name);
    if (skipped(child, name, reading)) {
      // a block left out still parts the lines on either side of it
      if (block && text !== '' && !text.endsWith('\n')) text += '\n';
      continue;
    }
    if (name === 'img') {
      reading.images += 1;
      continue;
    }
    if (name === 'br') {
      text += '\n';
      continue;
    }
    if (block && text !== '' && !text.endsWith('\n')) text += '\n';
    text += textOf(child, reading);
    if (block && text !== '' && !text.endsWith('\n')) text += '\n';
  }
  return text;
}

/**
 * What a line's reader does with a list inside it, given the marks of the elements around the list, and with a
 * checkbox before its words.
 */
interface LineHooks {
  list?: (element: HtmlNodeLike, ordered: boolean, marks: Marks) => void;
  checkbox?: (element: HtmlNodeLike, first: boolean) => void;
}

/**
 * An element's content read as one line of words: a line break, a box of `BOXES`, and a block's edges, those of a code
 * block, of a list handed to `hooks.list`, of a block left out and of a first `h1` whose words gave the title among
 * them, as one space; code as inline code; images counted. A list inside it goes to `hooks.list` where given, with the
 * marks of the elements around it, and is read into the line otherwise. The one button a heading's words all sit in, the
 * element's own when it is a heading, is read for them.
 */
function lineOf(node: HtmlNodeLike, marks: Marks, reading: Reading, hooks: LineHooks = {}): MarkedRun[] {
  const line: MarkedRun[] = [];
  const buttons = new Set<HtmlNodeLike>();
  const noteButton = (heading: HtmlNodeLike): void => {
    const button = soleButton(heading, reading);
    if (button !== null) buttons.add(button);
  };
  if (node.nodeType === ELEMENT_NODE && headingLevel(nameOf(node)) > 0) noteButton(node);
  const visit = (current: HtmlNodeLike, at: Marks): void => {
    if (isText(current)) {
      addWords(line, current.textContent ?? '', at, false);
      return;
    }
    if (current.nodeType !== ELEMENT_NODE) return;
    const name = nameOf(current);
    if (buttons.has(current)) {
      // a heading's button read for the heading's words is still a box, a space between the words on either side of it
      addWords(line, ' ', at, false);
      for (const child of childrenOf(current)) visit(child, at);
      addWords(line, ' ', at, false);
      return;
    }
    if (skipped(current, name, reading)) {
      // a block or a box left out still keeps the words on either side of it a space apart
      if (BLOCK_LEVEL.has(name) || BOXES.has(name)) addWords(line, ' ', at, false);
      return;
    }
    if (name === 'img') {
      reading.images += 1;
      addWords(line, ' ', at, false);
      return;
    }
    if (name === 'br') {
      addWords(line, ' ', at, false);
      return;
    }
    if (name === 'input') {
      hooks.checkbox?.(current, line.length === 0);
      addWords(line, ' ', at, false);
      return;
    }
    if (hooks.list !== undefined && LISTS.has(name)) {
      // the list leaves the line, and its edges are a block's: the words on either side of it stay a space apart
      addWords(line, ' ', at, false);
      hooks.list(current, name === 'ol', at);
      addWords(line, ' ', at, false);
      return;
    }
    if (CODE.has(name) || PREFORMATTED.has(name)) {
      const block = PREFORMATTED.has(name);
      if (block) addWords(line, ' ', at, false);
      addWords(line, textOf(current, reading), at, true);
      if (block) addWords(line, ' ', at, false);
      return;
    }
    if (headingLevel(name) === 1 && reading.firstH1 === undefined) {
      // the page's first h1 read into a line, as a list item's words: noted for the title, and left out with its words
      // when it gives the title; its edges are a block's either way, so the words on either side of it stay apart
      const runs = lineOf(current, at, reading);
      addWords(line, ' ', at, false);
      if (!firstH1Leaves(plainOf(runs), reading)) for (const run of runs) addWords(line, run.text, run, run.code);
      addWords(line, ' ', at, false);
      return;
    }
    if (headingLevel(name) > 0) noteButton(current);
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

/** The highest number a numbered item can take: CommonMark reads a number of nine digits at most as an item's. */
const LAST_NUMBER = 999_999_999;

/**
 * A list's start: its `start` attribute when that number and its last item's are numbers a line can write, nine digits
 * at most, else 1.
 *
 * @param items - How many items the list writes, each numbered one after the one before it.
 */
function startOf(node: HtmlNodeLike, items: number): number {
  const start = Number.parseInt(node.getAttribute?.('start') ?? '', 10);
  return Number.isInteger(start) && start >= 0 && start + items - 1 <= LAST_NUMBER ? start : 1;
}

/** A list item: its words read as one line, a checkbox before them read as its state, the lists inside it under it. */
function itemOf(node: HtmlNodeLike, ordered: boolean, marks: Marks, reading: Reading): Item {
  const lists: List[] = [];
  const box: { checked: boolean | null } = { checked: null };
  const runs = lineOf(node, marks, reading, {
    // a list inside the item's bold or italic words keeps the mark on its items
    list: (element, isOrdered, around) => {
      const list = listOf(element, isOrdered, around, reading);
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
    if (skipped(child, name, reading)) continue;
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
  return kept.length > 0 ? { ordered, start: ordered ? startOf(node, kept.length) : 1, items: kept } : null;
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
function childElements(node: HtmlNodeLike, names: ReadonlySet<string>, reading: Reading): HtmlNodeLike[] {
  return childrenOf(node).filter((child) => {
    if (child.nodeType !== ELEMENT_NODE) return false;
    const name = nameOf(child);
    return names.has(name) && !skipped(child, name, reading);
  });
}

/**
 * A table's row groups in reading order, each its rows: its head, then its bodies and each run of rows written straight
 * in the table, then its foot. A cell spans rows within its group alone.
 */
function rowGroupsOf(table: HtmlNodeLike, reading: Reading): HtmlNodeLike[][] {
  const head: HtmlNodeLike[][] = [];
  const body: HtmlNodeLike[][] = [];
  const foot: HtmlNodeLike[][] = [];
  let loose: HtmlNodeLike[] | null = null;
  for (const child of childrenOf(table)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name, reading)) continue;
    if (name === 'tr') {
      if (loose === null) {
        loose = [];
        body.push(loose);
      }
      loose.push(child);
    } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      loose = null;
      (name === 'thead' ? head : name === 'tfoot' ? foot : body).push(childElements(child, ROW, reading));
    }
  }
  return [...head, ...body, ...foot];
}

/** Whether an element holds, at any depth, something that marks its table as laid out for the page. */
function holdsLayout(node: HtmlNodeLike, reading: Reading): boolean {
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const name = nameOf(child);
    if (skipped(child, name, reading)) continue;
    if (LAYOUT.has(name) || holdsLayout(child, reading)) return true;
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

/** A table's cell and the column it starts in. */
interface PlacedCell {
  readonly cell: HtmlNodeLike;
  readonly column: number;
}

/**
 * A table's rows in reading order, each its cells with the column each starts in: a cell spanning columns covers the
 * places after its own in its row, and a cell spanning rows its places in the rows below it within its group. Places
 * from `columns` on are not tracked, since a cell that starts at one is left out whichever it is.
 *
 * @param groups - The table's row groups, each its rows, each its cells.
 * @param columns - The most columns the table keeps.
 */
function placedRows(groups: readonly (readonly (readonly HtmlNodeLike[])[])[], columns: number): PlacedCell[][] {
  const placed: PlacedCell[][] = [];
  for (const group of groups) {
    // how many rows below each column's cell still covers, within the group
    const pending: number[] = [];
    for (const cells of group) {
      const occupied = pending.map((left) => left > 0);
      pending.forEach((left, column) => {
        if (left > 0) pending[column] = left - 1;
      });
      const row: PlacedCell[] = [];
      let column = 0;
      for (const cell of cells) {
        while (occupied[column] === true) column += 1;
        const across = spanOf(cell, 'colspan');
        const down = spanOf(cell, 'rowspan');
        row.push({ cell, column });
        for (let place = column; place < Math.min(column + across, columns); place += 1) {
          pending[place] = Math.max(pending[place] ?? 0, down - 1);
        }
        column += across;
      }
      placed.push(row);
    }
  }
  return placed;
}

/** Whether blocks from a place on write anything: every block does but the `h1` that gave the title its words. */
function writes(blocks: readonly Block[], from = 0): boolean {
  for (let at = from; at < blocks.length; at += 1) {
    const block = blocks[at];
    if (block !== undefined && !(block.kind === 'heading' && block.omitted)) return true;
  }
  return false;
}

/** Reads what an element holds into a flow as blocks of their own, apart from the words around the element. */
function readApart(node: HtmlNodeLike, flow: Flow, marks: Marks, reading: Reading): void {
  flow.flush();
  for (const child of childrenOf(node)) readInto(child, flow, marks, reading);
  flow.flush();
}

/**
 * Reads a table into the flow, its caption first, the paragraph before it ended whatever the table holds. A table laid
 * out for the page (marked `role="presentation"` or `role="none"`, of one cell, or with a cell that holds a heading, a
 * table, a quote, code or a divider) is read as the blocks its cells hold. A table of data is one table block: a cell
 * spanning columns or rows keeps its words in its first place and leaves the others empty; a row with no words is left
 * out, and so are the columns after the last that holds one. Either kind keeps `maxTableRows` rows, a row that writes
 * nothing not counted, and the cells that start within `maxTableColumns` columns; a row or a cell past a bound is still
 * read, so the images in it are counted as every image left out is, and sets `cut` when it holds anything to write.
 */
function readTable(table: HtmlNodeLike, flow: Flow, marks: Marks, reading: Reading): void {
  // the words before a table end at its edge, whatever it holds, a table that writes nothing among them
  flow.flush();
  const [caption] = childElements(table, CAPTION, reading);
  if (caption !== undefined) readApart(caption, flow, marks, reading);
  const groups = rowGroupsOf(table, reading).map((group) => group.map((row) => childElements(row, CELL, reading)));
  const role = (table.getAttribute?.('role') ?? '').trim().toLowerCase();
  const all = groups.flat(2);
  const placed = placedRows(groups, reading.maxTableColumns);
  if (role === 'presentation' || role === 'none' || all.length === 1 || all.some((cell) => holdsLayout(cell, reading))) {
    let kept = 0;
    for (const row of placed) {
      const within = kept < reading.maxTableRows;
      const from = flow.blocks.length;
      const left = new Flow();
      for (const { cell, column } of row) readApart(cell, within && column < reading.maxTableColumns ? flow : left, marks, reading);
      if (within && writes(flow.blocks, from)) kept += 1;
      if (writes(left.blocks)) reading.cut = true;
    }
    return;
  }

  const rows: MarkedRun[][][] = [];
  for (const cells of placed) {
    const row: MarkedRun[][] = [];
    for (const { cell, column } of cells) {
      const runs = lineOf(cell, marks, reading);
      for (const run of runs) run.text = run.text.replace(/\|/g, '/');
      if (column >= reading.maxTableColumns) {
        if (runs.length > 0) reading.cut = true;
      } else {
        row[column] = runs;
      }
    }
    if (!row.some((runs) => runs !== undefined && runs.length > 0)) continue;
    // a row past the bound is still read, so the images in it are counted as every image left out is
    if (rows.length >= reading.maxTableRows) {
      reading.cut = true;
      continue;
    }
    rows.push(row);
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

/**
 * Reads a node into the flow of blocks: an element by what it is, text into the paragraph being gathered, which a block
 * left out ends as a block read does, and in which a box of `BOXES`, read or left out, is a space.
 */
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
  if (!root && skipped(node, name, reading)) {
    if (BLOCK_LEVEL.has(name)) flow.flush();
    else if (BOXES.has(name)) flow.text(' ', marks, false);
    return;
  }
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
    flow.push(writes(inner.blocks) ? { kind: 'quote', blocks: inner.blocks } : null);
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
    flow.text(' ', marks, false);
    return;
  }
  if (name === 'input') {
    flow.text(' ', marks, false);
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

/** The elements whose `title` is their own, never the page's: a drawing, a formula and a template. */
const OWN_TITLE = new Set(['svg', 'math', 'template']);

/**
 * The first `title` element outside a drawing, a formula and a template, the node handed over held to the same rule as
 * what it holds; `null` when there is none.
 */
function titleElement(node: HtmlNodeLike): HtmlNodeLike | null {
  if (node.nodeType === ELEMENT_NODE && OWN_TITLE.has(nameOf(node))) return null;
  for (const child of childrenOf(node)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (nameOf(child) === 'title') return child;
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
 * templates, `noscript`, `nav`, `search`, the page's own `header`, `footer` and `aside`, frames, a `form` that holds no
 * page, the controls of a form that hold words of their own (`button`, `select`, `textarea`) and a `datalist` with its
 * choices, embedded media, drawings in SVG and formulas in MathML, a `dialog` that is not open, and any element marked
 * `hidden`, `aria-hidden="true"` or styled `display: none`. A `header`, `footer` or `aside` is the page's own when no
 * `article` or `section` holds it but a section that holds the page's main content, a `main` element or an element whose
 * role is `main`, and so wraps the page; inside an article or any other section, it is that part's and is read with it,
 * and an `article` or `section` handed over holds its own the same way. A `header` inside the page's main content that
 * holds an `h1` introduces that content: its headings, `hgroup`s and paragraphs are read, and the rest of it, a menu or
 * a list of links beside them, is the page's own; one that holds no `h1` is the page's own whole. A `form` is read as
 * the blocks it holds when it holds a page: a heading, an `article`, `aside`, `nav` or `section`, the page's main
 * content, a `header`, a `footer` or a table's header cell (`th`), as a table of data holds; when it is the page's main
 * content itself; or when it is the one element the body holds, as a page whose whole body sits in one form does. A heading whose words all sit in its one `button`, as an
 * accordion's header's do, is read for that button's words. A form's control, an image and the rest of HTML's embedded
 * content are each a space between the words on either side of them, outside code. Comments are not read. An element
 * handed over is read as a document is, whatever its own name, but an `svg` or `math` element handed over takes no
 * title from a `<title>` in it, which is the drawing's or the formula's.
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
  const parts: Parts = { forms: new Set(), wrappers: new Set() };
  const holds = noteParts(document, parts);
  // a section handed over that holds the page's main content wraps the page, as one inside it does
  if (document.nodeType === ELEMENT_NODE && nameOf(document) === 'section' && (holds & HOLDS_MAIN) !== 0) parts.wrappers.add(document);
  const reading: Reading = {
    images: 0,
    cut: false,
    named: named === '' ? null : named,
    firstH1: undefined,
    maxTableRows: boundOf('readHtml', 'maxTableRows', given.maxTableRows, 500, true),
    maxTableColumns: boundOf('readHtml', 'maxTableColumns', given.maxTableColumns, 30, true),
    pageOwn: pageOwnOf(document, parts.wrappers),
    forms: parts.forms,
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
