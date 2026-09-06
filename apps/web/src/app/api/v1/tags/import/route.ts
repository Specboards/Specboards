import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { InvalidPatchError } from "@/lib/service-errors";
import { importTags } from "@/lib/tags-service";
import { TagError } from "@specboards/core";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tags/import — bulk add or rename tags from a CSV.
 *
 * Body: `{ csv, apply }`. With `apply` false (the default) nothing is written
 * and the response is the plan: what each row would do, and why a row that
 * cannot be run cannot. With `apply` true the same plan is computed again from
 * the live registry and then run.
 *
 * Re-planning on apply rather than accepting the plan the client previewed is
 * the point of the split. The preview is a screenshot of a registry other
 * people are also editing; measuring the file again at the moment of writing
 * means a tag added in between turns a create into a no-op or a rename into a
 * merge, instead of failing partway through a file.
 *
 * Admin-only. A plain create is open to any member on `POST /api/v1/tags`, but
 * this endpoint also renames and merges, which rewrite other people's cards.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const csv =
    typeof body === "object" && body !== null && "csv" in body
      ? (body as { csv: unknown }).csv
      : undefined;
  const apply =
    typeof body === "object" && body !== null && "apply" in body
      ? (body as { apply: unknown }).apply === true
      : false;

  if (typeof csv !== "string") {
    return Response.json({ error: "csv must be a string." }, { status: 422 });
  }

  try {
    const result = await importTags(csv, apply, authz.scope ?? undefined);
    // Only an applied import changes what the cards and filters show.
    if (apply) revalidateCardPages();
    return Response.json(result);
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof TagError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
