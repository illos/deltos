/**
 * Task #66 — float the mobile editor bar above the soft keyboard. jsdom can't drive a real keyboard
 * (that's Jim's on-device feel-test), so this asserts the MECHANISM: useKeyboardInset reads the
 * visualViewport overlap, and MobileEditorBar applies the floating/lifted classes + the translateY lift,
 * with ?kbfloat=off reverting to the sticky bar.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useKeyboardInset } from '../src/lib/useKeyboardInset.js';
import { MobileEditorBar } from '../src/editor/MobileEditorBar.js';
import { EMPTY_ACTIVE_STATE } from '../src/editor/editorState.js';

// Minimal fake visualViewport whose height we can shrink (keyboard open) + whose events we can fire.
function mockVisualViewport(innerHeight = 800) {
  const listeners: Record<string, Array<() => void>> = {};
  const vv = {
    height: innerHeight,
    offsetTop: 0,
    addEventListener: (e: string, cb: () => void) => { (listeners[e] ??= []).push(cb); },
    removeEventListener: (e: string, cb: () => void) => {
      listeners[e] = (listeners[e] ?? []).filter((f) => f !== cb);
    },
    fire: (e: string) => { (listeners[e] ?? []).forEach((cb) => cb()); },
    setHeight(h: number) { this.height = h; this.fire('resize'); },
  };
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/'); // reset the ?kbfloat param between tests
});

function InsetProbe() {
  const inset = useKeyboardInset();
  return <div data-testid="inset">{inset}</div>;
}

describe('useKeyboardInset', () => {
  it('is 0 when the keyboard is closed and equals the overlap when it opens', () => {
    const vv = mockVisualViewport(800);
    render(<InsetProbe />);
    expect(screen.getByTestId('inset').textContent).toBe('0');
    act(() => { vv.setHeight(500); }); // keyboard takes 300px
    expect(screen.getByTestId('inset').textContent).toBe('300');
    act(() => { vv.setHeight(800); }); // keyboard dismissed
    expect(screen.getByTestId('inset').textContent).toBe('0');
  });

  it('stays 0 when visualViewport is unavailable (graceful degrade)', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    render(<InsetProbe />);
    expect(screen.getByTestId('inset').textContent).toBe('0');
  });
});

const barProps = { active: EMPTY_ACTIVE_STATE, run: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() };
const bar = () => document.querySelector('.editor__mbar') as HTMLElement | null;

describe('MobileEditorBar — float-above-keyboard (#66)', () => {
  it('floats by default and lifts by the keyboard overlap when it opens', () => {
    const vv = mockVisualViewport(800);
    render(<MobileEditorBar {...barProps} />);
    expect(bar()!.className).toContain('editor__mbar--floating');
    expect(bar()!.className).not.toContain('editor__mbar--lifted');
    expect(bar()!.style.transform).toBe('translateY(-0px)');

    act(() => { vv.setHeight(540); }); // keyboard 260px
    expect(bar()!.className).toContain('editor__mbar--lifted');
    expect(bar()!.style.transform).toBe('translateY(-260px)');
  });

  it('?kbfloat=off reverts to the sticky bar (no floating/lift, no transform)', () => {
    window.history.replaceState(null, '', '/?kbfloat=off');
    const vv = mockVisualViewport(800);
    render(<MobileEditorBar {...barProps} />);
    act(() => { vv.setHeight(500); });
    expect(bar()!.className).not.toContain('editor__mbar--floating');
    expect(bar()!.className).not.toContain('editor__mbar--lifted');
    expect(bar()!.style.transform).toBe('');
  });
});
