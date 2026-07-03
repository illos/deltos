/**
 * Unified input-transform pipeline ([ROAD-0007]) — one registry + one runner for every input-triggered
 * transform, consumed by thin generic call sites (native handleTextInput / deckAdapter / the
 * appendTransaction bulk leg). See docs/design/unified-input-transform-pipeline.md.
 */
export { TransformRegistry } from './registry.js';
export type { InsertHandler, BulkTransform } from './registry.js';
export { inputPipelineTag } from './gate.js';
export { runPreInsert } from './runner.js';
export { buildInputPipelinePlugin } from './plugin.js';
export { compileEditChain } from './editChains.js';
export { undoLastTransform } from './undoTransform.js';
