import { z } from 'zod';
import { NoteIdSchema, TimestampSchema } from './ids.js';

/**
 * The property bag is the *record* half of the spine: a loose `key → typed value` map that
 * any note may carry frontmatter-style. A notebook MAY later declare a schema over these
 * keys (validation + typed views), but by default the bag is open — so the value side is a
 * discriminated union on `type`, which keeps every value self-describing on the wire and
 * lets search treat properties as typed, filterable facets.
 */

export const PROPERTY_VALUE_TYPES = [
  'text',
  'number',
  'date',
  'boolean',
  'select',
  'relation',
  'url',
] as const;

export const PropertyValueTypeSchema = z.enum(PROPERTY_VALUE_TYPES);
export type PropertyValueType = z.infer<typeof PropertyValueTypeSchema>;

export const PropertyValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('number'), value: z.number() }),
  z.object({ type: z.literal('date'), value: TimestampSchema }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  // `select` doubles as tags: an ordered set of string labels (single-select is a 1-element list).
  z.object({ type: z.literal('select'), value: z.array(z.string()) }),
  // `relation` is a *core* property type — references to other notes by id, powering backlinks,
  // the note graph, and relation-aware transport. References are GLOBAL-BY-ID and intentionally
  // NOT notebook-scoped (note ids are globally-unique UUIDs; the cross-notebook graph is a
  // feature). Two frozen obligations come with that shape (PIN-MODEL-1):
  //
  //   1. Resolution is can()-gated. A relation NEVER confers access across a notebook,
  //      capability, or encryption boundary. A target the caller cannot reach (cross-notebook
  //      no-grant, E2EE no-key) resolves to dangling-but-safe — never a leak. Access is
  //      enforced at RESOLUTION time, not at link time.
  //   2. Relations are SOFT pointers — no foreign key, no referential integrity. They degrade
  //      gracefully (show the cached target title if known, else a placeholder) when the target
  //      is inaccessible, offline-uncached, forked to a new id, or moved. So there is no
  //      relation-repair machinery: a cross-notebook move or a fork-to-new-id simply yields a
  //      dangling-but-safe relation.
  z.object({ type: z.literal('relation'), value: z.array(NoteIdSchema) }),
  z.object({ type: z.literal('url'), value: z.string().url() }),
]);
export type PropertyValue = z.infer<typeof PropertyValueSchema>;

/**
 * Loose by default: arbitrary string keys, each mapping to a typed value. A future
 * notebook-declared schema constrains *which* keys are allowed and their types, but never
 * changes this representation.
 */
export const PropertyBagSchema = z.record(z.string(), PropertyValueSchema);
export type PropertyBag = z.infer<typeof PropertyBagSchema>;
