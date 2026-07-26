/**
 * Query params that shape *which* view you are looking at rather than filtering
 * its contents: the view toggle, the hierarchy level, the sort, and the
 * timeline's start/end date sources and zoom. Controls that rebuild the query
 * from filter state alone (the filter bar, saved views) have to carry these
 * across, or changing a filter would bounce the user back to the default board
 * at the default level, plotted by the default fields at the default zoom.
 */
const VIEW_PARAM_KEYS = [
  "view",
  "level",
  "sort",
  "start",
  "end",
  "zoom",
] as const;

/** The subset of URLSearchParams this module reads (also satisfied by Next's
 * ReadonlyURLSearchParams). */
interface ParamSource {
  get(name: string): string | null;
}

/**
 * Merge the view-shaping params from `current` into a freshly built `query`,
 * returning the combined query string. Params already present in `query` win,
 * so a caller that deliberately sets e.g. `view` keeps its value.
 */
export function withViewParams(query: string, current: ParamSource): string {
  const params = new URLSearchParams(query);
  for (const key of VIEW_PARAM_KEYS) {
    if (params.has(key)) continue;
    const value = current.get(key);
    if (value) params.set(key, value);
  }
  return params.toString();
}
