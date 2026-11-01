import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCapabilitySupport } from '../runtime/capabilityContract.js';

// agent() validates structured output with `responseSchema`. `output` is the agency() option: agent() accepts it
// from BaseAgentConfig, does not apply it and warns at construction, so an agent() example that sets it shows a
// schema that is never checked.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const apiDir = fileURLToPath(new URL('../', import.meta.url));

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name));
}

/** The documentation sources an agent() example can appear in: the API modules' TSDoc, the README and the guides. */
function documentedSources(): Array<{ file: string; text: string }> {
  const files = [
    ...readdirSync(apiDir).filter((name) => name.endsWith('.ts')).map((name) => join(apiDir, name)),
    join(repoRoot, 'README.md'),
    ...markdownFiles(join(repoRoot, 'docs')),
  ];
  return files.map((file) => ({
    file: relative(repoRoot, file),
    // TSDoc lines lose their leading `*` so a fenced example reads as it does in a guide.
    text: readFileSync(file, 'utf8').replace(/^[ \t]*\*[ \t]?/gm, ''),
  }));
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

/** The keys set at the top level of the object literal that opens at `start` (a `{`). */
function topLevelKeys(source: string, start: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
      expectKey = false;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      expectKey = depth === 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && ch === ',') {
      expectKey = true;
      continue;
    }
    if (depth === 1 && expectKey && /[A-Za-z_$]/.test(ch)) {
      const key = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(source.slice(i));
      if (key) keys.push(key[0]);
      expectKey = false;
    }
  }
  return keys;
}

function agentExampleKeys(block: string): string[][] {
  return [...block.matchAll(/(?<![\w.$])agent\(\s*\{/g)].map((match) => topLevelKeys(block, match.index + match[0].length - 1));
}

/** The agent() examples in one source that set `output` at their top level. */
function outputOffenders(file: string, text: string): string[] {
  const offenders: string[] = [];
  for (const block of fencedBlocks(text)) {
    for (const keys of agentExampleKeys(block)) {
      if (keys.includes('output')) offenders.push(`${file}: agent({ ${keys.join(', ')} })`);
    }
  }
  if (/(?<![\w.$])agent\(\{\s*output\s*:/.test(text)) offenders.push(`${file}: inline agent({ output: ... })`);
  return offenders;
}

describe('agent() examples name the schema option agent() applies', () => {
  it('agent() does not apply `output`, so an example that sets it validates nothing', () => {
    expect(getCapabilitySupport('agent', 'output')).toBe('accepted_but_deferred');
  });

  it('no agent() example in the TSDoc, the README or the guides sets `output`', () => {
    const offenders = documentedSources().flatMap(({ file, text }) => outputOffenders(file, text));
    expect(offenders).toEqual([]);
  });

  it('the routerParams example passes its schema as responseSchema', () => {
    const source = documentedSources().find(({ file }) => file === join('src', 'api', 'agent.ts'));
    const example = fencedBlocks(source?.text ?? '').find((block) => block.includes('routerParams:'));
    expect(example).toBeDefined();
    expect(agentExampleKeys(example ?? '')).toEqual([['name', 'router', 'routerParams', 'responseSchema']]);
  });
});

describe('the agent() example scan', () => {
  it('finds `output` after a block comment in a fenced example', () => {
    const text = "```ts\nconst a = agent({ name: 'A', /* the schema */ output: schema });\n```\n";
    expect(outputOffenders('guide.md', text)).toEqual(['guide.md: agent({ name, output })']);
  });

  it('finds `output` after another key in an unfenced example', () => {
    const text = "Call `agent({ provider: 'openai', output: schema })` to get a parsed reply.\n";
    expect(outputOffenders('guide.md', text)).toEqual(['guide.md: agent({ provider, output })']);
  });

  it('passes examples that name responseSchema', () => {
    const text = [
      '```ts',
      "agent({ name: 'A', /* the schema */ responseSchema: schema });",
      '```',
      "Call `agent({ provider: 'openai', responseSchema: schema })` to get a parsed reply.",
    ].join('\n');
    expect(outputOffenders('guide.md', text)).toEqual([]);
  });
});
