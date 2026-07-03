import { PluginKey } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';

/**
 * Plugin-state record of the last applied insert transform — feeds the backspace-revert command (D3).
 * The runner sets it as meta on the winning tr (rides the plugin's own key, exactly like
 * prosemirror-inputrules); the plugin's state.apply holds it until the next selection/doc change.
 * Own module so runner.ts and plugin.ts share it without a cycle.
 */
export interface AppliedTransformRecord {
  transform: Transaction;
  from: number;
  to: number;
  text: string;
}

export const inputPipelineKey = new PluginKey<AppliedTransformRecord | null>('inputPipeline');
