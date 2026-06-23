/**
 * #69 §5.1 spellcheck suggestion BAR — the Deck top-slot presentation. Presentational: renders the ranked
 * suggestions as scrollable pills, tap → onPick; supports an optional trailing action slot (§5.2 hook).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { SpellSuggestionBar } from '../src/editor/SpellSuggestionBar.js';

afterEach(cleanup);

const pill = (label: string) =>
  document.querySelector(`.spell-bar__pill[role="option"]`) && [...document.querySelectorAll('.spell-bar__pill')].find((b) => b.textContent === label);

describe('SpellSuggestionBar', () => {
  it('renders the suggestions as pills; tapping one calls onPick with that word', () => {
    const onPick = vi.fn();
    render(<SpellSuggestionBar word="recieve" suggestions={['receive', 'relieve', 'believe']} onPick={onPick} />);
    const pills = [...document.querySelectorAll('.spell-bar__pill')];
    expect(pills.map((p) => p.textContent)).toEqual(['receive', 'relieve', 'believe']);
    fireEvent.pointerDown(pill('relieve')!);
    expect(onPick).toHaveBeenCalledWith('relieve');
  });

  it('shows an empty state when there are no suggestions', () => {
    render(<SpellSuggestionBar word="xyzzy" suggestions={[]} onPick={() => {}} />);
    expect(document.querySelector('.spell-bar__pill')).toBeNull();
    expect(document.querySelector('.spell-bar__empty')).not.toBeNull();
  });

  it('renders a trailing action when provided (the §5.2 [+ Add to dictionary] slot)', () => {
    render(
      <SpellSuggestionBar
        word="quokka"
        suggestions={['quota']}
        onPick={() => {}}
        trailing={<button type="button" data-testid="add">+ Add</button>}
      />,
    );
    const trailing = document.querySelector('.spell-bar__trailing');
    expect(trailing).not.toBeNull();
    expect(trailing!.querySelector('[data-testid="add"]')).not.toBeNull();
  });
});
