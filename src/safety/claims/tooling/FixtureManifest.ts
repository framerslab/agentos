/**
 * @module safety/claims/tooling/FixtureManifest
 *
 * Approved synthetic content for captures and tests: each file's path, hash and purpose, and the uses the manifest is
 * approved for. A capture or test that reads a file the manifest does not name, a file whose bytes changed, or a
 * manifest not approved for that use, fails; the manifest's digest goes into every capture manifest made with it.
 */
import { digestOf } from '../digest.js';

/** What a fixture file is for. */
export type FixturePurpose = 'synthetic-notes' | 'speech-recording' | 'provider-response' | 'configuration';

/** One approved file. */
export interface FixtureFile {
  path: string;
  /** The SHA-256 of the approved bytes, in lower-case hex. */
  sha256: string;
  purpose: FixturePurpose;
}

/** An approved set of fixture files. */
export interface FixtureManifest {
  id: string;
  files: readonly FixtureFile[];
  /** The uses the files are approved for. */
  approvedFor: readonly ('capture' | 'test')[];
}

/**
 * The problems of a manifest against the files as they are.
 *
 * @param manifest - The manifest.
 * @param actual - Each file's hash as read, by path.
 * @param use - The use the files are about to serve.
 * @returns The problems; none when the use is approved and the files read are exactly the approved ones.
 */
export function validateFixtureManifest(manifest: FixtureManifest, actual: ReadonlyMap<string, string>, use: 'capture' | 'test'): string[] {
  const problems: string[] = [];
  if (!manifest.approvedFor.includes(use)) problems.push(`the fixture is not approved for ${use}`);
  const named = new Set<string>();
  for (const file of manifest.files) {
    if (named.has(file.path)) problems.push(`${file.path}: named twice`);
    named.add(file.path);
    const read = actual.get(file.path);
    if (read === undefined) problems.push(`${file.path}: the file is missing`);
    else if (read !== file.sha256) problems.push(`${file.path}: the file is not the approved one`);
  }
  for (const path of actual.keys()) if (!named.has(path)) problems.push(`${path}: read but not approved`);
  return problems;
}

/** The manifest's digest: its id and files. */
export function fixtureDigest(manifest: FixtureManifest): string {
  return digestOf({ id: manifest.id, files: manifest.files });
}
