/**
 * The built package under plain Node.
 *
 * The other StatisticalUtilityAI suites import the TypeScript source through
 * Vitest, whose interop hands a CommonJS dependency's members to a namespace
 * import. Plain Node does not: a consumer that keeps `@framers/agentos` out of
 * its bundle loads `dist/` with Node's own ESM loader, where `natural` (CommonJS,
 * exports built at run time) arrives as `default` only. This suite runs the
 * built module in a child Node process, the way such a consumer does.
 *
 * CI builds before it tests; without a build the suite is skipped.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builtModule = path.resolve(here, '../../../../../dist/cognition/nlp/ai_utilities/StatisticalUtilityAI.js');

function runInNode(body: string): string {
  const script = `
    const { StatisticalUtilityAI } = await import(${JSON.stringify(pathToFileURL(builtModule).href)});
    const utility = new StatisticalUtilityAI('node-esm-check');
    await utility.initialize({ defaultLanguage: 'en' });
    ${body}
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

describe.skipIf(!existsSync(builtModule))('StatisticalUtilityAI built for plain Node ESM', () => {
  it('constructs, tokenizes with natural, and detects a French passage', () => {
    const out = runInNode(`
      const tokens = await utility.tokenize('The quick brown fox jumps');
      const [top] = await utility.detectLanguage(
        'Tous les êtres humains naissent libres et égaux en dignité et en droits. ' +
          'Ils sont doués de raison et de conscience et doivent agir les uns envers les autres.',
        { maxCandidates: 1 },
      );
      process.stdout.write(JSON.stringify({ tokens: tokens.length, language: top.language }));
    `);
    const result = JSON.parse(out) as { tokens: number; language: string };
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.language).toBe('fr');
  });
});
