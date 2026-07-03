/**
 * Deploy 3 — slice D: mobile grouped contextual bar render gate (spec §3 / §7.B). Asserts the main-row
 * group toggles + persistent Undo/Redo, the open-above sub-row with the right group's controls + the
 * active-group accent, toggle/swap/close behaviour, and that sub-row taps run a registry command.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { MobileEditorBar } from '../src/editor/MobileEditorBar.js';
import { EMPTY_ACTIVE_STATE } from '../src/editor/editorState.js';
import type { EditorActiveState } from '../src/editor/editorState.js';

afterEach(cleanup);

function mountBar(active: EditorActiveState = EMPTY_ACTIVE_STATE) {
  const run = vi.fn();
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  render(<MobileEditorBar active={active} run={run} onUndo={onUndo} onRedo={onRedo} />);
  return { run, onUndo, onRedo };
}
const sub = () => document.querySelector('.editor__mbar-sub') as HTMLElement | null;
const tap = (label: string) => fireEvent.mouseDown(screen.getByLabelText(label));

describe('MobileEditorBar — main row', () => {
  it('shows the 4 group toggles + a divider + persistent Undo/Redo, no sub-row initially', () => {
    mountBar();
    for (const label of ['Style', 'Format', 'Lists', 'Insert', 'Undo', 'Redo']) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    expect(document.querySelector('.editor__mbar-divider')).not.toBeNull();
    expect(sub()).toBeNull();
  });

  it('Undo/Redo reflect canUndo/canRedo', () => {
    mountBar({ ...EMPTY_ACTIVE_STATE, canUndo: true, canRedo: false });
    expect((screen.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Redo') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('MobileEditorBar — sub-row open/close/swap', () => {
  it('tapping Style opens its sub-row above with the style controls + accents the group', () => {
    mountBar();
    tap('Style');
    expect(sub()).not.toBeNull();
    for (const label of ['Title', 'Heading', 'Subhead', 'Mono']) { // Body removed — implicit default (#69)
      expect(within(sub()!).getByLabelText(label), label).toBeTruthy();
    }
    expect(within(sub()!).queryByLabelText('Body')).toBeNull();
    expect(screen.getByLabelText('Style').className).toContain('is-active');
  });

  it('tapping the same group closes the sub-row; a different group swaps it', () => {
    mountBar();
    tap('Style');
    expect(sub()).not.toBeNull();
    tap('Style');                       // same → close
    expect(sub()).toBeNull();

    tap('Format');                      // open format
    expect(within(sub()!).getByLabelText('Bold')).toBeTruthy();
    tap('Lists');                       // swap to lists
    expect(within(sub()!).getByLabelText('Bullet list')).toBeTruthy();
    expect(within(sub()!).queryByLabelText('Bold')).toBeNull();
  });

  it('the Insert tray carries link + quote + divider (mobile, no image)', () => {
    mountBar();
    tap('Insert');
    expect(within(sub()!).getByLabelText('Link')).toBeTruthy();
    expect(within(sub()!).getByLabelText('Quote')).toBeTruthy();
    expect(within(sub()!).getByLabelText('Divider')).toBeTruthy();
    expect(within(sub()!).queryByLabelText('Image')).toBeNull();
  });
});

describe('MobileEditorBar — deck variant (native-mode top bar)', () => {
  it('adds the --deck modifier class but keeps the same controls (shared registry, one impl)', () => {
    const run = vi.fn();
    render(<MobileEditorBar active={EMPTY_ACTIVE_STATE} run={run} onUndo={() => {}} onRedo={() => {}} variant="deck" />);
    const bar = document.querySelector('.editor__mbar') as HTMLElement;
    expect(bar.classList.contains('editor__mbar--deck')).toBe(true);
    // Same controls as the bottom variant — the group toggles + undo/redo.
    for (const label of ['Style', 'Format', 'Lists', 'Insert', 'Undo', 'Redo']) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
  });

  it('defaults to the bottom variant (no --deck class) when variant is omitted', () => {
    render(<MobileEditorBar active={EMPTY_ACTIVE_STATE} run={vi.fn()} onUndo={() => {}} onRedo={() => {}} />);
    expect((document.querySelector('.editor__mbar') as HTMLElement).classList.contains('editor__mbar--deck')).toBe(false);
  });
});

describe('MobileEditorBar — active reflection + dispatch', () => {
  it('a sub-row control reads active from the snapshot (Bold accented when bold is active)', () => {
    mountBar({ ...EMPTY_ACTIVE_STATE, marks: { ...EMPTY_ACTIVE_STATE.marks, bold: true } });
    tap('Format');
    const bold = within(sub()!).getByLabelText('Bold');
    expect(bold.className).toContain('is-active');
    expect(bold.getAttribute('aria-pressed')).toBe('true');
  });

  it('tapping a sub-row control runs its registry command', () => {
    const { run } = mountBar();
    tap('Format');
    fireEvent.mouseDown(within(sub()!).getByLabelText('Bold'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].id).toBe('bold');
  });
});
