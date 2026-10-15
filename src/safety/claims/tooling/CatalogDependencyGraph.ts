/**
 * @module safety/claims/tooling/CatalogDependencyGraph
 *
 * A catalog of words as a graph: each node names the nodes its text depends on (nested rich text, shared copy,
 * referenced sentences, choices and slot schemas). For one context (a page or guide with its selections), the
 * manifest lists every node its roots reach, sorted, with a digest of that list and a digest of the words each node
 * resolves to in the context. Comparing a base and a head manifest says whether the dependencies changed and whether
 * the resolved words changed, so a change in shared copy counts as a change to every context that reads it. A
 * missing node, a cycle or a duplicate id fails; rendered ids the manifest lacks are named.
 */
import { digestOf } from '../digest.js';

/** One catalog node and what it references. */
export interface CatalogNode {
  /** The node's catalog id. */
  id: string;
  /** The ids of the nodes this node's text depends on. */
  references: readonly string[];
  /** Immutable definition or slot-schema digest; optional for callers without definition schemas. */
  definitionDigest?: string;
}

/** One context: its id and its root nodes. */
export interface CatalogContext {
  id: string;
  roots: readonly string[];
}

/** One context's manifest. */
export interface DependencyManifest {
  contextId: string;
  /** Every node the context's roots reach, each once, sorted. */
  ids: readonly string[];
  /** Digest of the context id, its sorted roots, and each reached node's distinct references (sorted) and definition digest. */
  manifestDigest: string;
  /** Digest of each reached node's id with the words it resolves to in the context. */
  resolvedDigest: string;
}

/** A manifest, or why there is none. */
export type ManifestResult = { ok: true; manifest: DependencyManifest } | { ok: false; error: 'missing_node' | 'cycle' | 'duplicate_node'; detail: string };

/**
 * The manifest of one context.
 *
 * @param nodes - The catalog.
 * @param context - The context and its roots.
 * @param render - A node's words in this context.
 */
export function dependencyManifest(nodes: readonly CatalogNode[], context: CatalogContext, render: (id: string) => string): ManifestResult {
  const byId = new Map<string, CatalogNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) return { ok: false, error: 'duplicate_node', detail: `${node.id} appears twice` };
    byId.set(node.id, node);
  }
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let failure: ManifestResult | null = null;
  const visit = (id: string, from: string | null): void => {
    if (failure !== null || done.has(id)) return;
    if (onStack.has(id)) {
      failure = { ok: false, error: 'cycle', detail: [...stack.slice(stack.indexOf(id)), id].join(' > ') };
      return;
    }
    const node = byId.get(id);
    if (node === undefined) {
      failure = { ok: false, error: 'missing_node', detail: from === null ? `the root ${id} is not in the catalog` : `${from} references ${id}, which is not in the catalog` };
      return;
    }
    stack.push(id);
    onStack.add(id);
    for (const next of node.references) visit(next, id);
    stack.pop();
    onStack.delete(id);
    done.add(id);
  };
  for (const root of context.roots) visit(root, null);
  if (failure !== null) return failure;
  const ids = [...done].sort();
  return {
    ok: true,
    manifest: {
      contextId: context.id,
      ids,
      manifestDigest: digestOf({ context: context.id, roots: [...context.roots].sort(), nodes: ids.map((id) => { const node = byId.get(id)!; return { id, references: [...new Set(node.references)].sort(), definitionDigest: node.definitionDigest ?? null }; }) }),
      resolvedDigest: digestOf(ids.map((id) => [id, render(id)])),
    },
  };
}

/**
 * How a head manifest differs from its base.
 *
 * @param base - The manifest at the base revision.
 * @param head - The manifest at the head revision.
 */
export function compareManifests(base: DependencyManifest, head: DependencyManifest): { dependenciesChanged: boolean; wordsChanged: boolean } {
  return { dependenciesChanged: base.manifestDigest !== head.manifestDigest, wordsChanged: base.resolvedDigest !== head.resolvedDigest };
}

/**
 * Rendered ids the manifest does not hold.
 *
 * @param manifest - The context's manifest.
 * @param rendered - The ids the rendering used.
 */
export function undeclaredUse(manifest: DependencyManifest, rendered: readonly string[]): string[] {
  const held = new Set(manifest.ids);
  return [...new Set(rendered)].filter((id) => !held.has(id)).sort();
}
