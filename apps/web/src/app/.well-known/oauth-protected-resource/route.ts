import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint:
 * tells clients which authorization server protects /api/mcp. Also served
 * path-suffixed at /.well-known/oauth-protected-resource/api/mcp, which is
 * where spec-following clients look first for the /api/mcp resource.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = getAuth();
  if (!auth) return new Response(null, { status: 404 });
  return oAuthProtectedResourceMetadata(auth)(req);
}
