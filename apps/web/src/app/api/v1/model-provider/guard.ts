import { authorizeOrgAdminBrowserOnly, type ScopeResult } from "@/lib/auth-session";

/**
 * Authorization shared by every `/api/v1/model-provider` route: workspace owner,
 * signed in through a browser, never an API key.
 *
 * The scope model already says this surface is not delegable. `SCOPE_RESOURCES`
 * deliberately omits `model-provider`, and `api-scopes.test.ts` records why:
 * this decides where the workspace's prompts get sent, so a key that could
 * rewrite it could repoint inference at an endpoint of its choosing and read
 * everything the assistant is asked.
 *
 * That was only ever half true. `authorizeOrgAdmin` resolves an API key before
 * the session cookie, so an owner's wildcard or pre-scopes key reached all five
 * of these routes with no browser session anywhere. Omitting the resource from
 * the vocabulary stops a *new* key naming it; it never stopped an existing
 * broad key from arriving.
 *
 * One helper rather than the check inline in five files, because five copies of
 * a refusal is five chances for the sixth route to forget it.
 */
const KEY_REFUSAL =
  "The model connection is managed from a signed-in browser session, never " +
  "with an API key.";

export function authorizeModelProviderAdmin(req: Request): Promise<ScopeResult> {
  return authorizeOrgAdminBrowserOnly(req, KEY_REFUSAL);
}
