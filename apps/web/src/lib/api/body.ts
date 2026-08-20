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
 *
 * The MCP (`/api/mcp`) and GitHub webhook routes need the RAW text (JSON-RPC
 * batching, and HMAC over the exact received bytes), so they cannot use a
 * JSON-returning helper. They use {@link readTextBodyWithin} below, which is
 * the same policy without the parse step.
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

/**
 * Read the raw body as text, refusing as soon as it exceeds `limit` BYTES.
 *
 * Two things this fixes over the `await req.text()` + check that the MCP and
 * webhook routes each grew their own copy of:
 *
 * 1. **It stops reading.** Checking after `req.text()` means the whole body is
 *    already in memory; the cap then bounds the response, not the allocation.
 *    A `Content-Length` fast path covers the ordinary case, but a chunked
 *    request need not send one. Here the limit is enforced against a running
 *    total as chunks arrive, and the stream is cancelled on the chunk that
 *    crosses it, so at most `limit` + one chunk is ever held.
 * 2. **It counts bytes.** `raw.length` is UTF-16 code units: a multi-byte body
 *    passes a byte-named limit at up to ~3x its stated size (4x for astral
 *    characters). Decoding is incremental, and the total is measured on the
 *    encoded chunks, which is what the limit is denominated in.
 *
 * Returns the decoded text, or `null` when the limit was exceeded (the caller
 * shapes its own 413: JSON-RPC error vs plain JSON). Logs `request-oversized`
 * either way, so oversized attempts stay greppable in the Fly logs.
 *
 * Note there is no outer bound to fall back on: `fly.toml` configures no
 * request-size cap and Fly's proxy does not impose one, so this check is the
 * only thing between a request body and a 512 MB machine (`[[vm]]` size). That
 * is the argument for enforcing it as the bytes arrive rather than after.
 */
export async function readTextBodyWithin(
  req: Request,
  limit: number,
  endpoint: string,
): Promise<string | null> {
  // Fast path: trust a present Content-Length (Next/undici enforce it) and
  // reject before reading a byte. The streaming check below is the backstop
  // for a request that omits or lies about it.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    logSecurityEvent("request-oversized", { endpoint, bytes: declared });
    return null;
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  // `stream: true` so a multi-byte character split across a chunk boundary is
  // held until its remaining bytes arrive rather than becoming U+FFFD.
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        logSecurityEvent("request-oversized", { endpoint, bytes });
        // Tell the sender to stop rather than draining the rest politely.
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/** The 413 for an oversized JSON body. Logging is the reader's job. */
function tooLarge(limit: number): JsonBodyResult {
  return {
    ok: false,
    response: Response.json(
      { error: `Request body too large (limit ${limit} bytes).` },
      { status: 413 },
    ),
  };
}

/**
 * Whether a Content-Type names JSON.
 *
 * Accepts `application/json` and the `+json` structured suffix (`application/
 * merge-patch+json` and friends), with any parameters after a `;` ignored so
 * `application/json; charset=utf-8` passes. Case-insensitive, because the
 * header is.
 */
function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const type = value.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

export async function readJsonBody(
  req: Request,
  opts: { limit?: number; endpoint?: string } = {},
): Promise<JsonBodyResult> {
  const limit = opts.limit ?? DEFAULT_MAX_BODY_BYTES;
  const endpoint = opts.endpoint ?? new URL(req.url).pathname;

  // ── Why the content type is required ──────────────────────────────────────
  // A cross-site HTML form can only send three content types, and
  // `text/plain` is one of them: `<form enctype="text/plain">` posts a body
  // this parser was happy to accept. Requiring JSON means a form cannot reach
  // any of these endpoints at all, whatever the cookie policy is, because a
  // form cannot set this header. `fetch` and XHR can, but those are already
  // governed by CORS.
  //
  // This is the second of two layers, beside the origin check in middleware,
  // and both are deliberately independent of `SameSite=Lax`, which is currently
  // the only thing blocking the attack (see `lib/csrf-origin.ts`).
  //
  // Not a hardship for real clients: anything posting JSON already sets this,
  // and one that does not gets a message saying exactly what to add.
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return {
      ok: false,
      response: Response.json(
        { error: "Request body must be JSON. Set Content-Type: application/json." },
        { status: 415 },
      ),
    };
  }

  // Shares the streaming reader with the MCP and webhook routes, so the cap
  // bounds what is allocated rather than what is returned. It logs the
  // oversized event itself.
  const raw = await readTextBodyWithin(req, limit, endpoint);
  if (raw === null) return tooLarge(limit);

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Request body must be JSON." }, { status: 400 }),
    };
  }
}
