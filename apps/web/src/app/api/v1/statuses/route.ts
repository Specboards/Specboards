import { revalidatePath } from "next/cache";

import { isTransitionMode, type TransitionMode } from "@specboards/core";

import {
  authorizeCardsWrite,
  CARDS_REVALIDATE_PATHS,
  readCardsProductId,
} from "@/lib/api/cards-scope";
import { resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  getTransitionMode,
  listStatuses,
  parseStatusStages,
  replaceStatuses,
  setTransitionMode,
} from "@/lib/features-service";

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
  const productId = readCardsProductId(req);
  const [statuses, workflow, transitionMode] = await Promise.all([
    listStatuses(scope, productId),
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
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

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
  for (const path of CARDS_REVALIDATE_PATHS) revalidatePath(path, "page");
  return Response.json({ transitionMode });
}

/**
 * PUT /api/v1/statuses - replace a product's workflow stages, or the workspace
 * default's when `productId` is omitted. Stages are the board's columns, and a
 * replace re-homes any item left in a stage that no longer exists, so writing
 * needs product-admin rights (or workspace ownership for the default). Local
 * file mode is ungated.
 *
 * An empty list is how a product goes back to inheriting: it owns no stage rows
 * again, so resolution falls through to the workspace default. That is refused
 * without a `productId`, since the workspace default has nothing to inherit
 * from and an empty array there is more likely a client bug.
 *
 * This handler was deleted by accident in #259, which made these settings
 * per-product and rewrote the file: the client kept sending PUT here and got a
 * 405, so Settings > Cards could not save, override, or revert its stages.
 * Mirrors the sibling stage-gates route, which the same commit did convert.
 */
export async function PUT(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const statuses = await replaceStatuses(
      parseStatusStages(body, { allowEmpty: productId !== null }),
      scope,
      productId,
    );
    for (const path of CARDS_REVALIDATE_PATHS) revalidatePath(path, "page");
    return Response.json({ statuses });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
