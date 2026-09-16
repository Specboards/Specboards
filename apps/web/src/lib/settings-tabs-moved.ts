/**
 * The Integrations tabs that moved to Agents, and where they went.
 *
 * Four tabs left Integrations when the Agents area was created: the MCP
 * endpoint and connected agents, agent identities, the model connection, and
 * the usage ledger. Bookmarks, the older `/settings/api-keys` style redirect
 * stubs, and the assistant panel's "change the model" link all point at the
 * old `?tab=` keys, and a deep link that silently lands on the wrong tab is
 * worse than one that 404s, because nobody reports it.
 *
 * Kept as data, in its own module, so the Integrations page can forward an old
 * link without the mapping being an inline literal that a later rename misses.
 * `settings-tabs-moved.test.ts` pins it against the tab keys the Agents page
 * actually renders.
 */

/** Old Integrations `?tab=` key -> the Agents `?tab=` key it became. */
export const MOVED_TO_AGENTS: Readonly<Record<string, string>> = {
  // "MCP" described the protocol; "Connections" describes what the tab is for,
  // and the card beside it was already called Connected agents.
  mcp: "connections",
  // "Agents" inside a page now called Agents says nothing. These are the
  // service accounts an agent authenticates as.
  agents: "identities",
  model: "model",
  usage: "usage",
};

/**
 * Where an Integrations `?tab=` should go now, or null if it never moved.
 *
 * Returns the destination key rather than a URL: the caller owns the org
 * prefix, and building a path here would duplicate `orgPath`.
 *
 * `Object.hasOwn` rather than a plain index, because `tab` is whatever was in
 * the query string. A plain lookup of "constructor" returns a function, which
 * is truthy, and the page would redirect to a stringified `Object`.
 */
export function movedAgentsTab(tab: string | undefined): string | null {
  if (!tab || !Object.hasOwn(MOVED_TO_AGENTS, tab)) return null;
  return MOVED_TO_AGENTS[tab]!;
}
