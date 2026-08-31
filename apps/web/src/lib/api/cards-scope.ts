import { readJsonBody } from "@/lib/api/body";
import {
  authorizeOrgAdmin,
  resolveReadScope,
  type ScopeResult,
} from "@/lib/auth-session";
import { canManageProductForScope } from "@/lib/products-service";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * Shared authorization for the Settings > Cards routes, all of which configure
 * either one product or the workspace default that unconfigured products
 * inherit.
 *
 * Who may write which is the widening this epic introduced, and it is the same
 * sentence for every one of these settings: a product admin configures their
 * own product, the workspace owner configures any, and the workspace default
 * stays owner-only. Writing that out once means a new Cards setting cannot
 * quietly ship with a different rule, and it means the "which product?" parsing
 * is not repeated five times with five chances to forget the type check.
 *
 * The gate here exists so a caller without rights gets a 403 instead of a write
 * that matches no rows. RLS enforces the same rule in the database, and that is
 * the check that actually holds; see migrations 0064 and 0065.
 */

type CardsWriteScope =
  | { ok: true; scope: WorkspaceScope | undefined; productId: string | null; body: unknown }
  | { ok: false; response: Response };

const FORBIDDEN = Response.json(
  { error: "Only a product admin or the workspace owner can do this." },
  { status: 403 },
);

/**
 * Read `productId` off a write request's body, pick the matching authorization,
 * and run it. The body is returned because reading it is destructive and the
 * caller still needs its other fields.
 */
export async function authorizeCardsWrite(
  req: Request,
): Promise<CardsWriteScope> {
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
  const productId = raw ?? null;

  // Which authorization to run depends on what is being configured, so the
  // productId has to be parsed before the gate rather than after it.
  const authz: ScopeResult = productId
    ? await resolveReadScope(req)
    : await authorizeOrgAdmin(req);
  if (!authz.ok) return authz;
  const scope = authz.scope ?? undefined;

  if (productId && !(await canManageProductForScope(productId, scope))) {
    return { ok: false, response: FORBIDDEN };
  }
  return { ok: true, scope, productId, body: parsed.body };
}

/**
 * The product a read request is asking about, from `?productId=`. Reads need no
 * extra gate: RLS already limits a member to products they can see, and a
 * product they cannot read resolves to the workspace default rather than
 * leaking that the product exists.
 */
export function readCardsProductId(req: Request): string | null {
  return new URL(req.url).searchParams.get("productId");
}

/** Paths whose rendered output depends on any Cards setting. */
export const CARDS_REVALIDATE_PATHS = [
  "/[org]/[product]/backlog",
  "/[org]/[product]/roadmap",
  "/[org]/settings/work-cards",
] as const;
