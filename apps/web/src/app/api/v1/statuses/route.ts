import { revalidatePath } from "next/cache";

import { isTransitionMode, type TransitionMode } from "@specboards/core";

import {
  authorizeCardsWrite,
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
  for (const path of [
    "/[org]/[product]/backlog",
    "/[org]/[product]/roadmap",
    "/[org]/settings/work-cards",
  ])
    revalidatePath(path, "page");
  return Response.json({ transitionMode });
}
