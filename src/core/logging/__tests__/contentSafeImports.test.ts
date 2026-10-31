import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const fixed = [
  'src/api/generateText.ts', 'src/api/streamText.ts', 'src/api/model.ts', 'src/api/observers.ts',
  'src/api/runtime/approval-gate.ts', 'src/api/runtime/spendBudget.ts', 'src/api/runtime/tool-emulation/loop.ts',
  'src/cognition/rag/EmbeddingManager.ts', 'src/core/safety/LLMProviderHealthRegistry.ts',
  'src/core/llm/providers/AIModelProviderManager.ts', 'src/core/llm/routing/ModelRouter.ts',
  'src/io/voice-pipeline/ListenSession.ts', 'src/io/voice-pipeline/ReconnectingSTT.ts',
  'src/io/voice-pipeline/providers/StreamingSTTChain.ts', 'src/io/voice-pipeline/LiveKitStreamTransport.ts',
  'src/api/runtime/agencyLaunch/gmiLaunchTool.ts',
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
        guarded = Boolean(names && ts.isNamedImports(names) && names.elements.some((element) =>
          (element.name.text === 'console' && element.propertyName?.text === 'contentSafeConsole')
          || element.name.text === 'createContentSafeConsole'));
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
    // A factory import routes nothing until the module binds its console from it at the top level.
    if (references > 0 && source.includes('createContentSafeConsole')) {
      expect(/^const console = createContentSafeConsole\('[a-z_]+'\);$/m.test(source), path).toBe(true);
    }
  }
});
