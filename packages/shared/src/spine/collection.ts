import { z } from 'zod';
import {
  CollectionIdSchema,
  CollectionMemberIdSchema,
  NoteIdSchema,
  NotebookIdSchema,
  type CollectionId,
  type CollectionMemberId,
  type NoteId,
} from './ids.js';

/**
 * A collection is a named, metadata-powered grouping of notes (collections.md). It is folder-like
 * and is often *displayed* as a folder, but it is not a container the note "lives in." A note lives
 * in exactly one notebook; a note can belong to zero or many collections via the join entity
 * {@link CollectionMemberSchema}.
 *
 * Collections are first-class, account-scoped, SYNCED entities that ride the per-account syncSeq
 * stream alongside notes + notebooks (Model C — join entity; see collections.md §2/§3).
 *
 * Wire field `ord` matches the D1 column 1:1 (PIN-SUBSTRATE-1). The design draft used `order`; the
 * SQL keyword collision and the substrate rule settle on `ord`.
 */

// ---------------------------------------------------------------------------
// Deterministic CollectionMemberId (uuid v5) — multi-device remove→readd safe
// ---------------------------------------------------------------------------

/**
 * Fixed namespace for {@link collectionMemberId}. Exported so tests / other runtimes can recompute
 * the same ids; do not change once clients exist — every device must hash into the same uuid.
 */
export const COLLECTION_MEMBER_ID_NAMESPACE = 'a8f5f167-c2b4-4f6e-9d3a-1b2c3d4e5f60';

/** Parse a UUID string into 16 bytes. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Format 16 bytes as a lowercase UUID string. */
function bytesToUuid(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Minimal SHA-1 (RFC 3174) over a byte array. Sync + dep-free so the shared package stays
 * browser/Worker/Node portable without pulling `uuid` or `crypto.subtle` (async).
 */
function sha1(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const bitLen = ml * 8;
  // padded length in bytes: message + 0x80 + zeros + 8-byte length, multiple of 64
  const padLen = ((ml + 9 + 63) & ~63) >>> 0;
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[ml] = 0x80;
  // length in bits as big-endian 64-bit (high 32 always 0 for our input sizes)
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) | 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, h0, false);
  ov.setInt32(4, h1, false);
  ov.setInt32(8, h2, false);
  ov.setInt32(12, h3, false);
  ov.setInt32(16, h4, false);
  return out;
}

/** UTF-8 encode. Inputs here are ASCII (`uuid:uuid`); charCodeAt is correct for that set. */
function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** RFC 4122 uuid v5 over `namespace` + UTF-8 `name`. */
function uuidv5(namespace: string, name: string): string {
  const ns = uuidToBytes(namespace);
  const nameBytes = utf8Encode(name);
  const joined = new Uint8Array(ns.length + nameBytes.length);
  joined.set(ns);
  joined.set(nameBytes, ns.length);
  const hash = sha1(joined);
  // set version (5) and RFC 4122 variant
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}

/**
 * Deterministic member id for a (collectionId, noteId) pair. Client, worker, and MCP MUST mint
 * membership ids via this helper — never a random UUID — so remove→readd across devices converges
 * to one row (the unique index and the PK coincide; no re-key on revive).
 *
 * accountId is NOT hashed: collectionId is globally unique and already encodes ownership.
 */
export function collectionMemberId(
  collectionId: CollectionId | string,
  noteId: NoteId | string,
): CollectionMemberId {
  return CollectionMemberIdSchema.parse(
    uuidv5(COLLECTION_MEMBER_ID_NAMESPACE, `${collectionId}:${noteId}`),
  );
}

/**
 * v1: always null. Reserved for v2 auto-membership filters (collections.md §8). Named so the shape
 * can widen later without a protocol break; the server treats the value as opaque JSON in v1.
 */
export const CollectionRuleSchema = z.unknown().nullable();
export type CollectionRule = z.infer<typeof CollectionRuleSchema>;

export const CollectionSchema = z.object({
  id: CollectionIdSchema,
  /** HOME notebook. v1: always set; null reserved for v2 global/cross-notebook collections. */
  notebookId: NotebookIdSchema.nullable(),
  name: z.string().min(1).max(200),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  /** Accordion order within the home notebook's list (fractional-friendly REAL on the wire). */
  ord: z.number().default(0),
  /** v1: always null; opaque reserved seam for auto-membership. */
  rule: CollectionRuleSchema.default(null),
});
export type Collection = z.infer<typeof CollectionSchema>;

/**
 * Client-authored slice of a collection (create / rename / restyle / reorder). The server owns
 * ownership scoping, timestamps, version, deletedAt, syncSeq.
 */
export const CollectionDraftSchema = CollectionSchema.pick({
  notebookId: true,
  name: true,
  icon: true,
  color: true,
  ord: true,
  rule: true,
});
export type CollectionDraft = z.infer<typeof CollectionDraftSchema>;

/**
 * Join row: note ∈ collection. Independent synced entity so concurrent add/remove never contend on
 * a shared collection or note CAS version (collections.md §2 Model C).
 */
export const CollectionMemberSchema = z.object({
  id: CollectionMemberIdSchema,
  collectionId: CollectionIdSchema,
  noteId: NoteIdSchema,
  /** Manual order within the collection (fractional-friendly). */
  ord: z.number().default(0),
});
export type CollectionMember = z.infer<typeof CollectionMemberSchema>;

/**
 * Client-authored slice of a membership (add / reorder). Remove is `delete: true` on the push entry.
 */
export const CollectionMemberDraftSchema = CollectionMemberSchema.pick({
  collectionId: true,
  noteId: true,
  ord: true,
});
export type CollectionMemberDraft = z.infer<typeof CollectionMemberDraftSchema>;
