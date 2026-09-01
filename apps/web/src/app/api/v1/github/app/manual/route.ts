import { githubAppFrom } from "@specboards/git";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdminBrowserOnly } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { saveCredentials } from "@/lib/github-app";
import { isMultiTenant } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** What `GET /app` gives back, for the fields we derive rather than ask for. */
interface AppIdentity {
  id: number;
  slug: string;
  name: string;
  client_id?: string;
}

/** App ids are numeric. Reject early so a typo is not reported as auth failure. */
const APP_ID_RE = /^\d+$/;

/**
 * Turn a failed `GET /app` into something the operator can act on. The two
 * common mistakes are a private key that belongs to a different App and a key
 * that was regenerated on GitHub after being copied, and both surface as 401.
 */
function credentialErrorMessage(err: unknown): string {
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : null;
  if (status === 401) {
    return (
      "GitHub rejected these credentials. Check that the private key belongs to " +
      "this App ID and has not been regenerated on GitHub since you copied it."
    );
  }
  if (status === 404) {
    return "GitHub has no App with that App ID.";
  }
  return "Couldn't reach GitHub to verify the credentials. Please try again.";
}

/**
 * POST /api/v1/github/app/manual - configure the deployment's GitHub App from
 * credentials the operator created by hand.
 *
 * The one-click manifest flow (`app/create`) cannot be used by an instance
 * GitHub cannot reach: GitHub validates the manifest's webhook URL for public
 * reachability and refuses to create the App at all, whether the hook is active
 * or not, and refuses a manifest with no hook URL either. Since that flow was
 * the only writer of `github_app`, an internal-only deployment previously had
 * no way to connect GitHub whatsoever. This is that way.
 *
 * Body: { appId, privateKey, clientSecret, webhookSecret?, clientId? }.
 *
 * `slug` and `client_id` are read back from `GET /app` rather than asked for:
 * the App itself is the authority on both, and every field we can derive is one
 * fewer the operator can paste wrong. The call doubles as validation, so
 * credentials that do not authenticate are refused here rather than failing
 * later at the first sync with nothing pointing at the cause.
 *
 * Browser-only and owner-only: an API key must not be able to swap the
 * deployment's GitHub identity.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(
    req,
    "Configuring the GitHub App requires signing in from a browser.",
  );
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Configuring GitHub isn't available in local mode." },
      { status: 501 },
    );
  }

  // Same reasoning as the manifest flow: on hosted, GitHub is a single shared
  // App that Specboards owns and configures from env. Letting a tenant write
  // these credentials would overwrite the deployment-wide singleton.
  if (isMultiTenant()) {
    return Response.json(
      { error: "GitHub is managed by Specboards on the hosted plan." },
      { status: 403 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;

  const str = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string).trim() : "");
  const appId = str("appId");
  const privateKey = str("privateKey");
  const clientSecret = str("clientSecret");
  const webhookSecret = str("webhookSecret");
  const suppliedClientId = str("clientId");

  if (!APP_ID_RE.test(appId)) {
    return Response.json(
      { error: "App ID is the numeric id shown on the App's settings page.", field: "appId" },
      { status: 400 },
    );
  }
  if (!privateKey.includes("PRIVATE KEY")) {
    return Response.json(
      {
        error:
          "That doesn't look like a private key. Paste the whole .pem file, " +
          "including the BEGIN and END lines.",
        field: "privateKey",
      },
      { status: 400 },
    );
  }
  if (!clientSecret) {
    return Response.json(
      {
        error:
          "Client secret is required: without it Specboards cannot verify that " +
          "whoever installs the App administers the account it is installed on.",
        field: "clientSecret",
      },
      { status: 400 },
    );
  }

  // Authenticate as the App. A private key that does not match the App id, or
  // one that has been regenerated on GitHub, fails here rather than silently
  // at the first sync.
  let identity: AppIdentity;
  try {
    const app = githubAppFrom({ appId, privateKey });
    const res = await app.octokit.request("GET /app");
    identity = res.data as unknown as AppIdentity;
  } catch (err) {
    console.error("[github] manual credential verification failed:", err);
    return Response.json({ error: credentialErrorMessage(err) }, { status: 400 });
  }

  const clientId = identity.client_id ?? suppliedClientId;
  if (!clientId) {
    return Response.json(
      {
        error:
          "GitHub did not report a client ID for this App. Copy it from the " +
          "App's settings page and enter it here.",
        field: "clientId",
      },
      { status: 400 },
    );
  }

  try {
    await saveCredentials(db, {
      appId: String(identity.id),
      slug: identity.slug,
      clientId,
      clientSecret,
      privateKey,
      // Stored empty when the operator has no webhook configured, which is the
      // normal case for an instance GitHub cannot reach. The webhook route
      // treats an empty secret as unconfigured and refuses deliveries, so this
      // fails closed rather than verifying signatures against "".
      webhookSecret,
    });
  } catch (err) {
    console.error("[github] failed to store manual app credentials:", err);
    return Response.json({ error: "Couldn't save the GitHub credentials." }, { status: 500 });
  }

  return Response.json({
    ok: true,
    slug: identity.slug,
    name: identity.name,
    webhookConfigured: webhookSecret !== "",
  });
}
