/**
 * @deltos/shared — the frozen substrate contract.
 *
 * `spine/*` is the data model (identity + properties + nestable blocks); `api/*` is the grant
 * primitive, the `can()` chokepoint signature, and the typed operation contract. Both the PWA
 * and the worker build against exactly these schemas — there is one definition of a note.
 */
export * from './spine/index.js';
export * from './api/index.js';
