import { handleMcpMessage, resolveMcpAuth, rpcError } from "@/lib/mcp/rpc";

/**
 * POST /api/mcp - the hosted Model Context Protocol endpoint. Coding agents
 * (Claude Code / Claude Desktop / claude.ai) point a remote MCP server at
 * this URL and authenticate one of two ways:
 *
 *  - OAuth: an unauthenticated request gets 401 + WWW-Authenticate, the
 *    client discovers the authorization server (Better Auth mcp plugin),
 *    registers itself, and sends the user through sign-in + consent.
 *  - A personal Specboard API key: Authorization: Bearer sb_...
 *
 * One endpoint serves both self-host and SaaS. Tools call the same service
 * layer as /api/v1, so auth, the status workflow, and webhooks all match the
 * web app. Transport is stateless Streamable HTTP: a JSON-RPC request (or
 * batch) in, a JSON-RPC response (or batch) out.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 401 challenge pointing at the protected-resource metadata (RFC 9728), which
 * is how an MCP client learns where to run the OAuth flow. The origin comes
 * from APP_URL / BETTER_AUTH_URL when set (same chain as auth.ts; inside the
 * Fly container the request URL is the container's 0.0.0.0 bind address, not
 * the public origin), falling back to the request origin for self-host/dev.
 */
function unauthorized(req: Request): Response {
  const origin =
    (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim() ||
    new URL(req.url).origin;
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`;
  return Response.json(
    rpcError(null, -32000, "Unauthorized: authentication required"),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": challenge,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      },
    },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"));
  }

  const auth = await resolveMcpAuth(req);
  if (!auth.ok && auth.unauthenticated) {
    return unauthorized(req);
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    const response = await handleMcpMessage(message, auth);
    if (response) responses.push(response);
  }

  // Notifications only (no responses): acknowledge with 202 and no body.
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

/** SSE server-to-client streaming is unused; the endpoint is POST-only. */
export function GET() {
  return new Response(
    "This is a Specboard MCP endpoint. Connect with an MCP client over POST " +
      "(Streamable HTTP); authenticate via OAuth (the client prompts you to " +
      "sign in) or an Authorization: Bearer sb_... API key.",
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** Stateless: there is no session to terminate, but answer DELETE cleanly. */
export function DELETE() {
  return new Response(null, { status: 204 });
}
