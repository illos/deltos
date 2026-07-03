/**
 * Unified input-transform pipeline ([ROAD-0007]) — one registry + one runner for every input-triggered
 * transform, consumed by thin generic call sites (native handleTextInput / deckAdapter / the
 * appendTransaction bulk leg). See docs/design/unified-input-transform-pipeline.md.
 */
export { TransformRegistry } from './registry.js';
export type { InsertTransform, InsertHandler, EditTransform, EditSurface } from './registry.js';
export { inputPipelineTag, isPipelineInput } from './gate.js';
export type { PipelineTag } from './gate.js';
export { runPreInsert, runPostInsert, MAX_MATCH } from './runner.js';
export type { RunnerView } from './runner.js';
export { buildInputPipelinePlugin } from './plugin.js';
export { inputPipelineKey } from './key.js';
export type { AppliedTransformRecord } from './key.js';
export { compileEditChain } from './editChains.js';
