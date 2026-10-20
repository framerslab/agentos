// @ts-check
// Runs in CI (node --test).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareIntegrities, packageIntegrities } from './check-lockfile-integrity.mjs';

const script = fileURLToPath(new URL('./check-lockfile-integrity.mjs', import.meta.url));

const LIBSIGNAL_TARBALL = 'https://codeload.github.com/whiskeysockets/libsignal-node/tar.gz/bcea72df9ec34d9d9140ab30619cf479c7c144c7';
const LIBSIGNAL = `libsignal@${LIBSIGNAL_TARBALL}`;
const LIBSIGNAL_INTEGRITY = 'sha512-KmRMuAYSfd4upRD0xOgKbURxRXNE8X8NtgmkUOJFXOn9ESSCXguIZ7PJu8OBJIr7KGww41Vf/Pbgko+PgWQ55g==';
const ADAPTER_0_7_14 = 'sha512-MXERr9rLdppu6cXWo1T6hBxJVzFKS03tKzWtHeugB7d/UNdegIOomflolCH9/5ogr69M61YTm4cdyNKj08em8A==';
const ADAPTER_0_8_1 = 'sha512-Zcw3ChiT19XH+JWJI+9SBm0YbqhKoeLOT1KbNp1BVB6NQ9qexDhRj1FIka2nlkIZ9rlMKVqlQVbXD2MoY2nT6Q==';
const LIE = 'sha512-UaiMJzeWRlEujzAuw5LokY1L5ecNQYZKfmyZ9L7wDHb/p5etKaxXhohBcrw0EYby+G/NA52vRSN4N39dxHAIwQ==';

/**
 * A lockfile as pnpm 10 writes it, cut down to the entries pull request 559 changed: the storage adapter it bumped and
 * libsignal, a git dependency of @whiskeysockets/baileys. Its snapshots section repeats libsignal's key with no
 * resolution, as pnpm's does.
 * @param {{ adapter: string, adapterIntegrity: string, libsignalResolution: string }} at
 */
const lockfile = ({ adapter, adapterIntegrity, libsignalResolution }) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@framers/sql-storage-adapter':
        specifier: ^${adapter}
        version: ${adapter}(better-sqlite3@13.0.3)

packages:

  '@framers/sql-storage-adapter@${adapter}':
    resolution: {integrity: ${adapterIntegrity}}
    peerDependencies:
      better-sqlite3: ^12.0.0 || ^13.0.0
    peerDependenciesMeta:
      better-sqlite3:
        optional: true

  ${LIBSIGNAL}:
    resolution: ${libsignalResolution}
    version: 6.0.0

  lie@3.3.0:
    resolution: {integrity: ${LIE}}

snapshots:

  '@framers/sql-storage-adapter@${adapter}(better-sqlite3@13.0.3)':
    dependencies:
      sql.js: 1.14.2

  ${LIBSIGNAL}:
    dependencies:
      curve25519-js: 0.0.4
    optional: true

  lie@3.3.0:
    dependencies:
      immediate: 3.0.6
`;

const WITH_LIBSIGNAL_INTEGRITY = `{gitHosted: true, integrity: ${LIBSIGNAL_INTEGRITY}, tarball: ${LIBSIGNAL_TARBALL}}`;
const WITHOUT_LIBSIGNAL_INTEGRITY = `{gitHosted: true, tarball: ${LIBSIGNAL_TARBALL}}`;

// pnpm-lock.yaml on master before pull request 559 (blob 73357622) and as that pull request merged it (blob 7f416390):
// the adapter moved from 0.7.14 to 0.8.1, and libsignal's entry stayed with its integrity gone.
const MASTER_BEFORE_559 = lockfile({ adapter: '0.7.14', adapterIntegrity: ADAPTER_0_7_14, libsignalResolution: WITH_LIBSIGNAL_INTEGRITY });
const PULL_REQUEST_559 = lockfile({ adapter: '0.8.1', adapterIntegrity: ADAPTER_0_8_1, libsignalResolution: WITHOUT_LIBSIGNAL_INTEGRITY });
// The same bump refreshed on an empty pnpm store, which downloads libsignal and pins its integrity again.
const REFRESHED_ON_AN_EMPTY_STORE = lockfile({ adapter: '0.8.1', adapterIntegrity: ADAPTER_0_8_1, libsignalResolution: WITH_LIBSIGNAL_INTEGRITY });

describe('packageIntegrities', () => {
  test('reads each entry of the packages section by its key, and nothing from importers or snapshots', () => {
    assert.deepEqual(
      packageIntegrities(MASTER_BEFORE_559),
      new Map([
        ['@framers/sql-storage-adapter@0.7.14', ADAPTER_0_7_14],
        [LIBSIGNAL, LIBSIGNAL_INTEGRITY],
        ['lie@3.3.0', LIE],
      ])
    );
  });

  test('reads an entry whose resolution names no integrity as null', () => {
    assert.equal(packageIntegrities(PULL_REQUEST_559).get(LIBSIGNAL), null);
  });

  test('reads a resolution written as a block mapping, and no integrity nested below it', () => {
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      '  foo@1.0.0:',
      '    resolution:',
      '      integrity: sha512-Zm9v',
      '      tarball: https://registry.example.com/foo/-/foo-1.0.0.tgz',
      "    engines: {node: '>=18'}",
      '',
      '  node@runtime:22.0.0:',
      '    resolution:',
      '      type: variations',
      '      variants:',
      '        - resolution:',
      '            integrity: sha256-bm9kZQ==',
      '            type: binary',
      '          targets:',
      '            - cpu: x64',
      '              os: linux',
      '    version: 22.0.0',
      '',
      '  "quoted@1.0.0":',
      "    resolution: {integrity: 'sha512-cXVvdGVk'}",
      '',
    ].join('\n');
    assert.deepEqual(
      packageIntegrities(text),
      new Map([
        ['foo@1.0.0', 'sha512-Zm9v'],
        ['node@runtime:22.0.0', null],
        ['quoted@1.0.0', 'sha512-cXVvdGVk'],
      ])
    );
  });

  test('does not read an integrity from a field other than the resolution', () => {
    const text = [
      'packages:',
      '',
      '  old@1.0.0:',
      '    resolution: {tarball: https://example.com/old.tgz}',
      '    deprecated: |-',
      '      integrity: sha512-bm90LXRoaXM=',
      '',
    ].join('\n');
    assert.deepEqual(packageIntegrities(text), new Map([['old@1.0.0', null]]));
  });
});

describe('compareIntegrities', () => {
  test("names libsignal's entry, which pull request 559 kept and took the integrity from", () => {
    const { lost, changed, gained } = compareIntegrities(packageIntegrities(MASTER_BEFORE_559), packageIntegrities(PULL_REQUEST_559));
    assert.deepEqual(lost, [{ key: LIBSIGNAL, before: LIBSIGNAL_INTEGRITY }]);
    assert.deepEqual(changed, []);
    assert.deepEqual(gained, []);
  });

  test('passes a bump that replaces an entry with a new version and keeps every other integrity', () => {
    const { lost, changed, gained } = compareIntegrities(packageIntegrities(MASTER_BEFORE_559), packageIntegrities(REFRESHED_ON_AN_EMPTY_STORE));
    assert.deepEqual([lost, changed, gained], [[], [], []]);
  });

  test("reports libsignal's integrity coming back on master's lockfile as 559 left it", () => {
    const { lost, changed, gained } = compareIntegrities(packageIntegrities(PULL_REQUEST_559), packageIntegrities(REFRESHED_ON_AN_EMPTY_STORE));
    assert.deepEqual([lost, changed], [[], []]);
    assert.deepEqual(gained, [{ key: LIBSIGNAL, after: LIBSIGNAL_INTEGRITY }]);
  });

  test('names an entry whose integrity changed under the same key', () => {
    const before = new Map([[LIBSIGNAL, LIBSIGNAL_INTEGRITY]]);
    const after = new Map([[LIBSIGNAL, 'sha512-ZGlmZmVyZW50']]);
    assert.deepEqual(compareIntegrities(before, after).changed, [{ key: LIBSIGNAL, before: LIBSIGNAL_INTEGRITY, after: 'sha512-ZGlmZmVyZW50' }]);
  });
});

describe('check-lockfile-integrity.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-integrity-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  /**
   * @param {string} name
   * @param {string} text
   */
  const file = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const master = file('master.yaml', MASTER_BEFORE_559);
  const merged = file('pull-request-559.yaml', PULL_REQUEST_559);
  const refreshed = file('refreshed.yaml', REFRESHED_ON_AN_EMPTY_STORE);
  /**
   * @param {string[]} args
   * @param {Record<string, string>} [env]
   */
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });

  test("fails pull request 559's refresh and names the entry and the integrity it dropped", () => {
    const result = run([master, merged]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`${LIBSIGNAL}: the refresh dropped integrity ${LIBSIGNAL_INTEGRITY}.`), result.stdout);
  });

  test('writes an error annotation on the refreshed lockfile in GitHub Actions', () => {
    const result = run([master, merged], { GITHUB_ACTIONS: 'true' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error file=.*pull-request-559\.yaml::libsignal@https:\/\/codeload\.github\.com\//m);
  });

  test('passes a refresh that keeps every integrity, and reports one it adds', () => {
    assert.equal(run([master, refreshed]).status, 0);
    const result = run([merged, refreshed]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`${LIBSIGNAL}: the refresh pins integrity ${LIBSIGNAL_INTEGRITY}, which `), result.stdout);
  });

  test('exits 2 for a file it cannot read, a file with no package entries and a wrong number of arguments', () => {
    assert.equal(run([master, join(dir, 'missing.yaml')]).status, 2);
    assert.equal(run([master, file('empty.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n")]).status, 2);
    assert.equal(run([master]).status, 2);
  });
});
