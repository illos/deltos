/**
 * Pickables fetch for the SEPARATE OAuth consent surface (ROAD-0011 P1 §1.3). This surface has no Dexie and
 * no app shell, so its resource picker cannot read notebooks/notes from the local store the way the in-app
 * Settings picker does — it fetches them from the server (GET /api/account/pickables), bearer-authed with the
 * live consent session.
 *
 * Two-engines-by-consumer: note search here is the SERVER engine (D1/FTS behind the endpoint), NOT the
 * client fuzzy engine (lib/search.ts) the in-app picker uses. Kept self-contained like the rest of surfaceApi
 * (no app store): the bearer is passed in.
 */
import type { PickablesResponse } from '@deltos/shared';

const EMPTY: PickablesResponse = { notebooks: [], notes: [] };

/**
 * Fetch the account's pickable notebooks (+ note matches when `q` is given). Returns an empty set on any
 * failure — the picker degrades to "no notebooks / no matches" rather than breaking the consent flow.
 */
export async function fetchPickables(bearer: string, q?: string): Promise<PickablesResponse> {
  const query = q?.trim();
  const url = query ? `/api/account/pickables?q=${encodeURIComponent(query)}` : '/api/account/pickables';
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  } catch {
    return EMPTY;
  }
  if (!res.ok) return EMPTY;
  try {
    return (await res.json()) as PickablesResponse;
  } catch {
    return EMPTY;
  }
}
