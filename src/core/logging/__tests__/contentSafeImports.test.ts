import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const fixed = [
  'src/api/generateText.ts', 'src/api/model.ts', 'src/api/observers.ts',
  'src/api/runtime/spendBudget.ts', 'src/api/runtime/tool-emulation/loop.ts',
  'src/cognition/rag/EmbeddingManager.ts', 'src/core/safety/LLMProviderHealthRegistry.ts',
  'src/core/llm/providers/AIModelProviderManager.ts', 'src/core/llm/routing/ModelRouter.ts',
];
const folder = 'src/core/llm/providers/implementations';

it('routes every executable console reference in the covered provider paths', () => {
  const paths = [...fixed, ...readdirSync(folder).filter((name) => name.endsWith('.ts'))
    .map((name) => join(folder, name))];
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    let references = 0;
    let guarded = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text.endsWith('/contentSafeConsole.js')) {
        const names = node.importClause?.namedBindings;
        guarded = !!names && ts.isNamedImports(names) && names.elements.some((element) =>
          element.name.text === 'console' && element.propertyName?.text === 'contentSafeConsole');
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'console') references++;
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'console') references++;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && ['globalThis', 'global', 'window'].includes(node.expression.text)) {
        expect(node.name.text, path).not.toBe('console');
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (references > 0) expect(guarded, path).toBe(true);
  }
});
