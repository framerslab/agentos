/**
 * @module memory/suppression
 *
 * Who a store was told to forget, and the checks that keep a forgotten subject out of it.
 */
export { ForgottenLedger, ForgottenLedgerError, FORGOTTEN_DDL, COPY_MARKER, KEY_MARKER_PREFIX } from './ForgottenLedger.js';
export type { ForgottenLedgerOptions, SuppressionSubject, TombstoneKey } from './ForgottenLedger.js';
export { openForgottenCopy } from './forgottenCopy.js';
export { learnerTombstones, shareForgottenLedger, sharedForgottenLedgerOf } from './learnerTombstones.js';
export type { LearnerTombstones, NamespacedUser } from './learnerTombstones.js';
export { guardedWrite } from './guardedWrite.js';
export { guardMemoryProvider } from './guardMemoryProvider.js';
