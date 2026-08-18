import { recordAccessRequest } from "@/lib/access-requests-service";
import { readJsonBody } from "@/lib/api/body";
import { rateLimitKey } from "@/lib/client-ip";
import { getDb } from "@/lib/db";
import { renderInfoEmail, sendEmail } from "@/lib/email";
import { QUOTAS, enforceQuota } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public "Request access" intake for the pre-v1 beta. The marketing site
 * (www.specboards.ai) posts here cross-origin; we record the request in
 * `access_requests`, email the review inbox (contact@specboard.ai), and send
 * the requester a confirmation, the mail going via the app's existing Postmark
 * service (from no-reply@specboards.ai).
 *
 * The stored row is the admin portal's review queue. Approving it there emails
 * the requester the sign-up code; that code, not any row here, is what unlocks
 * sign-up (see access-gate.ts). No account is created at any point.
 *
 * Local file mode has no Postgres, so there is nowhere to persist and the
 * endpoint stays email-only there.
 */

/** Where review notifications land. Override with ACCESS_REQUEST_NOTIFY_EMAIL. */
const NOTIFY_EMAIL =
  process.env.ACCESS_REQUEST_NOTIFY_EMAIL?.trim() || "contact@specboard.ai";

/** Browser origins allowed to POST here (the marketing site + local dev). */
function allowedOrigins(): string[] {
  const fromEnv = process.env.ACCESS_REQUEST_ALLOWED_ORIGINS?.trim();
  if (fromEnv)
    return fromEnv
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  return [
    "https://www.specboards.ai",
    "https://specboards.ai",
    // Kept during the domain transition: the marketing site posts here
    // cross-origin and may still be served from the old domain until its own
    // DNS moves. Drop these once specboard.ai is fully retired.
    "https://www.specboard.ai",
    "https://specboard.ai",
    "http://localhost:3001",
  ];
}

/** CORS headers for an allowed origin (echoed back), else a locked-down set. */
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && allowedOrigins().includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow || "https://www.specboards.ai",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin")),
  });
}

/**
 * Throttle this unauthenticated, email-sending endpoint.
 *
 * The counters live in Postgres (`operation_limits`, via `consumeQuota`), so
 * the limit holds across machines and restarts. It used to be a module-level
 * `Map`, which its own comment called "advisory on a multi-instance deploy":
 * Fly keeps at least two machines warm, so the effective limit was
 * `5 x machines`, and every deploy reset it. The mechanism to do this properly
 * already existed - `QUOTAS` simply had no entry for this endpoint.
 *
 * Two quotas: per client, and per email address. See `QUOTAS.accessRequest` for
 * why both.
 *
 * Local file mode has no Postgres, and `enforceQuota` no-ops without a
 * database. Rather than leave a self-host trial with no limit at all, fall back
 * to the old in-process counter there: single-process by definition, so a Map
 * is exactly as good as a table.
 */
const FALLBACK_WINDOW_MS = 60 * 60 * 1000;
const FALLBACK_MAX = 5;
const fallbackHits = new Map<string, number[]>();

function fallbackRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (fallbackHits.get(key) ?? []).filter(
    (t) => now - t < FALLBACK_WINDOW_MS,
  );
  recent.push(now);
  fallbackHits.set(key, recent);
  return recent.length > FALLBACK_MAX;
}

/**
 * Returns a ready-to-return 429 body when the caller is over either quota, else
 * `null`. `email` is counted separately so many IPs cannot mailbomb one
 * address.
 */
async function overQuota(req: Request, email: string): Promise<boolean> {
  const db = getDb();
  const key = rateLimitKey(req, "access-request");

  if (!db) return fallbackRateLimited(key);

  const perClient = await enforceQuota(db, QUOTAS.accessRequest, key);
  if (perClient) return true;
  const perEmail = await enforceQuota(db, QUOTAS.accessRequestEmail, email);
  return perEmail !== null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim to a max length; guards the email body against oversized input. */
function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(req: Request) {
  const headers = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status: number) =>
    Response.json(body, { status, headers });

  // Re-emit any body-guard rejection through `json()` so the CORS headers this
  // cross-origin form needs are preserved on the error response.
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(
      {
        error:
          parsed.response.status === 413
            ? "Request body too large."
            : "Request body must be JSON.",
      },
      parsed.response.status,
    );
  }
  const body = parsed.body as Record<string, unknown>;

  // Honeypot: bots fill hidden fields humans never see. Pretend success so the
  // bot learns nothing, but send nothing.
  if (clip(body.website, 200) || clip(body.url, 200)) {
    return json({ ok: true }, 200);
  }

  const name = clip(body.name, 200);
  const email = clip(body.email, 320).toLowerCase();
  const company = clip(body.company, 200);
  const teamSize = clip(body.teamSize, 40);
  const useCase = clip(body.useCase, 4000);

  if (!name) return json({ error: "Please tell us your name." }, 400);
  if (!EMAIL_RE.test(email))
    return json({ error: "A valid email address is required." }, 400);
  if (!company) return json({ error: "Please tell us your company." }, 400);
  if (!useCase)
    return json(
      { error: "Please tell us how you'd like to use Specboards." },
      400,
    );

  // Checked after validation so a malformed submission does not spend the
  // caller's quota, and before sending so the quota is what bounds the emails.
  if (await overQuota(req, email)) {
    return json(
      {
        error:
          "Too many requests. Please try again later or email contact@specboard.ai.",
      },
      429,
    );
  }

  // Persist the row that becomes the portal's queue. A storage failure is
  // logged and the request still goes out by email: the review inbox was the
  // whole mechanism before this table existed and still reaches a human, so
  // degrading to it beats failing the submission and telling a prospect to go
  // away. The notification says which of the two happened, because a request
  // that never made it into the queue is one the team has to work by hand.
  const db = getDb();
  let queued = false;
  if (db) {
    try {
      await recordAccessRequest(db, { name, email, company, teamSize, useCase });
      queued = true;
    } catch (err) {
      console.error("[access-request] persist failed", err);
    }
  }

  // Notify the review inbox with everything the team needs to decide.
  const notify = renderInfoEmail({
    intro: `New Specboards access request from ${name} (${company}).`,
    details: [
      { label: "Name", value: name },
      { label: "Email", value: email },
      { label: "Company", value: company },
      ...(teamSize ? [{ label: "Team size", value: teamSize }] : []),
      { label: "Use case", value: useCase },
    ],
    footer: queued
      ? "Review it at https://admin.specboards.ai/access-requests. Approving there emails the requester their sign-up code."
      : "NOTE: this request could not be saved, so it is NOT in the admin portal queue. Follow it up from this email.",
  });

  // Confirm to the requester so they know it went through.
  const confirm = renderInfoEmail({
    name,
    intro: [
      "Thanks for requesting access to Specboards. We've received your request and our team will review it shortly.",
      "We'll follow up at this address. If you have any questions in the meantime, just reply to contact@specboard.ai.",
    ],
    footer:
      "You're receiving this because you requested access at specboards.ai.",
  });

  try {
    await Promise.all([
      sendEmail({
        to: NOTIFY_EMAIL,
        subject: `Access request: ${name} (${company})`,
        textBody: notify.textBody,
        htmlBody: notify.htmlBody,
      }),
      sendEmail({
        to: email,
        subject: "We received your Specboards access request",
        textBody: confirm.textBody,
        htmlBody: confirm.htmlBody,
      }),
    ]);
  } catch (err) {
    console.error("[access-request] send failed", err);
    return json(
      {
        error:
          "We couldn't submit your request. Please email contact@specboard.ai.",
      },
      502,
    );
  }

  return json({ ok: true }, 200);
}
