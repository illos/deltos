/**
 * `auth/*` — the cross-surface authentication contract: the binary encoding, the password-auth endpoint
 * request/response schemas (the 2026-06-17 pivot), and the username directory normalizer. The retired
 * signed-challenge contract (`canonical.ts` TLV + `requests.ts` Challenge/Register/Session/StepUp) was
 * DELETED with the worker's signed-challenge stack; password auth is the sole surface.
 */
export * from './encoding.js';
export * from './password.js';
export * from './username.js';
