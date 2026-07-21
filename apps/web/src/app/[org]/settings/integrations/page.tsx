import { eq, repositories } from "@specboard/db";
import { headers } from "next/headers";

import { ApiKeysCard } from "@/components/api-keys-card";
import { IntegrationsTabs } from "@/components/integrations-tabs";
import { McpCard } from "@/components/mcp-card";
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
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isGithubConfigured } from "@/lib/github-app";
import { loadWorkspaceInstallations, NO_INSTALLATIONS } from "@/lib/github-connect";
import { listProducts } from "@/lib/products-service";
import { listRepoProductLinks } from "@/lib/repo-links-service";
import { isSingleTenant } from "@/lib/tenancy";
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
  const user = await getServerSessionUser();

  if (!access || !db || !user) {
    return (
      <p className="text-sm text-muted-foreground">
        Integrations are unavailable in local file mode.
      </p>
    );
  }

  const endpoint = await mcpEndpoint();

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
      mcp={<McpCard endpoint={endpoint} />}
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
          repos={repoRows}
          canConnect={isAdmin}
          configured={configured}
          selfHosted={isSingleTenant()}
          installUrl={configured ? `/api/v1/github/install-start?org=${encodeURIComponent(access.orgSlug)}` : null}
          notice={noticeFor(params)}
          installations={installations}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          links={repoLinks}
        />
      }
    />
  );
}
