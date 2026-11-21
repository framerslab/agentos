/**
 * @module api/runtime/routeObserver
 *
 * Where a GMI agent sends text, told as it sends it: each model attempt's provider and model as the completion gateway
 * resolved them (a router's pick, a model's `provider:` prefix and the Anthropic to OpenRouter reroute applied), and the
 * embedding provider and model its cognitive memory was built with. A souled agent hands an observer to the `gmi()`
 * built from the same options object, as it hands its tombstone ledger (`shareForgottenLedger`). Internal: exported from
 * neither package index.
 */

/** What a GMI agent tells its observer. Neither call may throw: each runs on the path of a model call. */
export interface RouteObserver {
  /** A model attempt about to be sent: `hop` 0 is the turn's primary, a later hop a fallback. */
  attempt(route: { providerId: string; modelId: string; hop: number }): void;
  /** The embedding provider and model a cognitive memory was built with, told once a build. */
  embedding(route: { provider: string; model: string }): void;
}

/** Each observer, by the options object the agent was built from. Held weakly. */
const observers = new WeakMap<object, RouteObserver>();

/**
 * Hands `observer` to the `gmi()` built from `options`.
 *
 * @internal
 */
export function shareRouteObserver(options: object, observer: RouteObserver): void {
  observers.set(options, observer);
}

/**
 * The observer handed for `options`, if any.
 *
 * @internal
 */
export function routeObserverOf(options: object): RouteObserver | undefined {
  return observers.get(options);
}
