/**
 * GitHub user-identity verification for the App install flow.
 *
 * A GitHub App's post-install callback only proves that a browser finished an
 * install flow, not that the signed-in Specboards user controls the GitHub
 * account the returned `installation_id` belongs to (the id is guessable and
 * swappable). These helpers close that gap: exchange the App's OAuth `code`
 * for a user access token, then check that user's relationship to the
 * installation account. Plain `fetch` throughout; no Octokit App plumbing is
 * needed for the user-scoped endpoints.
 */

/** The App's OAuth client credentials ("identify users" flow). */
export interface GithubOauthCredentials {
  clientId: string;
  clientSecret: string;
}

const GITHUB_API = "https://api.github.com";

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "Specboards",
  "x-github-api-version": "2022-11-28",
};

/**
 * Exchange an OAuth `code` for a user access token. Throws when GitHub
 * rejects the exchange (expired/replayed code, bad credentials); callers
 * treat any throw as "identity not proven" and fail closed.
 */
export async function exchangeGithubUserCode(
  creds: GithubOauthCredentials,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub OAuth code exchange failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`GitHub OAuth code exchange rejected: ${data.error ?? "no token returned"}`);
  }
  return data.access_token;
}

/** The GitHub login of the user a token belongs to. */
export async function getGithubUserLogin(token: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GitHub /user lookup failed (${res.status})`);
  const data = (await res.json()) as { login?: string };
  if (typeof data.login !== "string" || data.login === "") {
    throw new Error("GitHub /user response had no login.");
  }
  return data.login;
}

/** Why an ownership check failed, for logs (never shown to the requester). */
export type OwnershipVerdict =
  | { ok: true; viewerLogin: string }
  | { ok: false; viewerLogin: string; reason: string };

/**
 * Verify that the user behind `token` owns/administers `account`, the
 * org or user a GitHub App installation belongs to:
 *
 * - `User` account: the token's login must be that account.
 * - `Organization` account: the token's own org membership must be active
 *   with role `admin` (GitHub only lets org admins manage App installations).
 * - Anything else (e.g. enterprise): rejected, fail closed.
 *
 * The membership lookup uses the USER'S token, so it also proves the user
 * granted our App their identity; a token for some unrelated user cannot
 * produce an `admin` answer for an org they are not in (404 → fail).
 */
export async function verifyInstallationOwnership(
  token: string,
  account: { login: string; type: string },
): Promise<OwnershipVerdict> {
  const viewerLogin = await getGithubUserLogin(token);

  if (account.type === "User") {
    return viewerLogin.toLowerCase() === account.login.toLowerCase()
      ? { ok: true, viewerLogin }
      : { ok: false, viewerLogin, reason: "installation belongs to a different user account" };
  }

  if (account.type !== "Organization") {
    return { ok: false, viewerLogin, reason: `unsupported account type "${account.type}"` };
  }

  const res = await fetch(
    `${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(account.login)}`,
    { headers: { ...API_HEADERS, authorization: `Bearer ${token}` } },
  );
  // 404: not a member (or membership hidden from this token). Fail closed.
  if (res.status === 404) {
    return { ok: false, viewerLogin, reason: "user is not a member of the organization" };
  }
  if (!res.ok) {
    throw new Error(`GitHub org membership lookup failed (${res.status})`);
  }
  const data = (await res.json()) as { state?: string; role?: string };
  if (data.state !== "active" || data.role !== "admin") {
    return {
      ok: false,
      viewerLogin,
      reason: `membership is ${data.state ?? "unknown"}/${data.role ?? "unknown"}, needs active/admin`,
    };
  }
  return { ok: true, viewerLogin };
}
