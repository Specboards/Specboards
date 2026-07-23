import { logSecurityEvent } from "@/lib/security-log";

/**
 * Shared bounded JSON body reader for API routes.
 *
 * Most `/api/v1` handlers used to call `await req.json()` with no size guard,
 * so a client could stream an arbitrarily large body and the route would buffer
 * and parse all of it. This reader caps the body first: it rejects on the
 * `Content-Length` header when present (the fast path), and again on the actual
 * byte length after reading (the backstop for a chunked request that omits or
 * lies about the header). Only then does it parse.
 *
 * Returns the same discriminated union the auth helpers use, so a route reads:
 *
 *   const parsed = await readJsonBody(req);
 *   if (!parsed.ok) return parsed.response;
 *   const body = parsed.body; // unknown, validate as before
 *
 * Oversized rejects are logged via `logSecurityEvent` so abuse is greppable.
 * The MCP (`/api/mcp`) and GitHub webhook routes keep their own bespoke caps:
 * they read the raw text for JSON-RPC batching / HMAC verification and cannot
 * use a JSON-returning helper.
 */

/**
 * Default body ceiling. Matches the MCP endpoint's 1 MB cap; API payloads are
 * metadata-sized and sit far below this. A route with a genuinely larger or
 * smaller payload passes an explicit `limit`.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1 MB

export type JsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

function tooLarge(endpoint: string, bytes: number, limit: number): JsonBodyResult {
  logSecurityEvent("request-oversized", { endpoint, bytes });
  return {
    ok: false,
    response: Response.json(
      { error: `Request body too large (limit ${limit} bytes).` },
      { status: 413 },
    ),
  };
}

export async function readJsonBody(
  req: Request,
  opts: { limit?: number; endpoint?: string } = {},
): Promise<JsonBodyResult> {
  const limit = opts.limit ?? DEFAULT_MAX_BODY_BYTES;
  const endpoint = opts.endpoint ?? new URL(req.url).pathname;

  // Fast path: trust a present Content-Length (Next/undici enforce it) and
  // reject before reading a byte.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return tooLarge(endpoint, declared, limit);
  }

  const raw = await req.text();
  // Byte length, not `raw.length`: a multibyte char is one UTF-16 code unit but
  // several bytes, so string length would under-count against a byte limit.
  const bytes = Buffer.byteLength(raw);
  if (bytes > limit) {
    return tooLarge(endpoint, bytes, limit);
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Request body must be JSON." }, { status: 400 }),
    };
  }
}
