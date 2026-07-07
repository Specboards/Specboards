import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

/**
 * RFC 9728 path-suffixed variant: for the resource https://host/api/mcp,
 * clients request /.well-known/oauth-protected-resource/api/mcp. Same
 * metadata as the root document.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = getAuth();
  if (!auth) return new Response(null, { status: 404 });
  return oAuthProtectedResourceMetadata(auth)(req);
}
