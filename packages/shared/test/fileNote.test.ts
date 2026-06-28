/**
 * File-note discriminator (file-notes.md §2.1, gate FN-1).
 *
 * Locks the three guarantees of the shared chokepoint:
 *   - isFileNote is true IFF `fileType` is a `text` value 'file', and FAIL-SAFE for every other shape;
 *   - setFileType writes exactly that marker and is pure;
 *   - the marker is USER-namespace, so userProperties() does NOT strip it → it survives duplication
 *     (a duplicated file note stays a file note) — the deliberate contrast with the sys: trash flag.
 */
import { describe, it, expect } from 'vitest';
import {
  FILE_NOTE_TYPE,
  FILE_TYPE_KEY,
  isFileNote,
  setFileType,
} from '../src/spine/fileNote.js';
import { userProperties, setTrashedAt, isReservedKey } from '../src/spine/reservedKeys.js';
import type { Note } from '../src/spine/note.js';
import type { PropertyBag } from '../src/spine/property.js';

const NOW = '2026-06-28T12:00:00.000Z';

function makeNote(properties: PropertyBag): Note {
  return {
    id: '00000000-0000-4000-8000-000000000001' as Note['id'],
    notebookId: null,
    title: 'Q3-report.pdf',
    properties,
    body: [],
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    syncStatus: 'synced',
  };
}

describe('file-note discriminator', () => {
  it('isFileNote is true ONLY for a text "file" marker; false for every normal note', () => {
    expect(isFileNote(makeNote(setFileType({})))).toBe(true);
    expect(isFileNote(makeNote({}))).toBe(false);
    expect(isFileNote(makeNote({ status: { type: 'select', value: ['active'] } }))).toBe(false);
  });

  it('isFileNote is FAIL-SAFE: a wrong-typed or wrong-valued fileType reads as a NORMAL note', () => {
    // wrong value type (number, not text) → not a file note
    expect(isFileNote(makeNote({ [FILE_TYPE_KEY]: { type: 'number', value: 1 } }))).toBe(false);
    // right type, wrong value → not a file note
    expect(isFileNote(makeNote({ [FILE_TYPE_KEY]: { type: 'text', value: 'image' } }))).toBe(false);
  });

  it('setFileType writes exactly { fileType: { type:"text", value:"file" } } and preserves other keys', () => {
    const bag = setFileType({ status: { type: 'select', value: ['active'] } });
    expect(bag[FILE_TYPE_KEY]).toEqual({ type: 'text', value: FILE_NOTE_TYPE });
    expect(bag['status']).toEqual({ type: 'select', value: ['active'] });
  });

  it('setFileType is pure — does not mutate its input', () => {
    const original: PropertyBag = {};
    setFileType(original);
    expect(FILE_TYPE_KEY in original).toBe(false);
  });

  it('the fileType key is USER-namespace → userProperties() does NOT strip it (survives duplication)', () => {
    expect(isReservedKey(FILE_TYPE_KEY)).toBe(false);
    // A duplicated note's bag goes through userProperties() (see mutateNotes.duplicate). The marker must
    // survive so the copy is still a file note — the deliberate contrast with the sys: trash flag, which
    // IS stripped. Combine the two to prove only the trash flag is dropped.
    const bag = setTrashedAt(setFileType({}), NOW);
    const visible = userProperties(bag);
    expect(isFileNote(makeNote(visible))).toBe(true);       // fileType survives
    expect(visible[FILE_TYPE_KEY]).toEqual({ type: 'text', value: FILE_NOTE_TYPE });
  });
});
