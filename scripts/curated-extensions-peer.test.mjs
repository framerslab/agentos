/**
 * The curated extensions installed for the tests take this checkout as their AgentOS.
 *
 * @framers/agentos-extensions-registry, a dev dependency, installs the curated
 * @framers/agentos-ext-* packages as optional dependencies, and the registry and each extension
 * declare @framers/agentos as a peer. No registry package can provide that peer here, since this
 * repository is @framers/agentos itself, so pnpm used to install a published AgentOS for them, and
 * a test that loaded the registry or an extension ran it against that release instead of this
 * tree. package.json gives the repository a dev dependency on itself, "@framers/agentos":
 * "link:.", and pnpm resolves every one of those peers to it.
 *
 * Both checks need an install and no build: the first reads pnpm-lock.yaml, the second follows
 * Node's module lookup from each installed package to the AgentOS it would import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTOS = '@framers/agentos';
const REGISTRY = '@framers/agentos-extensions-registry';

/** The registry and the curated extensions it installs. */
const isCurated = (name) => name === REGISTRY || name.startsWith('@framers/agentos-ext-');

/** A lockfile key (`name@version`, then an optional peer suffix) as its package name and its key in `packages`. */
function splitKey(key) {
  const at = key.indexOf('@', 1);
  const name = key.slice(0, at);
  return { name, id: `${name}@${key.slice(at + 1).split('(')[0]}` };
}

/** A lockfile reference to this checkout: a link whose path, from the lockfile's folder, is the repository root. */
const isCheckout = (ref) =>
  typeof ref === 'string' && ref.startsWith('link:') && resolve(root, ref.slice('link:'.length)) === root;

/**
 * Every place a parsed pnpm-lock.yaml gives AgentOS from anywhere but this checkout.
 *
 * @param {any} lockfile pnpm-lock.yaml, parsed.
 * @returns {string[]} One line per place; empty when every AgentOS in the lockfile is this checkout.
 */
export function agentosFromElsewhere(lockfile) {
  const found = [];
  const self = lockfile.importers?.['.']?.devDependencies?.[AGENTOS];
  if (self?.specifier !== 'link:.' || !isCheckout(self?.version)) {
    found.push(`importers['.'].devDependencies['${AGENTOS}'] is ${JSON.stringify(self ?? null)}, not link:.`);
  }
  for (const id of Object.keys(lockfile.packages ?? {})) {
    if (splitKey(id).name === AGENTOS) found.push(`packages lists ${id}`);
  }
  for (const [key, snapshot] of Object.entries(lockfile.snapshots ?? {})) {
    const { name, id } = splitKey(key);
    const ref = snapshot?.dependencies?.[AGENTOS] ?? snapshot?.optionalDependencies?.[AGENTOS];
    if (ref !== undefined) {
      if (!isCheckout(ref)) found.push(`${key} resolves ${AGENTOS} to ${ref}`);
    } else if (isCurated(name) && lockfile.packages?.[id]?.peerDependencies?.[AGENTOS] !== undefined) {
      found.push(`${key} leaves its ${AGENTOS} peer unresolved`);
    }
  }
  return found;
}

/** The real folder Node's lookup from a package's folder finds for `name`, or null when it finds none. */
function locate(fromDir, name) {
  const lookup = createRequire(join(fromDir, 'package.json')).resolve.paths(name) ?? [];
  for (const modulesDir of lookup) {
    const candidate = join(modulesDir, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return null;
}

test('the check flags a lockfile that gives the curated extensions a published AgentOS', () => {
  // The shape master's lockfile had: AgentOS 0.13.49 installed for the registry's and the extensions' peers.
  const lockfile = parse(`
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@framers/agentos-extensions-registry':
        specifier: ^0.18.12
        version: 0.18.12(@framers/agentos@0.13.49)
packages:
  '@framers/agentos-extensions-registry@0.18.12':
    resolution: {integrity: sha512-registry}
    peerDependencies:
      '@framers/agentos': '>=0.10.34'
    peerDependenciesMeta:
      '@framers/agentos':
        optional: true
  '@framers/agentos-ext-github@0.3.1':
    resolution: {integrity: sha512-github}
    peerDependencies:
      '@framers/agentos': '>=0.13.144'
  '@framers/agentos-ext-web-search@1.3.2':
    resolution: {integrity: sha512-web-search}
    peerDependencies:
      '@framers/agentos': '>=0.10.40'
  '@framers/agentos@0.13.49':
    resolution: {integrity: sha512-agentos}
snapshots:
  '@framers/agentos-extensions-registry@0.18.12(@framers/agentos@0.13.49)':
    optionalDependencies:
      '@framers/agentos': 0.13.49
      '@framers/agentos-ext-github': 0.3.1(@framers/agentos@0.13.49)
      '@framers/agentos-ext-web-search': 1.3.2
  '@framers/agentos-ext-github@0.3.1(@framers/agentos@0.13.49)':
    dependencies:
      '@framers/agentos': 0.13.49
    optional: true
  '@framers/agentos-ext-web-search@1.3.2':
    optional: true
  '@framers/agentos@0.13.49':
    optional: true
`);
  assert.deepEqual(agentosFromElsewhere(lockfile), [
    `importers['.'].devDependencies['@framers/agentos'] is null, not link:.`,
    'packages lists @framers/agentos@0.13.49',
    '@framers/agentos-extensions-registry@0.18.12(@framers/agentos@0.13.49) resolves @framers/agentos to 0.13.49',
    '@framers/agentos-ext-github@0.3.1(@framers/agentos@0.13.49) resolves @framers/agentos to 0.13.49',
    '@framers/agentos-ext-web-search@1.3.2 leaves its @framers/agentos peer unresolved',
  ]);
});

test('pnpm-lock.yaml resolves every AgentOS peer to this checkout', () => {
  const lockfile = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(agentosFromElsewhere(lockfile), []);
  const curated = Object.keys(lockfile.snapshots ?? {}).map((key) => splitKey(key).name).filter(isCurated);
  assert.ok(curated.includes(REGISTRY), `pnpm-lock.yaml has no snapshot of ${REGISTRY}`);
  assert.ok(curated.length > 1, 'pnpm-lock.yaml has no snapshot of a curated extension');
});

test('the installed registry and extensions import AgentOS from this checkout', () => {
  const checkout = realpathSync(root);
  const wrong = [];
  const checked = [];
  const visited = new Set();
  const queue = [[checkout, REGISTRY]];
  while (queue.length > 0) {
    const [fromDir, name] = queue.shift();
    const dir = locate(fromDir, name);
    if (dir === null || visited.has(dir)) continue;
    visited.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    if (AGENTOS in declared) {
      const agentos = locate(dir, AGENTOS);
      checked.push(manifest.name);
      if (agentos !== checkout) {
        wrong.push(`${manifest.name}@${manifest.version} imports ${AGENTOS} from ${agentos ?? 'nowhere'}`);
      }
    }
    for (const dependency of Object.keys(declared)) {
      if (isCurated(dependency)) queue.push([dir, dependency]);
    }
  }
  assert.ok(checked.includes(REGISTRY), `${REGISTRY} is not installed, or declares no ${AGENTOS}`);
  assert.ok(checked.length > 1, 'no curated extension that declares AgentOS is installed');
  assert.deepEqual(wrong, []);
});
