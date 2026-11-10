/**
 * @module memory/suppression
 *
 * Who a store was told to forget, and the checks that keep a forgotten subject out of it.
 */
export { ForgottenLedger, ForgottenLedgerError, FORGOTTEN_DDL, COPY_MARKER, KEY_MARKER_PREFIX } from './ForgottenLedger.js';
export type { ForgottenLedgerOptions, SuppressionSubject, TombstoneKey } from './ForgottenLedger.js';
export { openForgottenCopy } from './forgottenCopy.js';
