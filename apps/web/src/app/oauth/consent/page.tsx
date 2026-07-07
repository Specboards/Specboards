import { redirect } from "next/navigation";

import { eq, schema } from "@specboard/db";

import { OAuthConsentForm } from "@/components/oauth-consent-form";
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";

export const metadata = { title: "Authorize access · Specboard" };
export const dynamic = "force-dynamic";

/**
 * OAuth consent screen for the MCP flow. The authorize endpoint redirects
 * here (every request is forced through consent, see auth.ts) with the
 * pending code and client id in the query; approving or denying POSTs to
 * Better Auth's /oauth2/consent, which answers with the redirect back to the
 * requesting client.
 */
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const consentCode = typeof params.consent_code === "string" ? params.consent_code : null;
  const clientId = typeof params.client_id === "string" ? params.client_id : null;
  const scope = typeof params.scope === "string" ? params.scope : "";

  const user = await getServerSessionUser();
  if (!user) redirect("/sign-in");
  if (!consentCode || !clientId) redirect("/");

  // Show who is asking. The client registered itself via DCR, so the name is
  // self-reported; the id is the authoritative bit.
  const db = getDb();
  const client = db
    ? (
        await db
          .select({ name: schema.oauthApplications.name })
          .from(schema.oauthApplications)
          .where(eq(schema.oauthApplications.clientId, clientId))
          .limit(1)
      )[0]
    : undefined;
  if (!client) redirect("/");

  return (
    <OAuthConsentForm
      clientName={client.name ?? "An MCP client"}
      userEmail={user.email}
      scopes={scope.split(" ").filter(Boolean)}
      consentCode={consentCode}
    />
  );
}
