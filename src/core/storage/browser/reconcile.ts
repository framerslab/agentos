/**
 * @fileoverview A server's list against the device's cache: what to fetch (new, or newer on the server) and what to
 * remove (deleted on the server, or missing from a complete list), never an entry with a change still held.
 * @module agentos/core/storage/browser/reconcile
 */

/** One cached entry: its id, the version the device holds, and whether a change to it waits in the outbox. */
export interface CachedEntry {
  /** The entry's id, the same on the device and the server. */
  id: string;
  /** The version of the copy the device holds. */
  version: number;
  /** True while a change to it is held for the server; such an entry is never removed. */
  pending: boolean;
}

/** The server's answer: its entries with their versions, the ids it deleted since the last list, and whether the list holds every entry. */
export interface ServerList {
  /** The entries the server names, each with its version there. */
  items: ReadonlyArray<{ id: string; version: number }>;
  /** The ids the server deleted since the device's last list. */
  deleted: readonly string[];
  /** True when `items` is every entry the server holds, so an entry it does not name is gone. */
  complete: boolean;
}

/**
 * What the device does next.
 *
 * @param local - The entries the device holds.
 * @param server - The server's list.
 * @returns `fetch`: the ids the server names that the device lacks or holds at a lower version, in the server's
 * order. `remove`: the ids the device holds with no change waiting that the server does not name and either lists
 * as deleted or, in a complete list, leaves out, in the device's order.
 */
export function reconcileList(local: readonly CachedEntry[], server: ServerList): { fetch: string[]; remove: string[] } {
  const held = new Map(local.map((entry) => [entry.id, entry]));
  const named = new Set(server.items.map((item) => item.id));
  const fetch = server.items
    .filter((item) => {
      const copy = held.get(item.id);
      return copy === undefined || copy.version < item.version;
    })
    .map((item) => item.id);
  const gone = new Set(server.deleted);
  const remove = local
    .filter((entry) => !entry.pending && !named.has(entry.id) && (gone.has(entry.id) || server.complete))
    .map((entry) => entry.id);
  return { fetch, remove };
}
