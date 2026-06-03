/** @fileoverview Non-destructive MEMORY.md → memory/ migration. Idempotent. */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Guarantee a `memory/` directory exists in the workspace and return its path.
 *
 * - If `memory/` already exists, return it untouched (idempotent).
 * - Else if `MEMORY.md` exists, seed `memory/index.md` from it. `MEMORY.md` is
 *   left on disk as a fallback.
 * - Else create an empty `memory/` with a stub `index.md`.
 *
 * Always creates `.meta/index.json` if absent. Never modifies or deletes
 * `MEMORY.md`.
 *
 * @param workspaceDir - The per-agent workspace directory.
 * @returns Absolute path to the `memory/` directory.
 */
export function ensureMemoryDir(workspaceDir: string): string {
  const memoryDir = path.join(workspaceDir, 'memory');
  const indexPath = path.join(memoryDir, 'index.md');
  const metaDir = path.join(memoryDir, '.meta');
  const metaPath = path.join(metaDir, 'index.json');

  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  if (!fs.existsSync(indexPath)) {
    const legacy = path.join(workspaceDir, 'MEMORY.md');
    if (fs.existsSync(legacy)) {
      const body = fs.readFileSync(legacy, 'utf8');
      fs.writeFileSync(indexPath, `# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\n${body}\n`);
    } else {
      fs.writeFileSync(indexPath, '# Memory Index\n');
    }
  }

  if (!fs.existsSync(metaPath)) {
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ lastCompiledAt: null, pages: {} }, null, 2));
  }

  return memoryDir;
}
