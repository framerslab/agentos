/**
 * @fileoverview officeparser, the office loader's optional peer dependency,
 * imported the first time a read needs it.
 *
 * This is the one module of the package that imports officeparser, and it
 * imports it only when called: loading the module loads nothing. The office
 * loader calls it on its first read, and the worker thread `loadIsolated`
 * starts calls it to hand officeparser to the loader it builds.
 *
 * @module memory/ingestion/loadOfficeparser
 */

import type { OfficeParse } from './OfficeLoader.js';

/** officeparser's `parseOffice`, once its import has started; a failed import is not kept. */
let parser: Promise<OfficeParse> | null = null;

/**
 * officeparser's `parseOffice`, imported on the first call and kept for the
 * thread's later calls. A failed import is tried again on the next call, so a
 * package installed meanwhile is found.
 *
 * @returns officeparser's `parseOffice`.
 * @throws {Error} When officeparser is not installed: the message starts
 *   `OfficeLoader needs the optional peer dependency officeparser`, and the
 *   import's error is its `cause`.
 */
export function loadOfficeparser(): Promise<OfficeParse> {
  parser ??= import('officeparser')
    .then((module) => module.parseOffice as unknown as OfficeParse)
    .catch((error: unknown) => {
      parser = null;
      throw Object.assign(new Error(`OfficeLoader needs the optional peer dependency officeparser: ${String(error)}`), {
        cause: error,
      });
    });
  return parser;
}
