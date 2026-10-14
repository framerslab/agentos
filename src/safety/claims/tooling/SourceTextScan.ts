/**
 * @module safety/claims/tooling/SourceTextScan
 *
 * Text a reader can meet, found in source: JSX text, text-bearing attributes, sentence-like string and template
 * literals, and every string of a metadata export, with file, line and column; the import graph a page reaches,
 * through static, re-export and dynamic imports; and a template's visible text and spoken attributes, with its scripts,
 * styles and comments left out. The TypeScript compiler is passed in by the caller. Strings pass as structural only
 * through syntax that cannot carry text to a reader (an import specifier, a type, a property name, an element access,
 * a directive, a comparison) or through an attribute the caller names as structural; never by file.
 */
import type * as TS from 'typescript';

/** The TypeScript compiler module, as `import ts from 'typescript'` gives it. */
export type TypeScriptModule = typeof TS;

/** Where a piece of text was found. */
export type TextSite = 'jsx-text' | 'jsx-attribute' | 'string' | 'template' | 'metadata';

/** A source file. */
export interface SourceInput {
  path: string;
  text: string;
}

/** What counts as text. */
export interface ScanOptions {
  /** Attributes whose every value is text (`alt`, `title`, `aria-label`). */
  textAttributes: readonly string[];
  /** Attributes whose values are never text (`className`, `href`); `data-*` is always structural. */
  structuralAttributes: readonly string[];
  /** Names of exports whose every string is text (`metadata`, `generateMetadata`). */
  metadataExports: readonly string[];
}

/** One piece of text. A template's substitutions are written `{}`. */
export interface TextOccurrence {
  file: string;
  /** The line, counted from 1. */
  line: number;
  /** The column, counted from 1. */
  column: number;
  site: TextSite;
  /** The attribute's name, for a `jsx-attribute` site. */
  attribute?: string;
  text: string;
}

const LETTER = /\p{L}/u;
const SPACE = /\s/u;
const sentenceLike = (text: string): boolean => LETTER.test(text) && SPACE.test(text.trim());

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', middot: '·', copy: '©', ndash: '–',
};

/**
 * Decodes HTML character references: the common named ones and every numeric one.
 *
 * @param text - Text with references.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED[body] ?? whole;
  });
}

const collapse = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim();

/**
 * Every text site in the files.
 *
 * @param ts - The TypeScript compiler module.
 * @param files - The files to read; `.tsx` files are read as TSX.
 * @param options - What counts as text.
 * @returns The sites, ordered by file, line and column.
 */
export function scanSourceText(ts: TypeScriptModule, files: readonly SourceInput[], options: ScanOptions): TextOccurrence[] {
  const out: TextOccurrence[] = [];
  const textAttributes = new Set(options.textAttributes);
  const structural = new Set(options.structuralAttributes);
  const metadata = new Set(options.metadataExports);
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const push = (node: TS.Node, site: TextSite, text: string, attribute?: string): void => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      out.push({ file: file.path, line: line + 1, column: character + 1, site, ...(attribute === undefined ? {} : { attribute }), text });
    };
    const inMetadata = (node: TS.Node): boolean => {
      for (let n: TS.Node | undefined = node; n !== undefined; n = n.parent) {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && metadata.has(n.name.text)) return true;
        if (ts.isFunctionDeclaration(n) && n.name !== undefined && metadata.has(n.name.text)) return true;
      }
      return false;
    };
    const attributeOf = (node: TS.Node): string | null => {
      for (let n: TS.Node | undefined = node.parent; n !== undefined; n = n.parent) {
        if (ts.isJsxAttribute(n)) return n.name.getText(source);
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ts.isJsxOpeningElement(n)) return null;
      }
      return null;
    };
    const structuralSyntax = (node: TS.Node): boolean => {
      const parent = node.parent;
      if (parent === undefined) return true;
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent)) return true;
      if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return true;
      if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
      if (ts.isExpressionStatement(parent)) return true;
      if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
      if (ts.isCaseClause(parent)) return true;
      if (ts.isBinaryExpression(parent)) {
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return true;
      }
      return false;
    };
    const visit = (node: TS.Node): void => {
      if (ts.isJsxText(node)) {
        const text = collapse(node.text);
        if (text !== '') push(node, 'jsx-text', text);
      } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !structuralSyntax(node)) {
        const attribute = attributeOf(node);
        const text = node.text;
        if (attribute !== null) {
          const isText = textAttributes.has(attribute) ? text.trim() !== '' : sentenceLike(text);
          if (!structural.has(attribute) && !attribute.startsWith('data-') && isText) push(node, 'jsx-attribute', text, attribute);
        } else if (inMetadata(node)) {
          if (LETTER.test(text)) push(node, 'metadata', text);
        } else if (sentenceLike(text)) {
          push(node, 'string', text);
        }
      } else if (ts.isTemplateExpression(node)) {
        const text = [node.head.text, ...node.templateSpans.map((span) => `{}${span.literal.text}`)].join('');
        const attribute = attributeOf(node);
        const blocked = attribute !== null && (structural.has(attribute) || attribute.startsWith('data-'));
        if (!blocked) {
          if (inMetadata(node)) {
            if (LETTER.test(text)) push(node, 'metadata', text);
          } else if (sentenceLike(text)) push(node, attribute !== null && textAttributes.has(attribute) ? 'jsx-attribute' : 'template', text, attribute !== null && textAttributes.has(attribute) ? attribute : undefined);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out.sort((a, b) => (a.file === b.file ? (a.line === b.line ? a.column - b.column : a.line - b.line) : a.file < b.file ? -1 : 1));
}

/** The files a set of entries reaches, and the relative imports nothing resolved. */
export interface ImportGraph {
  /** Every file reached, the entries included, sorted. */
  files: readonly string[];
  /** Each import nothing resolved; an entry or a resolved path missing from the files is listed as itself, in both fields. */
  unresolved: readonly { from: string; specifier: string }[];
}

/**
 * The import graph from some entry files.
 *
 * @param ts - The TypeScript compiler module.
 * @param files - Every file the graph may reach, by path.
 * @param entries - Where to start.
 * @param resolve - A specifier's file in `files`, `'external'` for a package, or null when it cannot be resolved.
 */
export function importGraph(ts: TypeScriptModule, files: ReadonlyMap<string, string>, entries: readonly string[], resolve: (from: string, specifier: string) => string | 'external' | null): ImportGraph {
  const reached = new Set<string>();
  const unresolved: { from: string; specifier: string }[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (reached.has(path)) continue;
    const text = files.get(path);
    if (text === undefined) {
      unresolved.push({ from: path, specifier: path });
      continue;
    }
    reached.add(path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const specifiers: string[] = [];
    const visit = (node: TS.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      const target = resolve(path, specifier);
      if (target === 'external') continue;
      if (target === null) unresolved.push({ from: path, specifier });
      else queue.push(target);
    }
  }
  return { files: [...reached].sort(), unresolved };
}

/** A piece of a template's text. */
export interface TemplateText {
  /** The line, counted from 1. */
  line: number;
  site: 'text' | 'attribute';
  /** The attribute's name, for an attribute site. */
  attribute?: string;
  text: string;
}

const SILENT_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const SPOKEN = ['alt', 'title', 'aria-label', 'placeholder'];

/**
 * The visible text of an HTML template and its spoken attributes, with a meta description's `content`; scripts,
 * styles, templates, noscript blocks and comments are left out.
 *
 * @param html - The template, read as text.
 */
export function htmlTemplateText(html: string): TemplateText[] {
  const out: TemplateText[] = [];
  const lineAt = (index: number): number => html.slice(0, index).split('\n').length;
  let i = 0;
  let textStart = 0;
  const flush = (end: number): void => {
    const text = collapse(html.slice(textStart, end));
    if (text !== '') out.push({ line: lineAt(textStart + (html.slice(textStart, end).length - html.slice(textStart, end).trimStart().length)), site: 'text', text });
  };
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      flush(i);
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      textStart = i;
      continue;
    }
    if (html[i] === '<') {
      const close = html.indexOf('>', i);
      if (close === -1) break;
      flush(i);
      const tag = html.slice(i + 1, close);
      const name = (/^\/?([a-zA-Z0-9-]+)/.exec(tag)?.[1] ?? '').toLowerCase();
      const attributes = new Map<string, string>();
      for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) attributes.set((m[1] as string).toLowerCase(), m[3] ?? m[4] ?? '');
      if (!tag.startsWith('/')) {
        for (const attribute of SPOKEN) {
          const value = attributes.get(attribute);
          if (value !== undefined && collapse(value) !== '') out.push({ line: lineAt(i), site: 'attribute', attribute, text: collapse(value) });
        }
        const meta = (attributes.get('name') ?? attributes.get('property') ?? '').toLowerCase();
        if (name === 'meta' && (meta === 'description' || meta === 'og:description' || meta === 'og:title' || meta === 'twitter:description')) {
          const content = attributes.get('content');
          if (content !== undefined && collapse(content) !== '') out.push({ line: lineAt(i), site: 'attribute', attribute: 'content', text: collapse(content) });
        }
        if (SILENT_TAGS.has(name)) {
          const end = html.toLowerCase().indexOf(`</${name}`, close);
          const after = end === -1 ? html.length : html.indexOf('>', end);
          i = after === -1 ? html.length : after + 1;
          textStart = i;
          continue;
        }
      }
      i = close + 1;
      textStart = i;
      continue;
    }
    i += 1;
  }
  flush(html.length);
  return out;
}
