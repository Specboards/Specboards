import { buildOpenApiDocument } from "@/lib/openapi";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json — the OpenAPI 3.0 description of the public API.
 * Unauthenticated: it describes the surface (endpoints, params, auth), not any
 * workspace data. The `servers` URL is this deployment's origin.
 */
export async function GET(req: Request) {
  const origin =
    (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim() ||
    new URL(req.url).origin;
  return Response.json(buildOpenApiDocument(origin));
}
