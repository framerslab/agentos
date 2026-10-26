/**
 * @fileoverview The part of a parsed HTML document the HTML reader walks, typed by its structure so the package
 * compiles without DOM types: a page passes the `Document` or the `Element` its own `DOMParser` gave, and code outside
 * a page passes the nodes of whichever DOM it parsed with. The reader reads nodes and never changes them.
 * @module agentos/cognition/library/readers/dom
 */

/** A node's `nodeType` for an element. */
export const ELEMENT_NODE = 1;

/** A node's `nodeType` for a run of text. */
export const TEXT_NODE = 3;

/** A node's `nodeType` for a CDATA section, which an XHTML document can hold, read as text. */
export const CDATA_SECTION_NODE = 4;

/** A node's `nodeType` for a document. */
export const DOCUMENT_NODE = 9;

/** A node's `nodeType` for a document fragment. */
export const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * A node of a parsed HTML or XHTML document, by the properties the HTML reader reads. A browser's `Node` satisfies it,
 * and so does an `Element`, whose attribute methods the reader calls on the element itself.
 */
export interface HtmlNodeLike {
  /** 1 for an element, 3 for text, 4 for a CDATA section, 8 for a comment, 9 for a document, 11 for a fragment. */
  readonly nodeType: number;
  /** An element's name: in upper case in an HTML document, in lower case in an XHTML one; read in either. */
  readonly nodeName: string;
  /** The node's children, in document order, as an array-like list, so a browser's own `NodeList` passes as it is. */
  readonly childNodes: ArrayLike<HtmlNodeLike>;
  /** A text node's characters; the reader reads it from text and CDATA nodes alone. */
  readonly textContent: string | null;
  /** An element's attribute by its name, or `null`; a node that is no element need not have it. */
  getAttribute?(name: string): string | null;
  /** Whether an element has an attribute by its name; a node that is no element need not have it. */
  hasAttribute?(name: string): boolean;
}

/** A parsed document, or an element whose content is read as a document's, by the properties the reader reads. */
export type HtmlDocumentLike = HtmlNodeLike;
