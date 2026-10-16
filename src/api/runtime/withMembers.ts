/**
 * @file withMembers.ts
 * A view of an object with some members replaced: the GMI tool hook's orchestrator, a seat's tool view and a metered
 * provider are each the object they wrap with one or two methods of their own.
 */

/**
 * `target` with some members replaced; every other member reads from `target` itself, a method bound to it, so a
 * method of `target` that calls another of its own methods calls `target`'s, never the replacement.
 *
 * @param target - The object the view wraps.
 * @param members - The replaced members, by name.
 * @returns A proxy typed as `target`.
 */
export function withMembers<T extends object>(target: T, members: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(members, prop)) return (members as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    },
  });
}
