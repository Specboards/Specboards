import { revalidatePath } from "next/cache";

import { isTransitionMode, type TransitionMode } from "@specboards/core";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  getTransitionMode,
  listStatuses,
  parseStatusStages,
  replaceStatuses,
  setTransitionMode,
} from "@/lib/features-service";
import { canManageProductForScope } from "@/lib/products-service";
import { resolveWorkflowFor } from "@/lib/repo-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statuses — the workspace's workflow stages ([] = built-in
 * default), the effective `transitionMode`, plus the fully-resolved `workflow`
 * (ordered statuses + legal transitions) the PATCH validator enforces. The
 * resolved graph lets API clients (e.g. the CLI's `status --advance`) compute a
 * legal multi-step path without reimplementing the
 * default/config.yml/admin-stage precedence.
 *
 * `?productId=` resolves for one product; without it the response describes the
 * workspace default, which is what a cross-product view runs on.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const scope = authz.scope ?? undefined;
  const productId = new URL(req.url).searchParams.get("productId");
  const [statuses, workflow, transitionMode] = await Promise.all([
    listStatuses(scope),
    resolveWorkflowFor(authz.scope ?? null, productId),
    getTransitionMode(scope, productId),
  ]);
  return Response.json({
    statuses,
    transitionMode,
    workflow: {
      statuses: workflow.statuses,
      transitions: workflow.transitions,
    },
  });
}

/**
 * PATCH /api/v1/statuses — set a transition mode
 * ({ transitionMode: "strict" | "flexible" | null, productId?: string }).
 *
 * With a `productId` this configures that product and needs product-admin
 * rights on it (a workspace owner has them everywhere); `transitionMode: null`
 * reverts the product to inheriting the workspace default. Without one it sets
 * the workspace default itself, which governs every product that has not
 * overridden it, and stays owner-only.
 *
 * The gate here is so a caller without rights gets a 403 rather than a failed
 * write; the database enforces the same rule again, which is the check that
 * actually holds (see migration 0064). Stage gates are unaffected by either
 * mode.
 */
export async function PATCH(req: Request) {
  const parsedProduct = await readProductId(req);
  if (!parsedProduct.ok) return parsedProduct.response;
  const { productId, body } = parsedProduct;

  // The workspace default keeps the owner-only gate it has always had. A
  // product's own setting is the widening: membership to get a scope, then a
  // product-admin check against that product.
  const authz = productId
    ? await resolveReadScope(req)
    : await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const scope = authz.scope ?? undefined;

  if (
    productId &&
    !(await canManageProductForScope(productId, scope))
  ) {
    return Response.json(
      { error: "Only a product admin or the workspace owner can do this." },
      { status: 403 },
    );
  }

  const raw = (body as { transitionMode?: unknown } | null)?.transitionMode;
  // `null` is "inherit the workspace default", which only a product can do.
  const reverting = raw === null;
  if (!isTransitionMode(raw) && !reverting) {
    return Response.json(
      { error: 'transitionMode must be "strict", "flexible", or null.' },
      { status: 422 },
    );
  }
  if (reverting && !productId) {
    return Response.json(
      {
        error:
          "The workspace default has nothing to inherit from; give it a mode.",
      },
      { status: 422 },
    );
  }

  const transitionMode = await setTransitionMode(
    reverting ? null : (raw as TransitionMode),
    scope,
    productId,
  );
  for (const path of [
    "/[org]/[product]/backlog",
    "/[org]/[product]/roadmap",
    "/[org]/settings/work-cards",
  ])
    revalidatePath(path, "page");
  return Response.json({ transitionMode });
}

/**
 * Read the body once and pull `productId` out of it, because which
 * authorization the request needs depends on whether it is there. Reading the
 * body is destructive, so the parsed value is handed back for PATCH to reuse.
 */
async function readProductId(req: Request): Promise<
  | { ok: true; productId: string | null; body: unknown }
  | { ok: false; response: Response }
> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed;
  const raw = (parsed.body as { productId?: unknown } | null)?.productId;
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return {
      ok: false,
      response: Response.json(
        { error: "productId must be a product id, or omitted." },
        { status: 422 },
      ),
    };
  }
  return { ok: true, productId: raw ?? null, body: parsed.body };
}

/**
 * PUT /api/v1/statuses — replace the workspace's workflow stages. Admin-only
 * (it reshapes every member's board and re-homes orphaned items); local file
 * mode is ungated.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const scope = authz.scope ?? undefined;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const statuses = await replaceStatuses(parseStatusStages(body), scope);
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/[product]/roadmap",
      "/[org]/settings/work-cards",
    ])
      revalidatePath(path, "page");
    return Response.json({ statuses });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
