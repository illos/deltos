/**
 * resolveFileIcon (file-notes.md §3.1, gate FN-4) — extension-FIRST format-icon resolution, mime-class
 * fallback, generic last. Pure reference comparison (no render) — locks the routing table that the pill
 * paints from.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveFileIcon,
  FilePdf, FileDoc, FileSheet, FileSlides, FileArchive, FileVideo, FileAudio, FileGeneric, Blender, Image,
} from './index.js';

describe('resolveFileIcon', () => {
  it('resolves by extension first (pdf/doc/xls/ppt/zip/blend/video/audio)', () => {
    expect(resolveFileIcon('Q3.pdf', 'application/pdf')).toBe(FilePdf);
    expect(resolveFileIcon('memo.docx', '')).toBe(FileDoc);
    expect(resolveFileIcon('budget.xlsx', '')).toBe(FileSheet);
    expect(resolveFileIcon('deck.pptx', '')).toBe(FileSlides);
    expect(resolveFileIcon('bundle.zip', '')).toBe(FileArchive);
    expect(resolveFileIcon('scene.blend', 'application/octet-stream')).toBe(Blender);
    expect(resolveFileIcon('clip.mov', '')).toBe(FileVideo);
    expect(resolveFileIcon('song.mp3', '')).toBe(FileAudio);
  });

  it('extension is case-insensitive', () => {
    expect(resolveFileIcon('REPORT.PDF', '')).toBe(FilePdf);
    expect(resolveFileIcon('Scene.BLEND', '')).toBe(Blender);
  });

  it('falls back to mime class when the extension is unknown', () => {
    expect(resolveFileIcon('mystery', 'video/mp4')).toBe(FileVideo);
    expect(resolveFileIcon('mystery', 'audio/ogg')).toBe(FileAudio);
    expect(resolveFileIcon('mystery', 'image/avif')).toBe(Image); // image w/o a thumbnail
  });

  it('falls back to the generic glyph for an unknown extension AND unknown mime', () => {
    expect(resolveFileIcon('weird.xyz', 'application/x-thing')).toBe(FileGeneric);
    expect(resolveFileIcon(undefined, undefined)).toBe(FileGeneric);
    expect(resolveFileIcon('noext', '')).toBe(FileGeneric);
  });
});
