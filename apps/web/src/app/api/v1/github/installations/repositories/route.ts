import { cookies } from "next/headers";

import { listInstallationRepositories } from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubApp } from "@/lib/github-app";
import { INSTALL_COOKIE, readInstallCookie } from "@/lib/github-install";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/github/installations/repositories — the repos the admin's pending
 * installation can access, for the connect picker. The installation id comes
 * from the signed cookie set by the setup callback (not the client), so this
 * can only list installations the caller actually performed.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "admin") {
    return Response.json({ error: "Only an admin can connect repositories." }, { status: 403 });
  }

  const jar = await cookies();
  const installationId = readInstallCookie(user.id, jar.get(INSTALL_COOKIE)?.value);
  // No pending installation — the client should show the "Connect GitHub" CTA.
  if (!installationId) {
    return Response.json({ installationId: null, repositories: [] });
  }

  const app = await getGithubApp(db);
  if (!app) {
    return Response.json(
      { error: "GitHub App is not configured." },
      { status: 501 },
    );
  }

  try {
    const repositories = await listInstallationRepositories(app, installationId);
    return Response.json({ installationId, repositories });
  } catch (err) {
    console.error("[github] failed to list installation repositories:", err);
    return Response.json(
      { error: "Couldn't load repositories for this installation." },
      { status: 502 },
    );
  }
}
