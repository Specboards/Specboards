import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { parseSkills, SkillInputError } from "@/lib/ai/skills";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getAppDb } from "@/lib/db";
import { listSkills, replaceSkills } from "@/lib/skills-service";

export const dynamic = "force-dynamic";

/**
 * The workspace's assistant skills.
 *
 * ── Why this is its own resource and not `/assistant/skills` ────────────────
 * API key scopes come from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`). Nesting these under `assistant` would mean a key
 * granted `assistant:write` - "let this agent ask questions about our items" -
 * could also rewrite the standing instructions attached to every future
 * question anyone on the team asks, and to every edit proposed off the back of
 * one. An agent that can edit the skills can arrange to be told to propose
 * whatever it likes, and a reviewer reading the resulting diff has no way to see
 * why. Separate resource, separate grant, deliberately.
 *
 * Reading is member-level, because every member sees the buttons. Writing is
 * admin-only, for the reason above: it is the same class of decision as
 * choosing the model endpoint, which is also admin-only.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error:
      "Assistant skills require a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/**
 * GET /api/v1/assistant-skills - the skills in force, built-ins included.
 *
 * Always returns the merged set rather than the stored rows: what a caller
 * wants to know is what this workspace's assistant can do, and a workspace that
 * has never edited anything stores nothing at all.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  return Response.json({ skills: await listSkills(db, authz.scope) });
}

/**
 * PUT /api/v1/assistant-skills - replace them. Body: { skills: [...] }.
 *
 * A whole-set replace, like the stage gates it sits beside in spirit: the thing
 * being edited is the row of buttons, and the decisions made on that page are
 * about the row as a whole. An empty list is how a workspace goes back to the
 * built-ins exactly as shipped.
 *
 * Only what a team has actually changed is stored, which the browser decides
 * with `skillRowsToStore`. A built-in sent back byte-identical is dropped rather
 * than saved, so opening this page and pressing Save does not silently pin a
 * workspace to today's wording of prompts we still intend to improve.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  try {
    const skills = await replaceSkills(db, authz.scope, parseSkills(body.skills));
    revalidatePath("/[org]/settings/assistant", "page");
    return Response.json({ skills });
  } catch (err) {
    if (err instanceof SkillInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
