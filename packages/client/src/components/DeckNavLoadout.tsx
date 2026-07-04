import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ComposeNew, Search, Upload } from '../icons/index.js';
import { useFilePickerUpload } from '../lib/upload/useFilePickerUpload.js';
import { useNavSheetArm } from './NavSheet.js';
import { useSearchModeStore } from '../lib/searchModeStore.js';

/**
 * The Deck's NAVIGATION loadout (#69 slice B) — the lean browsing controls that own the bottom slot
 * when no note is open, absorbed from the retired standalone bottom nav: New note + Search + Upload.
 *
 * HOST-SIDE by design: it knows deltos routes + icons, so it lives in the app and is injected into the
 * (app-agnostic) Deck via the 'navigation' context. Deck core gains nothing app-specific — proving the
 * extensibility model: a whole new context + loadout delivered without touching deck/.
 *
 * No iOS keyboard-anchor dance here (unlike the old BottomNav): in custom-keyboard mode the native
 * keyboard is suppressed (inputmode=none), so navigating away can't summon it.
 *
 * Upload (mobile file-note creation): the Deck is mobile-only, so this is the ONLY way to make a file
 * note on touch — desktop keeps its list drag-drop. Tapping opens a hidden native file picker; each
 * chosen file becomes a file note via the EXISTING createFileNote (reused, not reimplemented), routed
 * through a LAZY chunk (useFilePickerUpload) so the blob-upload machinery stays OFF the mobile
 * first-load bundle (perf standing value / gate FN-8). It ALSO delivers iOS document scanning for free:
 * a plain <input type="file"> with NO `capture` surfaces Apple's native "Scan Documents" option (→ PDF).
 */
export function DeckNavLoadout() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  // Warm the lazy upload chunk on mount so the first tap is snappy; the change handler is resilient if
  // it hasn't loaded yet (falls back to an inline import — dynamic import() is cached, so it's one fetch).
  const uploadMod = useFilePickerUpload();
  // Drag-up arm zone: a vertical drag off this bar reveals the nav sheet (the same pane the top-bar "…"
  // opens). Spread on the toolbar root — useDragAxis only locks on a vertical drag past its slop, so the
  // action taps below still fire and horizontal/tap gestures never arm. A no-op set when there's no enabled
  // NavSheetProvider (desktop / note route), leaving the loadout unchanged there.
  const armHandlers = useNavSheetArm();
  const openSearch = useSearchModeStore((s) => s.setOpen);

  async function handleFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    const mod = uploadMod ?? (await import('../lib/upload/filePickerUpload.js'));
    await mod.createFileNotesFromPicker(files);
  }

  return (
    <div className="deck-nav" role="toolbar" aria-label="Navigation" {...armHandlers}>
      <button
        type="button"
        className="deck-nav__action deck-nav__action--accent"
        aria-label="New note"
        onClick={() => navigate('/new')}
      >
        <ComposeNew size={24} />
        <span className="deck-nav__label">New</span>
      </button>
      <button
        type="button"
        className="deck-nav__action"
        aria-label="Search"
        // Mobile search runs IN PLACE on the note list (not the /search route): ensure we're on the list,
        // then flip the shared flag HomeView reads to open the in-place field + keys-only Deck keypad.
        onClick={() => { navigate('/'); openSearch(true); }}
      >
        <Search size={24} />
        <span className="deck-nav__label">Search</span>
      </button>
      <button
        type="button"
        className="deck-nav__action"
        aria-label="Upload file"
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={24} />
        <span className="deck-nav__label">Upload</span>
      </button>
      {/*
        Hidden native file picker. CRITICAL: NO `capture` attribute — on iOS, `capture` forces the camera
        and HIDES Apple's native "Scan Documents" option in the Files picker (which returns a PDF). Leaving
        it unset surfaces the scanner for free. No `accept` either: ANY file type is a valid file note
        (.pdf, images, .docx, .blend, …), and restricting it would both block artifacts and (with an image
        filter) suppress the scanner. `multiple` so several files can be picked at once.
      */}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = ''; // reset so re-selecting the SAME file re-fires change
        }}
      />
    </div>
  );
}
