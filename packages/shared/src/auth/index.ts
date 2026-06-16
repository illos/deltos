/**
 * `auth/*` — the cross-surface authentication contract: the binary encoding, the canonical
 * signed-payload format, and the auth endpoint request/response schemas. The key DERIVATION and
 * signing live on the device (client package); only the shapes both sides must agree on byte-for-byte
 * live here, alongside the spine and the grant primitive.
 */
export * from './encoding.js';
export * from './canonical.js';
export * from './requests.js';
export * from './username.js';
