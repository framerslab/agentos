/**
 * One-shot deprecation-warning helper for legacy subpath aliases.
 * Each (oldPath, newPath) pair warns at most once per process.
 *
 * Production builds suppress warnings; dev builds emit them so consumers
 * see them during local development without polluting deployed logs.
 */
const warned = new Set<string>();

export function warnDeprecated(oldPath: string, newPath: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (warned.has(oldPath)) return;
  warned.add(oldPath);
  // eslint-disable-next-line no-console
  console.warn(
    `[@framers/agentos] Subpath "${oldPath}" is deprecated. ` +
    `Use "${newPath}" instead. The deprecated subpath will be removed in 0.8.0.`
  );
}
