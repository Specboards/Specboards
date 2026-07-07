import { oAuthDiscoveryMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) for the MCP OAuth flow.
 * MCP clients resolve this from the WWW-Authenticate challenge on /api/mcp to
 * find the authorize / token / registration endpoints (served by the Better
 * Auth mcp plugin under /api/auth/mcp/*).
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = getAuth();
  if (!auth) return new Response(null, { status: 404 });
  return oAuthDiscoveryMetadata(auth)(req);
}
