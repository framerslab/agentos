/**
 * @fileoverview Loads an optional package at run time, by a specifier a bundler does not follow.
 *
 * @module agentos/core/utils/importOptional
 */

/**
 * Imports `specifier` at run time. The argument is a variable, not a string literal, so esbuild leaves the import to
 * the runtime and does not bundle the package; the `webpackIgnore` and `@vite-ignore` comments do the same for
 * webpack and Vite. A host that bundles a module calling this builds whether the package is installed or not; where it
 * is installed, the call loads it, and where it is not, the call rejects as an `import()` of a missing package does.
 *
 * @param specifier - The package to import, such as `@huggingface/transformers`.
 * @returns The package's module namespace.
 */
export function importOptional<T = any>(specifier: string): Promise<T> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as Promise<T>;
}
