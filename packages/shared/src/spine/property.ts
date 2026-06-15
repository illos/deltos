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
  // `relation` is a *core* property type — it carries references to other notes by id, which
  // is what powers backlinks, the note graph, and relation-aware transport.
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
