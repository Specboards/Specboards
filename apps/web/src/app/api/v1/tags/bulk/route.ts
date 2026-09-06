import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { deleteTags } from "@/lib/tags-service";

export const dynamic = "force-dynamic";

/** Most tags one bulk delete may cover. A larger tidy-up is two clicks. */
const MAX_IDS = 500;

/**
 * POST /api/v1/tags/bulk — delete many tag definitions. Body: { ids }.
 *
 * Admin-only, like the single delete on `/api/v1/tags/:id`, and with the same
 * cascade: each tag comes off every item that carried it. Each result carries
 * its own `itemCount`; there is no total, because summing them would
 * double-count an item that carried two of the selected tags.
 *
 * POST rather than DELETE-with-a-body because a request body on DELETE is
 * allowed but poorly supported, and proxies are within their rights to drop it.
 * A delete that silently arrives with no ids is worse than an unfashionable
 * verb.
 *
 * Per-id failures come back 200 with `failCount > 0`, so one stale id in a
 * selection does not discard the rest; only a malformed request is a 422.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const ids =
    typeof body === "object" && body !== null && "ids" in body
      ? (body as { ids: unknown }).ids
      : undefined;

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return Response.json(
      { error: "ids must be an array of tag ids." },
      { status: 422 },
    );
  }
  if (ids.length === 0) {
    return Response.json({ error: "Select at least one tag." }, { status: 422 });
  }
  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: `Delete at most ${MAX_IDS} tags at a time.` },
      { status: 422 },
    );
  }

  const result = await deleteTags(ids as string[], authz.scope ?? undefined);
  revalidateCardPages();
  return Response.json(result);
}
