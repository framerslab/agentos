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
 * The checks of this repository need an install and no build: one reads pnpm-lock.yaml, the other
 * follows Node's module lookup from each installed curated package to the AgentOS it would import,
 * and fails on a curated package the lockfile lists that the install lacks. Each has a fixture in
 * the shape it guards against, so neither can pass by checking nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

/**
 * Walks the curated packages installed under a project, from its own curated dependencies through each
 * package's dependencies, optional dependencies and peers, and follows Node's lookup from each one that
 * declares AgentOS.
 *
 * @param {string} projectDir The project whose install to walk; it is the AgentOS each package must find.
 * @param {any} lockfile The project's pnpm-lock.yaml, parsed.
 * @param {string[]} skipped The dependency paths pnpm left out of the install
 *   (`skipped` in node_modules/.modules.yaml).
 * @returns {{ checked: string[], wrong: string[], missing: string[] }} The packages that declare AgentOS, those that
 *   find another AgentOS or none, and the curated packages the lockfile lists that are neither installed nor skipped.
 */
export function installedAgentOS(projectDir, lockfile, skipped) {
  const checkout = realpathSync(projectDir);
  const project = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  const own = { ...project.dependencies, ...project.devDependencies, ...project.optionalDependencies };
  const queue = Object.keys(own).filter(isCurated).map((name) => [checkout, name]);
  const visited = new Set();
  const installed = new Set();
  const checked = [];
  const wrong = [];
  while (queue.length > 0) {
    const [fromDir, name] = queue.shift();
    const dir = locate(fromDir, name);
    if (dir === null || visited.has(dir)) continue;
    visited.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const id = `${manifest.name}@${manifest.version}`;
    installed.add(id);
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    if (AGENTOS in declared) {
      const agentos = locate(dir, AGENTOS);
      checked.push(id);
      if (agentos !== checkout) wrong.push(`${id} imports ${AGENTOS} from ${agentos ?? 'nowhere'}`);
    }
    for (const dependency of Object.keys(declared)) {
      if (isCurated(dependency)) queue.push([dir, dependency]);
    }
  }
  const left = new Set(skipped.map((depPath) => splitKey(depPath.replace(/^\//, '')).id));
  const listed = new Set(
    Object.keys(lockfile.snapshots ?? {}).map(splitKey).filter(({ name }) => isCurated(name)).map(({ id }) => id),
  );
  const missing = [...listed].filter((id) => !installed.has(id) && !left.has(id));
  return { checked, wrong, missing };
}

/** Writes a package.json, making its folder. */
function writePackage(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
}

/** Makes `path` a symlink to the folder `target`, as pnpm links a package into node_modules. */
function link(path, target) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
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

test('the install check flags an extension that finds another AgentOS, and one listed but not installed', () => {
  // pnpm's layout in miniature: each package in its own folder of node_modules/.pnpm, its dependencies and
  // resolved peers linked beside it. One extension finds the project, one a published AgentOS; one listed
  // extension is missing, and one pnpm skipped (an optional package it cannot install here).
  const work = mkdtempSync(join(tmpdir(), 'curated-extensions-peer-'));
  try {
    const store = join(work, 'node_modules', '.pnpm');
    const peer = { [AGENTOS]: '*' };
    const extensions = ['current', 'stale', 'absent', 'skipped'].map((name) => `@framers/agentos-ext-${name}`);
    writePackage(work, {
      name: AGENTOS,
      version: '0.0.0',
      devDependencies: { [AGENTOS]: 'link:.', [REGISTRY]: '1.0.0' },
    });
    const registryModules = join(store, 'registry', 'node_modules');
    writePackage(join(registryModules, REGISTRY), {
      name: REGISTRY,
      version: '1.0.0',
      optionalDependencies: Object.fromEntries(extensions.map((name) => [name, '1.0.0'])),
      peerDependencies: peer,
    });
    link(join(work, 'node_modules', REGISTRY), join(registryModules, REGISTRY));
    link(join(registryModules, AGENTOS), work);
    for (const name of extensions.slice(0, 2)) {
      const modules = join(store, name.slice('@framers/'.length), 'node_modules');
      writePackage(join(modules, name), { name, version: '1.0.0', peerDependencies: peer });
      link(join(registryModules, name), join(modules, name));
    }
    link(join(store, 'agentos-ext-current', 'node_modules', AGENTOS), work);
    const published = join(store, 'agentos@0.13.49', 'node_modules', AGENTOS);
    writePackage(published, { name: AGENTOS, version: '0.13.49' });
    link(join(store, 'agentos-ext-stale', 'node_modules', AGENTOS), published);
    const lockfile = { snapshots: Object.fromEntries([REGISTRY, ...extensions].map((name) => [`${name}@1.0.0`, {}])) };

    assert.deepEqual(installedAgentOS(work, lockfile, ['@framers/agentos-ext-skipped@1.0.0']), {
      checked: [`${REGISTRY}@1.0.0`, '@framers/agentos-ext-current@1.0.0', '@framers/agentos-ext-stale@1.0.0'],
      wrong: [`@framers/agentos-ext-stale@1.0.0 imports ${AGENTOS} from ${realpathSync(published)}`],
      missing: ['@framers/agentos-ext-absent@1.0.0'],
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the installed registry and extensions import AgentOS from this checkout', () => {
  const lockfile = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const modules = parse(readFileSync(join(root, 'node_modules', '.modules.yaml'), 'utf8'));
  const { checked, wrong, missing } = installedAgentOS(root, lockfile, modules?.skipped ?? []);
  assert.ok(
    checked.some((id) => splitKey(id).name === REGISTRY),
    `${REGISTRY} is not installed, or declares no ${AGENTOS}`,
  );
  assert.ok(checked.length > 1, 'no curated extension that declares AgentOS is installed');
  assert.deepEqual(wrong, []);
  assert.deepEqual(missing, []);
});
