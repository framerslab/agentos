import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Entries resolve as this ESM consumer imports them: account-sources exports "." only under "import",
// a condition require.resolve never matches.
const entryOf = (specifier: string): string => fileURLToPath(import.meta.resolve(specifier));
const base = realpathSync(process.cwd());
const specs = [
  ['@framers/agentos', '@framers/agentos/cognition/rag', process.env.CORE_VERSION],
  ['@framers/agentos-ext-account-sources', '@framers/agentos-ext-account-sources', process.env.AS_VERSION],
  ['@framers/sql-storage-adapter', '@framers/sql-storage-adapter', process.env.ADAPTER_VERSION],
] as const;
function rootOf(entry: string, name: string): string {
  let directory = dirname(realpathSync(entry));
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory;
    const parent = dirname(directory); assert.notEqual(parent, directory, 'package_root_missing'); directory = parent;
  }
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
};
const roots = new Map<string, string>();
const records: Array<{ name: string; version: string; resolved: string; integrity: string; gitHead: string | null }> = [];
for (const [name, specifier, version] of specs) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  const root = rootOf(entryOf(specifier), name); roots.set(name, root);
  const location = relative(base, root);
  assert.equal(isAbsolute(location), false); assert.equal(location.startsWith('..'), false);
  assert.equal(location.replaceAll('\\', '/'), `node_modules/${name}`);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  const installed = lock.packages[`node_modules/${name}`]; assert.ok(installed);
  assert.equal(installed.link, undefined); assert.equal(installed.version, version);
  assert.match(installed.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//);
  assert.ok(installed.integrity);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  assert.equal(response.status, 200, 'immutable_registry_version_unavailable');
  const metadata = await response.json() as {
    name: string; version: string; gitHead?: string; dist: { integrity?: string; tarball?: string };
  };
  assert.equal(metadata.name, name); assert.equal(metadata.version, version);
  assert.equal(metadata.dist.integrity, installed.integrity);
  assert.equal(metadata.dist.tarball, installed.resolved);
  records.push({ name, version: version!, resolved: installed.resolved!, integrity: installed.integrity!,
    gitHead: metadata.gitHead ?? null });
}
const extensionRequire = createRequire(entryOf('@framers/agentos-ext-account-sources'));
assert.equal(rootOf(extensionRequire.resolve('@framers/agentos/cognition/library'), '@framers/agentos'), roots.get('@framers/agentos'));
assert.equal(rootOf(extensionRequire.resolve('@framers/sql-storage-adapter'), '@framers/sql-storage-adapter'), roots.get('@framers/sql-storage-adapter'));
const coreRequire = createRequire(entryOf('@framers/agentos/cognition/rag'));
assert.equal(rootOf(coreRequire.resolve('@framers/sql-storage-adapter'), '@framers/sql-storage-adapter'), roots.get('@framers/sql-storage-adapter'));
writeFileSync('registry-evidence.json', JSON.stringify({
  repository: process.env.GITHUB_REPOSITORY, workflowSha: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, records,
}, null, 2) + '\n');
