import { describe, expect, it } from 'vitest';
import { compareManifests, dependencyManifest, undeclaredUse, type CatalogNode } from '../CatalogDependencyGraph.js';

const nodes: CatalogNode[] = [
  { id: 'guide.title', references: [] },
  { id: 'guide.body', references: ['shared.privacy', 'slot.hours'] },
  { id: 'shared.privacy', references: ['slot.hours'] },
  { id: 'slot.hours', references: [] },
  { id: 'unrelated', references: [] },
];
const words: Record<string, string> = { 'guide.title': 'Start a session', 'guide.body': 'Body', 'shared.privacy': 'Nothing is kept', 'slot.hours': '2 hours', unrelated: 'x' };

describe('catalog dependency graph', () => {
  it('lists every transitive dependency of a context once, in order, and digests the resolved words', () => {
    const result = dependencyManifest(nodes, { id: 'guide:signed-out', roots: ['guide.title', 'guide.body'] }, (id) => words[id] ?? '');
    expect(result.ok && result.manifest.ids).toEqual(['guide.body', 'guide.title', 'shared.privacy', 'slot.hours']);
  });

  it('changes only the resolved digest when a dependency\'s words change, and both when the graph changes', () => {
    const base = dependencyManifest(nodes, { id: 'c', roots: ['guide.body'] }, (id) => words[id] ?? '');
    const reworded = dependencyManifest(nodes, { id: 'c', roots: ['guide.body'] }, (id) => (id === 'shared.privacy' ? 'Nothing is written down' : words[id] ?? ''));
    const regrown = dependencyManifest([...nodes.slice(0, 2), { id: 'shared.privacy', references: [] }, ...nodes.slice(3)], { id: 'c', roots: ['guide.body'] }, (id) => words[id] ?? '');
    if (!base.ok || !reworded.ok || !regrown.ok) throw new Error('unexpected');
    expect(compareManifests(base.manifest, reworded.manifest)).toEqual({ dependenciesChanged: false, wordsChanged: true });
    expect(compareManifests(base.manifest, regrown.manifest)).toEqual({ dependenciesChanged: true, wordsChanged: false });
    const schemaOnly = dependencyManifest(nodes.map((node) => node.id === 'slot.hours' ? { ...node, definitionDigest: 'b'.repeat(64) } : node), { id: 'c', roots: ['guide.body'] }, (id) => words[id] ?? '');
    if (!schemaOnly.ok) throw new Error('unexpected');
    expect(compareManifests(base.manifest, schemaOnly.manifest)).toEqual({ dependenciesChanged: true, wordsChanged: false });
    const titleOnly = dependencyManifest(nodes, { id: 'c', roots: ['guide.title'] }, (id) => words[id] ?? '');
    if (!titleOnly.ok) throw new Error('unexpected');
    expect(compareManifests(base.manifest, titleOnly.manifest)).toEqual({ dependenciesChanged: true, wordsChanged: true });
  });

  it('fails a missing node, a cycle and a duplicate id, and names rendered ids the manifest lacks', () => {
    expect(dependencyManifest([{ id: 'a', references: ['b'] }], { id: 'c', roots: ['a'] }, () => '')).toEqual({ ok: false, error: 'missing_node', detail: 'a references b, which is not in the catalog' });
    expect(dependencyManifest([{ id: 'a', references: ['b'] }, { id: 'b', references: ['a'] }], { id: 'c', roots: ['a'] }, () => '')).toEqual({ ok: false, error: 'cycle', detail: 'a > b > a' });
    expect(dependencyManifest([{ id: 'a', references: [] }, { id: 'a', references: [] }], { id: 'c', roots: ['a'] }, () => '')).toEqual({ ok: false, error: 'duplicate_node', detail: 'a appears twice' });
    const manifest = dependencyManifest(nodes, { id: 'c', roots: ['guide.title'] }, (id) => words[id] ?? '');
    if (!manifest.ok) throw new Error('unexpected');
    expect(undeclaredUse(manifest.manifest, ['guide.title', 'unrelated'])).toEqual(['unrelated']);
  });
});
