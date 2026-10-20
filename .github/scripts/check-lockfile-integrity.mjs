#!/usr/bin/env node
// @ts-check
/**
 * Fails when a refreshed pnpm-lock.yaml drops or changes the integrity that the lockfile it replaces pins on a package
 * entry both of them keep.
 *
 * pnpm writes a git-hosted tarball's integrity into the lockfile only when it downloads the tarball, and it installs an
 * entry that has none. The bump workflow's refresh resolves a git dependency of a dependency (libsignal, which
 * @whiskeysockets/baileys names as git+https://github.com/whiskeysockets/libsignal-node.git) again on every run, so a
 * refresh whose pnpm store already holds the package writes its entry without the integrity. Pull request 559 was
 * refreshed on a store the Actions cache restored and took libsignal's integrity out of master's lockfile, where it had
 * been since 5 October 2026, and every install after it passed. In pnpm 10.34.7 (https://github.com/pnpm/pnpm/tree/v10.34.7):
 * - pkg-manager/resolve-dependencies/src/resolveDependencies.ts lines 1101-1121 and 1167-1171: the lockfile entry of a
 *   dependency's dependency is reused only when its version satisfies the wanted specifier, which a git specifier does
 *   not unless a project of the workspace names the same one;
 * - resolving/git-resolver/src/index.ts line 45: the git resolver returns { tarball, gitHosted: true }, no integrity;
 * - pkg-manager/package-requester/src/packageRequester.ts lines 356-362: the integrity is taken from the fetch, and a
 *   package read from the store (lines 603-616) comes back without one, where a download (lines 665-680) has one;
 * - pkg-manager/resolve-dependencies/src/updateLockfile.ts line 189: a resolution without one is written as it is;
 * - lockfile/utils/src/pkgSnapshotToResolution.ts lines 17-38: a git-hosted entry installs without one.
 *
 * The check reads the packages section of each file and compares the entries both have; an entry the refresh removed
 * went with the bump and is not compared. It exits 0 when every such entry has the integrity it had (one the refresh
 * adds an integrity to is reported), 1 when one lost or changed its integrity, and 2 when a file cannot be read or has
 * no package entries.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node .github/scripts/check-lockfile-integrity.mjs <lockfile before> <lockfile after>';

/**
 * A key as the YAML spells it, unquoted: pnpm quotes a key that starts with @ ('@scope/name@1.0.0').
 * @param {string} raw
 */
function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * The integrity at the top level of a resolution written as a flow mapping ({integrity: ..., tarball: ...}), or null.
 * One nested in it (a variant's) is not the entry's.
 * @param {string} flow
 */
function flowIntegrity(flow) {
  let depth = 0;
  for (let k = 0; k < flow.length; k++) {
    const c = flow[k];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && /[{,\s]/.test(flow[k - 1] ?? '') && flow.startsWith('integrity:', k)) {
      return /^integrity:\s*(['"]?)([^'",{}[\]\s]+)\1/.exec(flow.slice(k))?.[2] ?? null;
    }
  }
  return null;
}

/**
 * The integrity each entry of a pnpm lockfile's packages section pins, by the entry's key; null for an entry whose
 * resolution names none. pnpm writes a resolution as a flow mapping on the line of its key; a block mapping's own
 * integrity line, two spaces deeper, is read too.
 * @param {string} text the lockfile
 * @returns {Map<string, string | null>}
 */
export function packageIntegrities(text) {
  /** @type {Map<string, string | null>} */
  const entries = new Map();
  let inPackages = false;
  /** @type {string | null} */
  let key = null;
  let inResolutionBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - trimmed.length;
    if (indent === 0) {
      inPackages = /^packages:\s*$/.test(line);
      key = null;
      inResolutionBlock = false;
    } else if (!inPackages) {
      continue;
    } else if (indent === 2) {
      const match = /^ {2}(\S.*?):(?:\s.*)?$/.exec(line);
      key = match ? unquote(match[1]) : null;
      if (key !== null) entries.set(key, null);
      inResolutionBlock = false;
    } else if (key === null) {
      continue;
    } else if (indent === 4) {
      const resolution = /^ {4}resolution:(.*)$/.exec(line);
      const value = resolution ? resolution[1].trim() : '';
      inResolutionBlock = resolution !== null && value === '';
      if (resolution !== null && value.startsWith('{')) entries.set(key, flowIntegrity(value));
    } else if (indent === 6 && inResolutionBlock) {
      const integrity = /^integrity:\s*(['"]?)(\S+?)\1\s*$/.exec(trimmed);
      if (integrity) entries.set(key, integrity[2]);
    }
  }
  return entries;
}

/**
 * The entries both lockfiles have whose integrity the second lost, changed or gained.
 * @param {Map<string, string | null>} before
 * @param {Map<string, string | null>} after
 */
export function compareIntegrities(before, after) {
  /** @type {Array<{ key: string, before: string }>} */
  const lost = [];
  /** @type {Array<{ key: string, before: string, after: string }>} */
  const changed = [];
  /** @type {Array<{ key: string, after: string }>} */
  const gained = [];
  for (const [key, was] of before) {
    if (!after.has(key)) continue;
    const now = after.get(key) ?? null;
    if (was !== null && now === null) lost.push({ key, before: was });
    else if (was !== null && now !== null && was !== now) changed.push({ key, before: was, after: now });
    else if (was === null && now !== null) gained.push({ key, after: now });
  }
  return { lost, changed, gained };
}

/**
 * A workflow command's property or message, escaped as GitHub reads it.
 * @param {string} text
 * @param {boolean} [property]
 */
function escaped(text, property = false) {
  const data = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return property ? data.replaceAll(':', '%3A').replaceAll(',', '%2C') : data;
}

/** @param {string[]} argv */
function main(argv) {
  if (argv.length !== 2 || argv.some((a) => a.startsWith('-'))) {
    console.error(USAGE);
    return 2;
  }
  /** @type {Array<Map<string, string | null>>} */
  const read = [];
  for (const file of argv) {
    let text;
    try {
      text = readFileSync(resolve(file), 'utf8');
    } catch (error) {
      console.error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const entries = packageIntegrities(text);
    if (entries.size === 0) {
      console.error(`${file} has no package entries: no packages section was read, so there is nothing to compare.`);
      return 2;
    }
    read.push(entries);
  }
  const [before, after] = read;
  const { lost, changed, gained } = compareIntegrities(before, after);
  for (const { key, after: now } of gained) console.log(`${key}: the refresh pins integrity ${now}, which ${argv[0]} did not have.`);
  const findings = [
    ...lost.map(({ key, before: was }) => `${key}: the refresh dropped integrity ${was}.`),
    ...changed.map(({ key, before: was, after: now }) => `${key}: the refresh changed integrity ${was} to ${now}.`),
  ];
  for (const message of findings) {
    console.log(message);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error file=${escaped(argv[1], true)}::${escaped(message)}`);
  }
  if (findings.length > 0) {
    console.error(
      `${findings.length} ${findings.length === 1 ? 'entry' : 'entries'} of ${argv[1]} lost or changed the integrity ${argv[0]} pins. ` +
        "pnpm writes a git-hosted tarball's integrity only when it downloads the tarball, so a refresh on a pnpm store that already " +
        'holds the package leaves it out; refresh on an empty store. A changed integrity means the same entry came with other bytes.'
    );
    return 1;
  }
  const kept = [...before].filter(([key, was]) => was !== null && after.get(key) === was).length;
  console.log(`Every integrity ${argv[0]} pins on an entry ${argv[1]} kept is there (${kept} entries).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
