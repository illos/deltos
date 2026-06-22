/**
 * Shared vitest setup (task #65). Runs before every test file in BOTH environments — guarded so the
 * node-environment tests (no DOM) skip the DOM bits.
 *
 * Why: jsdom has no layout engine, so ProseMirror's scrollToSelection → coordsAtPos → getClientRects
 * throws whenever an editor command scrollIntoView()s. In the editor render tests (which mount a real
 * EditorView and dispatch transactions) that throw surfaces as an UNHANDLED async error — all tests
 * still pass, but vitest intermittently exits 1, undermining the green-gate. Installing a zero-rect DOM
 * shim globally makes PM's measurement harmless everywhere, so no individual render test needs its own.
 */
if (typeof globalThis.Element !== 'undefined') {
  const rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() { return {}; } };
  const list = { length: 1, item: () => rect, 0: rect, [Symbol.iterator]: function* () { yield rect; } };
  for (const proto of [globalThis.Element?.prototype, globalThis.Range?.prototype, globalThis.Text?.prototype]) {
    if (!proto) continue;
    (proto as unknown as { getClientRects: () => unknown }).getClientRects = () => list;
    (proto as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect;
  }
}
