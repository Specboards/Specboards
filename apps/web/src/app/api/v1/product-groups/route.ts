import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  createProductGroup,
  listProductGroups,
  parseCreateProductGroupInput,
} from "@/lib/product-groups-service";
import { GroupError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/product-groups — the workspace's product groups. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const groups = await listProductGroups(authz.scope ?? undefined);
  return Response.json({ groups });
}

/** POST /api/v1/product-groups — create a group. Organization-admin only. */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const group = await createProductGroup(
      parseCreateProductGroupInput(body),
      authz.scope ?? undefined,
    );
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/[product]/roadmap",
      "/[org]/settings/products",
    ])
      revalidatePath(path, "page");
    return Response.json({ group }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof GroupError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
