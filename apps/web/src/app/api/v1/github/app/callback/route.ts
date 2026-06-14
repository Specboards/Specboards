import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { saveCredentials } from "@/lib/github-app";
import { APP_SETUP_COOKIE } from "@/lib/github-install";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/** Shape of GitHub's app-manifest conversion response (fields we use). */
interface ConversionResult {
  id: number;
  slug: string;
  client_id?: string;
  webhook_secret: string;
  pem: string;
}

/**
 * GET /api/v1/github/app/callback — GitHub redirects here after the admin
 * creates the App from our manifest, with a one-time `code`. We exchange it for
 * the App's credentials (id, slug, private key, webhook secret), store them
 * encrypted, and bounce back to the Repositories page ready to install.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/app/callback${url.search}`);
    return redirectTo(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "admin") {
    return redirectTo("/repositories?error=forbidden");
  }

  // CSRF: the state must match the nonce we set when starting the flow.
  const jar = await cookies();
  const expected = jar.get(APP_SETUP_COOKIE)?.value;
  jar.delete(APP_SETUP_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return redirectTo("/repositories?error=setup");
  }

  let result: ConversionResult;
  try {
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "SpecBoard",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`conversion failed (${res.status}): ${detail}`);
    }
    result = (await res.json()) as ConversionResult;
  } catch (err) {
    console.error("[github] app manifest conversion failed:", err);
    return redirectTo("/repositories?error=exchange");
  }

  try {
    await saveCredentials(db, {
      appId: String(result.id),
      slug: result.slug,
      clientId: result.client_id ?? null,
      privateKey: result.pem,
      webhookSecret: result.webhook_secret,
    });
  } catch (err) {
    console.error("[github] failed to store app credentials:", err);
    return redirectTo("/repositories?error=store");
  }

  return redirectTo("/repositories?setup=done");
}
