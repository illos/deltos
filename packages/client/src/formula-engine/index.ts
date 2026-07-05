/**
 * formula-engine — public API (docs/specs/formula-engine.md). A self-contained, host-agnostic reactive
 * computation core: Value union + dependency-graph engine + the label resolver. NO ProseMirror, DOM, or
 * editor imports anywhere under src/formula-engine/ — the note host adapts it to the editor (Step 2), and a
 * future spreadsheet/database plugin reuses it with its own resolver.
 *
 * PERF BOUNDARY (plugins-lazy-past-first-paint): this module is designed to be a LAZY CHUNK — the editor
 * wiring must reach it ONLY via dynamic `import()` gated on a note actually containing formulas (the
 * content-presence scan), so a formula-free note pays zero bytes and zero work for it. Never static-import
 * this from anything on the entry/eager graph.
 */
export { numberValue, errorValue, isErrorValue, valuesEqual } from './value.js';
export type { Value, ValueErrorCode } from './value.js';
export { createFormulaEngine } from './engine.js';
export type { EngineNode, ReferenceResolver, FormulaEngine } from './engine.js';
export { createLabelResolver } from './labelResolver.js';
export type { LabelIndex } from './labelResolver.js';
