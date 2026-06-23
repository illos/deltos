/**
 * #69 slice B — the Deck at the app-shell level (DeckHostProvider) + the navigation loadout.
 *
 * Proves the host-adapter extensibility model: a whole new context + loadout (the deltos nav controls)
 * is delivered WITHOUT touching deck core. The provider:
 *  - shows the navigation loadout (New + Search) when no editor has published (browsing);
 *  - swaps to the editor's published loadout + live context while a note is open, and back on withdraw;
 *  - mounts nothing when disabled (non-custom mode).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { DeckHostProvider, useDeckHost } from '../src/components/DeckHost.js';
import { Keypad } from '../src/deck/index.js';
import type { KeyActions } from '../src/deck/index.js';

afterEach(() => { cleanup(); });

const NOOP_ACTIONS: KeyActions = { insert: () => {}, backspace: () => {}, enter: () => {} };

// A child that publishes a 'text'+keypad loadout on mount and withdraws on unmount — stands in for the
// editor without pulling ProseMirror into this test.
function FakeEditor() {
  const { publishEditor } = useDeckHost();
  useEffect(() => {
    publishEditor({ context: 'text', loadouts: { text: <Keypad actions={NOOP_ACTIONS} /> } });
    return () => publishEditor(null);
  }, [publishEditor]);
  return <div data-testid="fake-editor" />;
}

// Surfaces the current route path so navigation from the nav loadout is observable.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

const navAction = (label: string) =>
  document.querySelector(`.deck-nav__action[aria-label="${label}"]`) as HTMLButtonElement | null;

describe('DeckHostProvider — shell-level Deck + navigation loadout', () => {
  it('shows the navigation loadout (New + Search) when no editor is published', () => {
    render(<MemoryRouter><DeckHostProvider enabled><div /></DeckHostProvider></MemoryRouter>);
    expect(document.querySelector('.deck')).not.toBeNull();
    expect(document.querySelector('[data-deck-context="navigation"]')).not.toBeNull();
    expect(navAction('New note')).not.toBeNull();
    expect(navAction('Search')).not.toBeNull();
    expect(document.querySelector('.keypad')).toBeNull();
    // The nav loadout has NO keypad → sits flush, no 47px positioning band (#384).
    expect(document.querySelector('.keypad__slot')).toBeNull();
  });

  it('mounts NOTHING when disabled (non-custom mode)', () => {
    render(<MemoryRouter><DeckHostProvider enabled={false}><div /></DeckHostProvider></MemoryRouter>);
    expect(document.querySelector('.deck')).toBeNull();
    expect(document.querySelector('.deck-nav')).toBeNull();
  });

  it('swaps nav → keypad while an editor is published, and back to nav on withdraw', () => {
    function Harness({ editing }: { editing: boolean }) {
      return (
        <MemoryRouter>
          <DeckHostProvider enabled>{editing ? <FakeEditor /> : <div />}</DeckHostProvider>
        </MemoryRouter>
      );
    }
    const { rerender } = render(<Harness editing={false} />);
    // Browsing: nav loadout up, no keypad.
    expect(document.querySelector('.deck-nav')).not.toBeNull();
    expect(document.querySelector('.keypad')).toBeNull();

    // Editor mounts + publishes: context → 'text', keypad up, nav gone.
    act(() => { rerender(<Harness editing />); });
    expect(document.querySelector('.keypad')).not.toBeNull();
    expect(document.querySelector('[data-deck-context="text"]')).not.toBeNull();
    expect(document.querySelector('.deck-nav')).toBeNull();

    // Editor unmounts (leaves the note): withdraw → nav loadout returns.
    act(() => { rerender(<Harness editing={false} />); });
    expect(document.querySelector('.keypad')).toBeNull();
    expect(document.querySelector('.deck-nav')).not.toBeNull();
  });

  it('navigation loadout: New → /new, Search → /search', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <DeckHostProvider enabled><LocationProbe /></DeckHostProvider>
      </MemoryRouter>,
    );
    fireEvent.click(navAction('New note')!);
    expect(document.querySelector('[data-testid="path"]')!.textContent).toBe('/new');
    fireEvent.click(navAction('Search')!);
    expect(document.querySelector('[data-testid="path"]')!.textContent).toBe('/search');
  });
});
