import { eq, repositories } from "@specboards/db";
import { headers } from "next/headers";

import { AgentsCard } from "@/components/agents-card";
import { ApiKeysCard } from "@/components/api-keys-card";
import { ConnectedAgentsCard } from "@/components/connected-agents-card";
import { IntegrationsTabs } from "@/components/integrations-tabs";
import { McpCard } from "@/components/mcp-card";
import { ModelProviderCard } from "@/components/model-provider-card";
import {
  RepositoriesManager,
  type SetupNotice,
} from "@/components/repositories-manager";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WebhooksCard } from "@/components/webhooks-card";
import { listApiKeys } from "@/lib/api-keys";
import { listServiceAccounts } from "@/lib/service-accounts-service";
import { getServerSessionUser } from "@/lib/auth-session";
import { getAppDb, getDb } from "@/lib/db";
import { isGithubConfigured } from "@/lib/github-app";
import { loadWorkspaceInstallations, NO_INSTALLATIONS } from "@/lib/github-connect";
import { listMcpConnections } from "@/lib/mcp/workspace-binding";
import { getModelProvider } from "@/lib/model-provider-service";
import { leafLevel } from "@specboards/core";

import { getStore } from "@/lib/store";
import { listProducts } from "@/lib/products-service";
import { listRepoProductLinks } from "@/lib/repo-links-service";
import { isSingleTenant } from "@/lib/tenancy";
import { summarizeUsage } from "@/lib/usage-service";
import { UsageCard } from "@/components/usage-card";
import { listWebhookEndpoints } from "@/lib/webhooks-service";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** This deployment's public MCP endpoint, e.g. https://test.specboards.ai/api/mcp. */
async function mcpEndpoint(): Promise<string> {
  const configured = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  let origin: string;
  if (configured) {
    origin = configured.replace(/\/+$/, "");
  } else {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
    origin = `${proto}://${host}`;
  }
  return `${origin}/api/mcp`;
}

/** Map the GitHub callback/setup query params to a user-facing banner. */
function noticeFor(params: Record<string, string | string[] | undefined>): SetupNotice {
  if (params.setup === "done") {
    return { kind: "ok", message: "GitHub app created. Now install it on your repositories below." };
  }
  if (params.connected === "1") {
    return { kind: "ok", message: "GitHub installed. Pick the repositories to connect below." };
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
    hosted: "GitHub is managed by Specboards on the hosted plan. Just install the app below.",
  };
  const err = typeof params.error === "string" ? errors[params.error] : undefined;
  return err ? { kind: "error", message: err } : null;
}

/**
 * Integrations: everything that connects Specboards to the outside world in one
 * place - the MCP endpoint for coding agents, personal API keys, outbound
 * webhooks, and connected GitHub repositories. API keys are per-user (any role);
 * webhooks and repository setup are admin-only. All are unavailable in local
 * file mode (no accounts / no server).
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const db = getDb();
  // The model connection and the usage ledger are tenant data with live RLS
  // policies, so they are read over the enforced connection. Everything else on
  // this page (repositories, GitHub apps) still runs on the owner connection,
  // which is why there are two handles here rather than one.
  const appDb = getAppDb();
  const user = await getServerSessionUser();

  if (!access || !db || !user) {
    return (
      <p className="text-sm text-muted-foreground">
        Integrations are unavailable in local file mode.
      </p>
    );
  }

  const endpoint = await mcpEndpoint();

  // The caller's own OAuth connections. Per-user, not per-workspace: an OAuth
  // connection acts as a person, so it is theirs to review and revoke.
  const connections = await listMcpConnections(db, user.id);

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
  // Agent identities are owner-only to see as well as to manage: the listing
  // names every product each one can reach, which is not a member's business.
  const agents = isAdmin
    ? await listServiceAccounts(db, access.workspaceId)
    : [];
  // Same reasoning as agents: the row holds no secret, but it names where this
  // workspace's inference goes and only an owner can change it, so only an
  // owner is shown it.
  const modelProvider = isAdmin
    ? appDb ? await getModelProvider(appDb, access) : null
    : null;

  // Owner-only for the same reason the connection is, and one more: the
  // breakdown names who spent what, which is management information rather than
  // a member's business. The API route that serves it is gated identically.
  const usage = isAdmin && appDb ? await summarizeUsage(appDb, access) : null;

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

  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;

  return (
    <IntegrationsTabs
      initialTab={tab}
      mcp={
        <div className="space-y-4">
          <McpCard endpoint={endpoint} />
          <ConnectedAgentsCard initialConnections={connections} />
        </div>
      }
      agents={
        <AgentsCard
          initialAgents={agents}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          canManage={isAdmin}
        />
      }
      model={
        <ModelProviderCard initialProvider={modelProvider} canManage={isAdmin} />
      }
      usage={<UsageCard initialSummary={usage} canManage={isAdmin} />}
      apiKeys={<ApiKeysCard initialKeys={initialKeys} />}
      webhooks={
        isAdmin ? (
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
        )
      }
      repositories={
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
          installUrl={configured ? `/api/v1/github/install-start?org=${encodeURIComponent(access.orgSlug)}` : null}
          notice={noticeFor(params)}
          installations={installations}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          links={repoLinks}
          leafLevelKey={leafLevelKey}
        />
      }
    />
  );
}
