import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const version = process.env.PERSONAS_VERSION ?? '';
const merge = process.env.PERSONAS_MERGE ?? '';
const directory = process.env.PERSONAS_PACKAGE_DIR ?? '';
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.match(merge, /^[0-9a-f]{40}$/);
assert.ok(directory);
const [major, minor] = version.split('.').map(Number);
// The persona change is breaking, so only a new minor after the 0.14 line carries it; a 0.14.x patch is refused.
assert.ok(major! > 0 || minor! > 14, 'a new minor after 0.14.x is required');
const response = await fetch(`https://registry.npmjs.org/@framers%2Fagentos/${version}`);
assert.equal(response.status, 200, 'the exact release is not yet on the registry');
const metadata = await response.json() as {
  name: string; version: string; gitHead: string;
  dist: { tarball: string; integrity: string };
};
assert.equal(metadata.name, '@framers/agentos');
assert.equal(metadata.version, version);
assert.match(metadata.gitHead, /^[0-9a-f]{40}$/);
/** Runs one git command in the checkout and returns its trimmed output. */
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('rev-list', '-n', '1', `v${version}`), metadata.gitHead, 'tag and registry gitHead differ');
execFileSync('git', ['merge-base', '--is-ancestor', merge, metadata.gitHead]);
const tarball = new URL(metadata.dist.tarball);
assert.equal(tarball.origin, 'https://registry.npmjs.org');
assert.ok(tarball.pathname.startsWith('/@framers/agentos/-/'));
const packed = await fetch(tarball);
assert.equal(packed.status, 200);
const bytes = Buffer.from(await packed.arrayBuffer());
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
assert.ok(metadata.dist.integrity.split(/\s+/).includes(integrity), 'published tarball integrity mismatch');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'agentos.tgz'), bytes);
await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
await writeFile(join(directory, 'release.json'), JSON.stringify({
  version, gitHead: metadata.gitHead, merge, integrity, tarball: tarball.href,
}, null, 2));
const output = process.env.GITHUB_OUTPUT;
if (output) await appendFile(output, `version=${version}\ngitHead=${metadata.gitHead}\n`);
