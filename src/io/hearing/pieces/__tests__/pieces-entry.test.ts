import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../dist');
const entry = resolve(distRoot, 'io/hearing/pieces/index.js');
const patterns = [
  /^\s*(?:import|export)\s+[\w*{}\s,$]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^(?!\s*(?:\*|\/\/|\/\*))[^\n]*?\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

describe('the audio pieces entry', () => {
  it('reaches only library modules and mediabunny, with no Node built-ins or Buffer', () => {
    expect(existsSync(entry), 'the audio pieces entry is built before this test').toBe(true);
    const visited = new Set<string>();
    const queue = [entry];
    const outside: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      expect(source, relative(distRoot, file)).not.toMatch(/\bBuffer\b/);
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1]!;
          if (specifier.startsWith('.')) {
            const target = resolve(dirname(file), specifier);
            expect(relative(distRoot, target).startsWith(`..${sep}`)).toBe(false);
            queue.push(target);
          } else if (specifier !== 'mediabunny') {
            outside.push(`${relative(distRoot, file)}: ${specifier}`);
          }
        }
      }
    }
    expect(outside).toEqual([]);
    expect([...visited].map((file) => relative(distRoot, file).split(sep).join('/'))).toEqual(expect.arrayContaining([
      'io/hearing/pieces/plan.js', 'io/hearing/pieces/read.js', 'io/hearing/pieces/cut.js', 'io/hearing/pieces/wav.js',
      'io/hearing/transcribePieces.js', 'io/voice-pipeline/TranscriptDedupe.js',
    ]));
  });
});
