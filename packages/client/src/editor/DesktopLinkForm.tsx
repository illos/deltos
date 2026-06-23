import { useEffect, useRef } from 'react';

/**
 * DesktopLinkForm (#69 desktop Deck strip) — the URL+Title link form for the DESKTOP control strip. Same
 * two-field form as the mobile Deck LinkEntryBar, but with real <input>s (desktop has a native keyboard, so
 * the keypad-fed buffer is mobile-only — navSys Q2). The host owns the buffers + the scheme-safe apply; this
 * just renders the inputs + apply/cancel and wires Enter (apply) / Escape (cancel).
 */
interface DesktopLinkFormProps {
  title: string;
  url: string;
  onChangeTitle: (v: string) => void;
  onChangeUrl: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function DesktopLinkForm({ title, url, onChangeTitle, onChangeUrl, onSubmit, onCancel }: DesktopLinkFormProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="editor__link-form" role="group" aria-label="Add link" onKeyDown={onKeyDown}>
      <input
        ref={titleRef}
        className="editor__link-input"
        type="text"
        placeholder="Title"
        aria-label="Link title"
        value={title}
        onChange={(e) => onChangeTitle(e.target.value)}
      />
      <input
        className="editor__link-input editor__link-input--url"
        type="url"
        inputMode="url"
        placeholder="https://…"
        aria-label="Link URL"
        value={url}
        onChange={(e) => onChangeUrl(e.target.value)}
      />
      <button
        type="button"
        className="editor__link-btn editor__link-apply"
        aria-label="Apply link"
        disabled={!url.trim()}
        onMouseDown={(e) => { e.preventDefault(); onSubmit(); }}
      >
        Add
      </button>
      <button
        type="button"
        className="editor__link-btn editor__link-cancel"
        aria-label="Cancel link"
        onMouseDown={(e) => { e.preventDefault(); onCancel(); }}
      >
        Cancel
      </button>
    </div>
  );
}
