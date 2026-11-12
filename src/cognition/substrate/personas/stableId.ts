/**
 * @module personas/stableId
 * A stable id from a name: the same at every build, and never empty.
 */
import { createHash } from 'node:crypto';

/**
 * A lowercase ASCII slug of `name`, or, for a name with no Latin letters or digits, `agent-` and a hash of the name.
 *
 * @param name - The name; not blank.
 */
export function stableIdOfName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `agent-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
