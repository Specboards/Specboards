import { renderInfoEmail, sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Public "Request access" intake for the pre-v1 invite-only beta. The marketing
 * site (www.specboards.ai) posts here cross-origin; we email the review inbox
 * (contact@specboard.ai) and send the requester a confirmation, both via the
 * app's existing Postmark service (from no-reply@specboards.ai). No account or
 * DB row is created: the team approves by sending an org invitation, which is
 * what actually unlocks sign-up (see access-gate.ts).
 */

/** Where review notifications land. Override with ACCESS_REQUEST_NOTIFY_EMAIL. */
const NOTIFY_EMAIL = process.env.ACCESS_REQUEST_NOTIFY_EMAIL?.trim() || "contact@specboard.ai";

/** Browser origins allowed to POST here (the marketing site + local dev). */
function allowedOrigins(): string[] {
  const fromEnv = process.env.ACCESS_REQUEST_ALLOWED_ORIGINS?.trim();
  if (fromEnv) return fromEnv.split(",").map((o) => o.trim()).filter(Boolean);
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
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Best-effort per-IP throttle. In-memory, so it's advisory on a multi-instance
 * deploy, but it blunts casual abuse of an unauthenticated, email-sending
 * endpoint. Postmark and the required fields are the real backstops.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

function clientIp(req: Request): string {
  return (
    req.headers.get("fly-client-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

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
  if (!EMAIL_RE.test(email)) return json({ error: "A valid email address is required." }, 400);
  if (!company) return json({ error: "Please tell us your company." }, 400);
  if (!useCase) return json({ error: "Please tell us how you'd like to use Specboards." }, 400);

  if (rateLimited(clientIp(req))) {
    return json(
      { error: "Too many requests. Please try again later or email contact@specboard.ai." },
      429,
    );
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
    footer: "Approve by sending an org invitation to this address from the app.",
  });

  // Confirm to the requester so they know it went through.
  const confirm = renderInfoEmail({
    name,
    intro: [
      "Thanks for requesting access to Specboards. We've received your request and our team will review it shortly.",
      "We'll follow up at this address. If you have any questions in the meantime, just reply to contact@specboard.ai.",
    ],
    footer: "You're receiving this because you requested access at specboards.ai.",
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
      { error: "We couldn't submit your request. Please email contact@specboard.ai." },
      502,
    );
  }

  return json({ ok: true }, 200);
}
