import { eq, repositories } from "@specboards/db";
import { redirect } from "next/navigation";

import { ApiKeysCard } from "@/components/api-keys-card";
import { RepositoriesManager } from "@/components/repositories-manager";
import { SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import type { SetupNotice } from "@/components/repositories-manager/shared";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WebhooksCard } from "@/components/webhooks-card";
import { listApiKeys } from "@/lib/api-keys";
import { appOrigin } from "@/lib/app-origin";
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isGithubConfigured } from "@/lib/github-app";
import {
  loadWorkspaceInstallations,
  NO_INSTALLATIONS,
} from "@/lib/github-connect";
import { leafLevel } from "@specboards/core";

import { orgPath } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import { listProducts } from "@/lib/products-service";
import { listRepoProductLinks } from "@/lib/repo-links-service";
import { isPubliclyReachable } from "@/lib/public-origin";
import { movedAgentsTab } from "@/lib/settings-tabs-moved";
import { isSingleTenant } from "@/lib/tenancy";
import { listWebhookEndpoints } from "@/lib/webhooks-service";
import { currentOrgSlug, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Map the GitHub callback/setup query params to a user-facing banner. */
function noticeFor(
  params: Record<string, string | string[] | undefined>,
): SetupNotice {
  if (params.setup === "done") {
    return {
      kind: "ok",
      message: "GitHub app created. Now install it on your repositories below.",
    };
  }
  if (params.connected === "1") {
    return {
      kind: "ok",
      message: "GitHub installed. Pick the repositories to connect below.",
    };
  }
  const errors: Record<string, string> = {
    forbidden: "Only the owner can set up GitHub.",
    org: "That doesn't look like a valid GitHub organization name.",
    setup: "That setup session expired. Please start again.",
    exchange: "GitHub couldn't finish creating the app. Please try again.",
    store: "Couldn't save the GitHub credentials. Please try again.",
    install: "The installation didn't complete. Please try again.",
    "install-config":
      "GitHub connections are temporarily unavailable: the app is missing its OAuth client credentials. Contact your administrator.",
    "install-denied":
      "We couldn't verify that you're an owner or admin of that GitHub account, so the installation wasn't connected.",
    hosted:
      "GitHub is managed by Specboards on the hosted plan. Just install the app below.",
    origin_not_public:
      "GitHub can't reach this instance, so it will refuse to create the app. " +
      "Creating a GitHub App requires a webhook URL that GitHub can deliver to over " +
      "the public internet. Set APP_URL to a public HTTPS origin for this instance, " +
      "restart it, and try again.",
  };
  const err =
    typeof params.error === "string" ? errors[params.error] : undefined;
  return err ? { kind: "error", message: err } : null;
}

/**
 * Integrations: the services outside Specboards that this workspace talks to.
 *
 * Connected GitHub repositories, outbound webhooks, and the personal API keys
 * people use against our REST API. Keys are per-user (any role); webhooks and
 * repository setup are admin-only. All unavailable in local file mode (no
 * accounts, no server).
 *
 * The MCP endpoint, connected agents, agent identities, the model connection
 * and the usage ledger used to be tabs here and now live under Settings >
 * Agents. The line is whose service it is: GitHub and a customer's own webhook
 * receiver are somebody else's, while the MCP endpoint is our front door and
 * belongs with the rest of the agent configuration. Old `?tab=` links are
 * forwarded rather than dropped - see `lib/settings-tabs-moved.ts`.
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;
  // Forward a link to a tab that moved to Agents before doing any work: a
  // bookmark or an older redirect stub landing on the default tab instead of
  // the one it named is the kind of breakage nobody reports.
  const moved = movedAgentsTab(tab);
  if (moved) {
    redirect(
      orgPath(await currentOrgSlug(), `/settings/agents?tab=${moved}`),
    );
  }

  const access = await requireWorkspaceAccess();
  const db = getDb();
  const user = await getServerSessionUser();

  if (!access || !db || !user) {
    return (
      <p className="text-sm text-muted-foreground">
        Integrations are unavailable in local file mode.
      </p>
    );
  }

  const origin = await appOrigin();

  const keys = await listApiKeys(db, user.id);
  // Dates aren't serializable across the server/client boundary; send ISO.
  const initialKeys = keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  }));

  const isAdmin = access.role === "owner";
  // Products feed the webhook product filter (admin) and the per-repo product
  // link chips (any member); the list is already visibility-filtered.
  const products = await listProducts(access);
  // Imported specs land at the leaf level, so post-import links point there
  // (sync no longer creates Feature groupings to home them under).
  const store = await getStore();
  const leafLevelKey = leafLevel(await store.listLevels(access)).key;
  const endpoints = isAdmin
    ? await listWebhookEndpoints(db, access.workspaceId)
    : [];

  // Repository management: any member sees the connected list; only admins get
  // the GitHub setup/connect controls (matching the API authorization).
  const repoRows = await db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      githubInstallationId: repositories.githubInstallationId,
      isSpecRepo: repositories.isSpecRepo,
      // For the write-mode row: what the repo's own config says, and whether
      // an admin has overridden it here.
      config: repositories.config,
      writeModeOverride: repositories.writeModeOverride,
    })
    .from(repositories)
    .where(eq(repositories.workspaceId, access.workspaceId));

  const configured = await isGithubConfigured(db);

  // Each repo's product links (chips + default product in the repo list).
  const repoLinks = Object.fromEntries(
    await listRepoProductLinks(db, access.workspaceId),
  );

  // Prefetch the connect picker's repo list so it renders with the initial
  // HTML instead of popping in after a client fetch. Costs one GitHub call per
  // workspace installation; a workspace with none skips GitHub entirely.
  const installations =
    isAdmin && configured
      ? await loadWorkspaceInstallations(db, access.workspaceId)
      : NO_INSTALLATIONS;

  const tabs: SettingsTab[] = [
    {
      key: "repositories",
      label: "Repositories",
      content: (
        <RepositoriesManager
          repos={repoRows.map((r) => ({
            ...r,
            // `config` is jsonb, so it arrives as unknown. Only the write mode
            // is read here, and it is read defensively: a config written under
            // a different schema version still names one.
            config: (r.config as { writeMode?: string } | null) ?? null,
            writeModeOverride:
              r.writeModeOverride === "pr" || r.writeModeOverride === "direct"
                ? r.writeModeOverride
                : null,
          }))}
          canConnect={isAdmin}
          configured={configured}
          selfHosted={isSingleTenant()}
          appOrigin={origin}
          originIsPublic={isPubliclyReachable(origin)}
          installUrl={
            configured
              ? `/api/v1/github/install-start?org=${encodeURIComponent(access.orgSlug)}`
              : null
          }
          notice={noticeFor(params)}
          installations={installations}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          links={repoLinks}
          leafLevelKey={leafLevelKey}
        />
      ),
    },
    {
      key: "api-keys",
      label: "API keys",
      content: <ApiKeysCard initialKeys={initialKeys} />,
    },
    {
      key: "webhooks",
      label: "Webhooks",
      content: isAdmin ? (
        <WebhooksCard
          initialEndpoints={endpoints}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>
              Only the workspace owner can manage webhooks.
            </CardDescription>
          </CardHeader>
        </Card>
      ),
    },
  ];

  return (
    <SettingsTabs tabs={tabs} ariaLabel="Integrations" initialTab={tab} />
  );
}
