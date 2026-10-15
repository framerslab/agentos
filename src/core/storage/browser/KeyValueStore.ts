/**
 * @fileoverview A key-value store for a page: values are structured-cloneable, keys are listed and removed by
 * prefix. `namespaced` scopes one to a prefix, which keeps two users of one browser apart when neither's prefix
 * begins with the other's.
 * @module agentos/core/storage/browser/KeyValueStore
 */

/** What a page's store does. */
export interface KeyValueStore {
  /** True when nothing outlives the page (a browser that refused the database). */
  readonly memoryOnly: boolean;
  /**
   * The value held under `key`, or undefined when there is none. The type argument is the caller's word for what
   * it stored: the store checks nothing of what it reads.
   */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Holds `value` under `key`, in place of what was there. The value must be one the structured clone can copy. */
  set(key: string, value: unknown): Promise<void>;
  /** Removes `key`. A key that is not held is no error. */
  delete(key: string): Promise<void>;
  /** Every key that begins with `prefix`, in order. */
  keys(prefix: string): Promise<string[]>;
  /** Removes every key that begins with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}

/** A store held in memory. Values are copied in and out with `structuredClone`, as IndexedDB copies them. */
export class MemoryKeyValueStore implements KeyValueStore {
  /** Always true: the values go with the page. */
  readonly memoryOnly = true;
  private readonly values = new Map<string, unknown>();

  /** A copy of the value held under `key`, or undefined. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : undefined;
  }

  /** Holds a copy of `value` under `key`. */
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  /** Removes `key`. */
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  /** Every key that begins with `prefix`, in order. */
  async keys(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  /** Removes every key that begins with `prefix`. */
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.keys(prefix)) this.values.delete(key);
  }
}

/**
 * A store whose keys all begin with `prefix`; its own keys are answered without it. Two namespaces stay apart only
 * when neither prefix begins with the other, so end each with a character no id holds: the keys under `anna` are
 * among those under `ann`, while `ann/` and `anna/` never meet. Each call makes a new store object.
 */
export function namespaced(store: KeyValueStore, prefix: string): KeyValueStore {
  return {
    get memoryOnly() {
      return store.memoryOnly;
    },
    get: (key) => store.get(prefix + key),
    set: (key, value) => store.set(prefix + key, value),
    delete: (key) => store.delete(prefix + key),
    keys: async (inner) => (await store.keys(prefix + inner)).map((key) => key.slice(prefix.length)),
    deletePrefix: (inner) => store.deletePrefix(prefix + inner),
  };
}
