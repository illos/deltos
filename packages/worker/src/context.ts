import type { Context } from 'hono';
import type { Env } from './env.js';

/** The Hono context shape for this worker, shared so auth and http agree on the same type. */
export type AppContext = Context<{ Bindings: Env }>;
