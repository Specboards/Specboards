import { headers } from "next/headers";

import { ApiKeysCard } from "@/components/api-keys-card";
import { IntegrationsTabs } from "@/components/integrations-tabs";
import { McpCard } from "@/components/mcp-card";
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
import { listProducts } from "@/lib/products-service";
import { listWebhookEndpoints } from "@/lib/webhooks-service";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** This deployment's public MCP endpoint, e.g. https://test.specboard.ai/api/mcp. */
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

/**
 * Integrations: everything that connects Specboard to the outside world in one
 * place - the MCP endpoint for coding agents, personal API keys, and outbound
 * webhooks. API keys are per-user (any role); webhooks are admin-only. All are
 * unavailable in local file mode (no accounts / no server).
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
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
  const [endpoints, products] = isAdmin
    ? await Promise.all([
        listWebhookEndpoints(db, access.workspaceId),
        listProducts(access),
      ])
    : [[], []];

  const { tab } = await searchParams;

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
    />
  );
}
