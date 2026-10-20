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
 * The account-source connectors (calendar-google, google-drive, github) also declare
 * @framers/agentos-ext-account-sources as a peer. When pnpm installs a missing peer itself, it
 * takes the newest version of that package the lockfile already holds, whether or not the peer's
 * range admits it, and only warns: a lockfile holding account-sources 0.7.2 gave it to
 * calendar-google 1.0.3, whose range is >=0.9.0. package.json pins account-sources as a dev
 * dependency, which the weekly bump keeps at the newest release, and pnpm resolves those peers to it.
 *
 * The checks of this repository need an install and no build: two read pnpm-lock.yaml (every
 * AgentOS is this checkout; every other first-party peer of a curated package is inside its range),
 * the third follows Node's module lookup from each installed curated package to the AgentOS it would
 * import, and fails on a curated package the lockfile lists that the install lacks. Each has a
 * fixture in the shape it guards against, so none can pass by checking nothing.
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

/** A first-party peer whose range the lockfile check reads: any @framers/* package but AgentOS, checked on its own. */
const isFirstPartyPeer = (peer) => peer.startsWith('@framers/') && peer !== AGENTOS;

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

/** A release version (`1.2.3`) as its three numbers, or null for anything else (a prerelease, a link). */
function release(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? null : match.slice(1, 4).map(Number);
}

/**
 * Whether a release version is inside a node-semver range, for the forms first-party peers are written in: `*`, and
 * a full version alone or after `=`, `>`, `>=`, `<`, `<=`, `^` or `~`, the comparators of a set joined by spaces and
 * the sets by `||`.
 *
 * @param {string} version A release version, such as `0.9.3`.
 * @param {string} range The range a package declares, such as `>=0.9.0`.
 * @returns {boolean} True when the version satisfies the range.
 * @throws {Error} When the version is not a release or the range holds a form this check cannot read, so a peer it
 *   cannot judge fails the test instead of passing it.
 */
export function inRange(version, range) {
  const v = release(version);
  if (v === null) throw new Error(`${version} is not a release version`);
  const sets = range.split('||').map((set) => set.trim().replace(/(>=|<=|[<>=^~])\s+/g, '$1').split(/\s+/)
    .filter((comparator) => comparator !== '' && comparator !== '*')
    .map((comparator) => {
      const match = /^(>=|<=|[<>=^~])?v?(\d+)\.(\d+)\.(\d+)$/.exec(comparator);
      if (match === null) throw new Error(`the range ${range} holds a comparator this check cannot read: ${comparator}`);
      return { op: match[1] ?? '=', bound: match.slice(2, 5).map(Number) };
    }));
  return sets.some((set) => set.every(({ op, bound }) => {
    const order = v[0] - bound[0] || v[1] - bound[1] || v[2] - bound[2];
    switch (op) {
      case '>': return order > 0;
      case '>=': return order >= 0;
      case '<': return order < 0;
      case '<=': return order <= 0;
      case '~': return order >= 0 && v[0] === bound[0] && v[1] === bound[1];
      // The first nonzero part stays: ^1.2.3 is below 2.0.0, ^0.9.0 below 0.10.0, ^0.0.3 below 0.0.4.
      case '^': return order >= 0 && v[0] === bound[0]
        && (bound[0] > 0 || (v[1] === bound[1] && (bound[1] > 0 || v[2] === bound[2])));
      default: return order === 0;
    }
  }));
}

/**
 * Every place a parsed pnpm-lock.yaml gives a curated package a first-party peer outside the range the package
 * declares, or leaves a required one unresolved. The AgentOS peer is agentosFromElsewhere's.
 *
 * @param {any} lockfile pnpm-lock.yaml, parsed.
 * @returns {string[]} One line per place; empty when every such peer resolves inside its range.
 */
export function firstPartyPeersOutOfRange(lockfile) {
  const found = [];
  for (const [key, snapshot] of Object.entries(lockfile.snapshots ?? {})) {
    const { name, id } = splitKey(key);
    if (!isCurated(name)) continue;
    const pkg = lockfile.packages?.[id] ?? {};
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!isFirstPartyPeer(peer)) continue;
      const ref = snapshot?.dependencies?.[peer] ?? snapshot?.optionalDependencies?.[peer];
      if (ref === undefined) {
        if (!pkg.peerDependenciesMeta?.[peer]?.optional) found.push(`${key} leaves its ${peer} peer unresolved`);
        continue;
      }
      const version = String(ref).split('(')[0];
      if (release(version) === null) found.push(`${key} resolves ${peer} to ${ref}, not a release version`);
      else if (!inRange(version, String(range))) found.push(`${key} resolves ${peer} to ${version}, outside ${range}`);
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

test('the range check reads the forms first-party peers are written in, and refuses any other', () => {
  const cases = [
    ['0.9.3', '>=0.9.0', true],
    ['0.7.2', '>=0.9.0', false],
    ['0.7.2', '>=0.7.0', true],
    ['0.9.3', '^0.9.0', true],
    ['0.10.0', '^0.9.0', false],
    ['1.4.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['0.9.3', '>=0.8.0 <0.9.0 || >= 0.9.2', true],
    ['0.9.1', '>=0.8.0 <0.9.0 || >=0.9.2', false],
    ['0.9.3', '0.9.3', true],
    ['0.9.3', '*', true],
  ];
  for (const [version, range, inside] of cases) assert.equal(inRange(version, range), inside, `${version} in ${range}`);
  assert.throws(() => inRange('0.9.3', '0.9.x'), /cannot read: 0\.9\.x/);
  assert.throws(() => inRange('0.9.3', '0.8.0 - 0.9.0'), /cannot read: -/);
  assert.throws(() => inRange('link:', '>=0.9.0'), /not a release version/);
});

test('the check flags a lockfile that gives a curated extension a first-party peer outside its range', () => {
  // The shape pull request 574's lockfile had: account-sources 0.7.2, the version the lockfile held, installed for
  // calendar-google 1.0.3 (>=0.9.0) and google-drive 1.2.0 (>=0.8.0), and in range for github 0.5.0 (>=0.7.0). The
  // last extension leaves a required first-party peer unresolved, and an optional one, which is not flagged.
  const sources = '0.7.2(@framers/agentos@)(better-sqlite3@13.0.3)(pg@8.23.1)';
  const peers = `(@framers/agentos-ext-account-sources@${sources})(@framers/agentos@)`;
  const lockfile = parse(`
lockfileVersion: '9.0'
packages:
  '@framers/agentos-ext-account-sources@0.7.2':
    resolution: {integrity: sha512-account-sources}
    peerDependencies:
      '@framers/agentos': '>=0.13.134'
  '@framers/agentos-ext-calendar-google@1.0.3':
    resolution: {integrity: sha512-calendar-google}
    peerDependencies:
      '@framers/agentos': '>=0.13.144'
      '@framers/agentos-ext-account-sources': '>=0.9.0'
  '@framers/agentos-ext-github@0.5.0':
    resolution: {integrity: sha512-github}
    peerDependencies:
      '@framers/agentos': '>=0.13.144'
      '@framers/agentos-ext-account-sources': '>=0.7.0'
  '@framers/agentos-ext-google-drive@1.2.0':
    resolution: {integrity: sha512-google-drive}
    peerDependencies:
      '@framers/agentos': '>=0.13.144'
      '@framers/agentos-ext-account-sources': '>=0.8.0'
  '@framers/agentos-ext-unresolved@1.0.0':
    resolution: {integrity: sha512-unresolved}
    peerDependencies:
      '@framers/agentos': '>=0.13.144'
      '@framers/agentos-ext-account-sources': '>=0.9.0'
      '@framers/agentos-ext-optional': '>=1.0.0'
    peerDependenciesMeta:
      '@framers/agentos-ext-optional':
        optional: true
snapshots:
  '@framers/agentos-ext-account-sources@${sources}':
    dependencies:
      '@framers/agentos': 'link:'
    optional: true
  '@framers/agentos-ext-calendar-google@1.0.3${peers}':
    dependencies:
      '@framers/agentos': 'link:'
      '@framers/agentos-ext-account-sources': ${sources}
      '@framers/agentos-ext-google-drive': 1.2.0${peers}
    optional: true
  '@framers/agentos-ext-github@0.5.0${peers}':
    dependencies:
      '@framers/agentos': 'link:'
      '@framers/agentos-ext-account-sources': ${sources}
    optional: true
  '@framers/agentos-ext-google-drive@1.2.0${peers}':
    dependencies:
      '@framers/agentos': 'link:'
      '@framers/agentos-ext-account-sources': ${sources}
    optional: true
  '@framers/agentos-ext-unresolved@1.0.0(@framers/agentos@)':
    dependencies:
      '@framers/agentos': 'link:'
    optional: true
`);
  assert.deepEqual(firstPartyPeersOutOfRange(lockfile), [
    `@framers/agentos-ext-calendar-google@1.0.3${peers} resolves @framers/agentos-ext-account-sources to 0.7.2, outside >=0.9.0`,
    `@framers/agentos-ext-google-drive@1.2.0${peers} resolves @framers/agentos-ext-account-sources to 0.7.2, outside >=0.8.0`,
    '@framers/agentos-ext-unresolved@1.0.0(@framers/agentos@) leaves its @framers/agentos-ext-account-sources peer unresolved',
  ]);
});

test('pnpm-lock.yaml resolves every first-party peer of a curated package inside its range', () => {
  const lockfile = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(firstPartyPeersOutOfRange(lockfile), []);
  const withPeers = Object.keys(lockfile.snapshots ?? {}).map(splitKey).filter(({ name, id }) =>
    isCurated(name) && Object.keys(lockfile.packages?.[id]?.peerDependencies ?? {}).some(isFirstPartyPeer));
  assert.ok(withPeers.length > 0, 'pnpm-lock.yaml has no curated package with a first-party peer besides AgentOS');
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
