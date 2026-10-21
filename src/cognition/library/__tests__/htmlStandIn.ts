/**
 * A stand-in for a parsed HTML document, built of plain objects, for the HTML reader's tests in Node, where there is no
 * DOMParser. It parses the well-formed markup the tests write: elements closed as written, void elements, raw text in
 * `script` and `style`, text in `title` and `textarea`, comments, a doctype, the line feed the HTML parser drops after
 * `<pre>`, and the few character references the tests use. Element names are kept in lower case, as an XHTML document
 * gives them, where an HTML document's DOM gives them in upper case, so the reader is held to either.
 */

/** A node of the stand-in, with only the properties a reader of a DOM may walk. */
export interface StandInNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: StandInNode[];
  readonly textContent: string | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

/** Elements that never hold children. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Elements whose text runs to their end tag and is kept as written. */
const RAW_TEXT = new Set(['script', 'style']);

/** Elements whose text runs to their end tag with its character references read. */
const ESCAPABLE_TEXT = new Set(['textarea', 'title']);

/** The named references the tests use. */
const NAMED: Readonly<Record<string, string>> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };

/** A start tag at a place in the markup: its name, its attributes and a closing slash. */
const START_TAG = /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;

/** One attribute of a start tag. */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Text with its character references read. */
function decode(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, reference: string) => {
    if (reference.startsWith('#x') || reference.startsWith('#X')) return String.fromCodePoint(Number.parseInt(reference.slice(2), 16));
    if (reference.startsWith('#')) return String.fromCodePoint(Number.parseInt(reference.slice(1), 10));
    return NAMED[reference.toLowerCase()] ?? whole;
  });
}

/** A text node. */
function textNode(text: string): StandInNode {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: text };
}

/** A comment node. */
function commentNode(text: string): StandInNode {
  return { nodeType: 8, nodeName: '#comment', childNodes: [], textContent: text };
}

/** An element with its attributes, its text read from its children as the DOM's `textContent` reads it. */
function elementNode(name: string, attributes: ReadonlyMap<string, string>): StandInNode {
  const childNodes: StandInNode[] = [];
  return {
    nodeType: 1,
    nodeName: name,
    childNodes,
    get textContent(): string {
      return childNodes.map((child) => (child.nodeType === 8 ? '' : (child.textContent ?? ''))).join('');
    },
    getAttribute: (attribute: string): string | null => attributes.get(attribute.toLowerCase()) ?? null,
    hasAttribute: (attribute: string): boolean => attributes.has(attribute.toLowerCase()),
  };
}

/** A start tag's attributes, by their names in lower case, each read once as the HTML parser keeps the first. */
function attributesOf(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name !== '' && !found.has(name)) found.set(name, decode(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return found;
}

/** Parses the tests' markup into a document of stand-in nodes. */
export function standInDocument(html: string): StandInNode {
  const document: StandInNode = { nodeType: 9, nodeName: '#document', childNodes: [], textContent: null };
  const open: StandInNode[] = [document];
  const add = (node: StandInNode): void => {
    (open[open.length - 1] ?? document).childNodes.push(node);
  };
  let at = 0;
  while (at < html.length) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      add(commentNode(html.slice(at + 4, end < 0 ? html.length : end)));
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', at)) {
      const end = html.indexOf('>', at);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', at)) {
      const end = html.indexOf('>', at);
      const name = html.slice(at + 2, end < 0 ? html.length : end).trim().toLowerCase();
      const depth = open.map((node) => node.nodeName).lastIndexOf(name);
      if (depth > 0) open.length = depth;
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    START_TAG.lastIndex = at;
    const tag = START_TAG.exec(html);
    if (tag !== null) {
      const name = (tag[1] ?? '').toLowerCase();
      const node = elementNode(name, attributesOf(tag[2] ?? ''));
      add(node);
      at = START_TAG.lastIndex;
      if (RAW_TEXT.has(name) || ESCAPABLE_TEXT.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, at);
        const text = html.slice(at, close < 0 ? html.length : close);
        if (text !== '') node.childNodes.push(textNode(RAW_TEXT.has(name) ? text : decode(text)));
        const end = close < 0 ? -1 : html.indexOf('>', close);
        at = end < 0 ? html.length : end + 1;
      } else if (!VOID.has(name) && tag[3] !== '/') {
        open.push(node);
        // the HTML parser drops a line feed right after a pre's start tag
        if (name === 'pre' && html[at] === '\n') at += 1;
      }
      continue;
    }
    const next = html.indexOf('<', at + 1);
    const end = next < 0 ? html.length : next;
    add(textNode(decode(html.slice(at, end))));
    at = end;
  }
  return document;
}
