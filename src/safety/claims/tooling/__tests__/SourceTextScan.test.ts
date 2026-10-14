import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlTemplateText, importGraph, scanSourceText } from '../SourceTextScan.js';

const options = { textAttributes: ['alt', 'title', 'aria-label', 'placeholder'], structuralAttributes: ['className', 'href', 'id', 'goal'], metadataExports: ['metadata', 'generateMetadata'] };
const scan = (text: string, path = 'Example.tsx') => scanSourceText(ts, [{ path, text }], options);

describe('source text scan', () => {
  it('finds JSX text, text attributes, sentence-like strings, template text and metadata', () => {
    const found = scan(`
      import { Card } from './Card';
      export const metadata = { title: 'Example', description: 'An example page.' };
      const LINE = 'A sentence held in a constant.';
      export function Example({ n }: { n: number }) {
        return (
          <section className="sec vis" id="h-ex">
            <h2>Plain heading</h2>
            <img alt="A picture of the example" src="/x.png" />
            <Card goal="Example opened" label={\`\${n} items in the list\`} />
            <p>{'Inline literal sentence.'}</p>
          </section>
        );
      }`);
    expect(found.map((f) => [f.site, f.text])).toEqual([
      ['metadata', 'Example'],
      ['metadata', 'An example page.'],
      ['string', 'A sentence held in a constant.'],
      ['jsx-text', 'Plain heading'],
      ['jsx-attribute', 'A picture of the example'],
      ['template', '{} items in the list'],
      ['string', 'Inline literal sentence.'],
    ]);
  });

  it('passes structural strings through non-text syntax only', () => {
    const found = scan(`
      'use client';
      import styles from './x.module.scss';
      type Kind = 'one word' | 'two words';
      const map = { 'a key with spaces': 1 };
      export function X({ kind }: { kind: Kind }) {
        if (kind === 'two words') return null;
        return <a className="key primary" href="/a b" data-state="open now">{map['a key with spaces']}</a>;
      }`);
    expect(found).toEqual([]);
  });

  it('follows static, re-export and dynamic imports, and reports what it cannot resolve', () => {
    const files = new Map([
      ['page.tsx', "import { A } from './a'; const B = await import('./b'); export * from './c';"],
      ['a.tsx', "import 'react'; import { D } from './d';"],
      ['b.ts', ''],
      ['c.ts', ''],
    ]);
    const resolve = (_from: string, spec: string) => (spec === 'react' ? 'external' : files.has(`${spec.slice(2)}.tsx`) ? `${spec.slice(2)}.tsx` : files.has(`${spec.slice(2)}.ts`) ? `${spec.slice(2)}.ts` : null);
    expect(importGraph(ts, files, ['page.tsx'], resolve)).toEqual({ files: ['a.tsx', 'b.ts', 'c.ts', 'page.tsx'], unresolved: [{ from: 'a.tsx', specifier: './d' }] });
  });

  it('follows import assignments and template-literal specifiers, and reports a dynamic import whose specifier is computed', () => {
    const files = new Map([
      ['page.tsx', "import legacy = require('./legacy');\nconst lang = 'en';\nconst A = await import(`./a`);\nconst L = await import(`./locales/${lang}`);\nconst M = await import(lang);"],
      ['a.ts', ''],
      ['legacy.ts', ''],
    ]);
    const resolve = (_from: string, spec: string) => (files.has(`${spec.slice(2)}.ts`) ? `${spec.slice(2)}.ts` : null);
    expect(importGraph(ts, files, ['page.tsx'], resolve)).toEqual({
      files: ['a.ts', 'legacy.ts', 'page.tsx'],
      unresolved: [{ from: 'page.tsx', specifier: '`./locales/${lang}`' }, { from: 'page.tsx', specifier: 'lang' }],
    });
  });

  it('reads a template\'s visible text and its spoken attributes, never its scripts or styles', () => {
    const html = '<html><head><title>Plans &amp; prices</title><meta name="description" content="What a plan holds."><style>.a{content:"x"}</style></head>\n<body><p>One&nbsp;line</p><!-- a note --><script>var s = "no";</script><img alt="The view" src="a.png"></body></html>';
    expect(htmlTemplateText(html)).toEqual([
      { line: 1, site: 'text', text: 'Plans & prices' },
      { line: 1, site: 'attribute', attribute: 'content', text: 'What a plan holds.' },
      { line: 2, site: 'text', text: 'One line' },
      { line: 2, site: 'attribute', attribute: 'alt', text: 'The view' },
    ]);
    expect(decodeEntities('&#x2019;&#8217;&rsquo;&quot;')).toBe('’’’"');
  });

  it('reads noscript and template blocks, a button input\'s label, unquoted attributes and a bare less-than sign', () => {
    const html = '<body><noscript><p>Turn on scripts to listen.</p></noscript>\n<template><li>Copy the link</li></template><img alt=Logo src=logo.png><input type=submit value="Start listening"><input type="hidden" value="a-token">\n<p>Fewer than 3 < 5 steps</p></body>';
    expect(htmlTemplateText(html)).toEqual([
      { line: 1, site: 'text', text: 'Turn on scripts to listen.' },
      { line: 2, site: 'text', text: 'Copy the link' },
      { line: 2, site: 'attribute', attribute: 'alt', text: 'Logo' },
      { line: 2, site: 'attribute', attribute: 'value', text: 'Start listening' },
      { line: 3, site: 'text', text: 'Fewer than 3 < 5 steps' },
    ]);
  });
});
