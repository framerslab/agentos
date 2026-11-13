/**
 * @fileoverview What a host's bundler reaches from this package. esbuild follows every static import, and every
 * `import()` or `require()` whose argument is a string literal (a `?:` of two literals counts as both); an argument
 * that is not a literal is left to the runtime
 * (https://github.com/evanw/esbuild/blob/v0.28.2/internal/js_parser/js_parser.go, the `EImportCall` case). A module on
 * those paths that names `@huggingface/transformers` or `@xenova/transformers` by a literal therefore puts
 * Transformers.js in the host's bundle: a host without the optional package fails to build, and a host with it reaches
 * onnxruntime-node's native binary. These walk the source from the package's main entry and from memory recall, the
 * way a bundler does, and find no such module.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const OPTIONAL = new Set(['@huggingface/transformers', '@xenova/transformers']);
const LOCAL_RERANKER = 'cognition/rag/reranking/providers/LocalCrossEncoderReranker.ts';

/** The string literals an import argument can be: esbuild splits a `?:` and imports each side. */
function literals(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  return [];
}

/** Whether an import or export clause names values; one that names only types is erased before a bundler sees it. */
function namesValues(bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined): boolean {
  if (!bindings) return true;
  if (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) {
    return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

/** The specifiers a bundler follows from one module's source. */
function followedSpecifiers(source: string, fileName = 'module.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly || (clause !== undefined && !clause.name && !namesValues(clause.namedBindings));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly && namesValues(node.exportClause)) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        found.push(...literals(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The source file a relative specifier names, as TypeScript's `.js` specifiers resolve to `.ts`. */
function resolveLocal(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Walks the modules a bundler reaches from `entry`.
 *
 * @returns Each module reached, by its path under `src`, and each place an optional package is named by a literal,
 *   with the chain of imports that reaches it.
 */
function walk(entry: string): { reached: Set<string>; offences: string[] } {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const offences: string[] = [];
  const name = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');
  const chain = (file: string): string => {
    const names: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) names.push(name(at));
    return names.reverse().join(' > ');
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of followedSpecifiers(readFileSync(file, 'utf8'), file)) {
      if (OPTIONAL.has(specifier)) {
        offences.push(`${chain(file)} names ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = resolveLocal(file, specifier);
      if (!target || parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return { reached: new Set([...parent.keys()].map(name)), offences };
}

describe('the specifiers a bundler follows', () => {
  it('reads a literal import, require and a ?: of literals, and leaves a variable and type-only imports out', () => {
    const source = [
      "import type { Pipeline } from '@xenova/transformers';",
      "import { type Tensor } from '@huggingface/transformers';",
      "export type { Env } from '@huggingface/transformers';",
      "import { a } from './a.js';",
      "export * from './b.js';",
      "const spec = '@huggingface/transformers';",
      'void import(spec);',
      "void import('@huggingface/transformers');",
      "void import(flag ? '@xenova/transformers' : './c.js');",
      "require('./d.js');",
    ].join('\n');
    expect(followedSpecifiers(source)).toEqual(['./a.js', './b.js', '@huggingface/transformers', '@xenova/transformers', './c.js', './d.js']);
  });
});

describe.each([
  ['the package main entry', 'index.ts'],
  ['memory recall', 'cognition/memory/retrieval/recall/index.ts'],
])('what a bundler reaches from %s', (_label, entry) => {
  const { reached, offences } = walk(path.join(SRC, entry));

  it('reaches the local reranker, so the walk covers the recall path', () => {
    expect(reached.has(LOCAL_RERANKER)).toBe(true);
  });

  it('names no optional Transformers.js package by a literal specifier', () => {
    expect(offences).toEqual([]);
  });
});
