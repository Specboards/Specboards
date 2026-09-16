import { AgentsCard } from "@/components/agents-card";
import { AssistantSkillsEditor } from "@/components/assistant-skills-editor";
import { ConnectedAgentsCard } from "@/components/connected-agents-card";
import { McpCard } from "@/components/mcp-card";
import { ModelProviderCard } from "@/components/model-provider-card";
import { SchedulesCard } from "@/components/schedules-card";
import { SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import { UsageCard } from "@/components/usage-card";
import { appOrigin } from "@/lib/app-origin";
import { BUILT_IN_SKILLS, mergeSkills } from "@/lib/ai/skills";
import { getServerSessionUser } from "@/lib/auth-session";
import { getAppDb, getDb } from "@/lib/db";
import { listMcpConnections } from "@/lib/mcp/workspace-binding";
import { getModelProvider } from "@/lib/model-provider-service";
import { listProducts } from "@/lib/products-service";
import { listScheduleViews } from "@/lib/schedules-service";
import { listServiceAccounts } from "@/lib/service-accounts-service";
import { listSkills } from "@/lib/skills-service";
import { summarizeUsage } from "@/lib/usage-service";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Agents: everything about how agents work in this workspace, in one place.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * Skills lived under Settings > Assistant, the model connection and the usage
 * ledger under Settings > Integrations (`?tab=model`, `?tab=usage`), agent
 * identities under `?tab=agents`, and the MCP endpoint under `?tab=mcp`. Four
 * answers to one question - "how do agents work here" - in two places, and the
 * Assistant page's own header already said consolidating them was the obvious
 * next move. Everything the harness adds next (run policy, scheduled runs,
 * review settings) would have become a fifth scattered home.
 *
 * ── The line against Integrations ───────────────────────────────────────────
 * Integrations keeps what connects this workspace to somebody else's service:
 * GitHub repositories, outbound webhooks, and the personal API keys people use
 * against our own REST API. The MCP endpoint is not a third-party service, it
 * is our front door for agents, so it moved with the rest of them.
 *
 * ── This moves screens, it does not change who may use them ─────────────────
 * Every card keeps the gate it arrived with. Model, Identities and Usage were
 * already shown to everyone as tabs and rendered their owner-only state to
 * members, and they still do; the reads behind them are still skipped entirely
 * for a non-owner rather than fetched and hidden. The one deliberate change is
 * in navigation: Assistant was offered only to owners while its own page said
 * every member reads it, and Agents is offered to everybody, which is what the
 * page always claimed.
 */
export default async function AgentsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const db = getDb();
  // Skills, the model connection and the usage ledger are tenant data with
  // live RLS policies, so they are read over the enforced connection. Service
  // accounts and OAuth connections still run on the owner connection, which is
  // why there are two handles here rather than one.
  const appDb = getAppDb();
  const user = await getServerSessionUser();

  // Local file mode has no database and therefore no stored overrides. The
  // built-in skills still exist, so the page shows what the assistant can do
  // rather than an error about a table nobody asked about; everything else
  // here needs accounts and a server.
  if (!access || !db || !user) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Agent configuration is unavailable in local file mode. These are the
          skills the assistant ships with.
        </p>
        <AssistantSkillsEditor initial={mergeSkills([])} canEdit={false} />
      </div>
    );
  }

  const isAdmin = access.role === "owner";

  const skills = appDb ? await listSkills(appDb, access) : mergeSkills([]);
  // Writing a skill is owner-only, matching the API and the RLS behind it: a
  // skill is a standing instruction attached to every question anyone on the
  // team asks afterwards, and to every edit the assistant proposes off one.
  const canEditSkills = Boolean(appDb) && isAdmin;

  // The caller's own OAuth connections. Per-user, not per-workspace: an OAuth
  // connection acts as a person, so it is theirs to review and revoke.
  const connections = await listMcpConnections(db, user.id);
  const endpoint = `${await appOrigin()}/api/mcp`;

  // Agent identities are owner-only to see as well as to manage: the listing
  // names every product each one can reach, which is not a member's business.
  const agents = isAdmin
    ? await listServiceAccounts(db, access.workspaceId)
    : [];
  const products = isAdmin ? await listProducts(access) : [];

  // Same reasoning as agents: the row holds no secret, but it names where this
  // workspace's inference goes and only an owner can change it, so only an
  // owner is shown it.
  const modelProvider =
    isAdmin && appDb ? await getModelProvider(appDb, access) : null;

  // Owner-only for the same reason the connection is, and one more: the
  // breakdown names who spent what, which is management information rather
  // than a member's business. The API route that serves it is gated the same.
  const usage = isAdmin && appDb ? await summarizeUsage(appDb, access) : null;

  // Read for every member, not just the owner. The rows are visible through
  // row-level security anyway, and "what is running on its own in here" is a
  // question a member has a legitimate stake in: a schedule is spending the
  // workspace's budget and opening runs on items they own. Only the owner can
  // change one, which the card gates separately.
  const schedules = appDb ? await listScheduleViews(appDb, access) : [];

  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;

  const tabs: SettingsTab[] = [
    {
      key: "skills",
      label: "Skills",
      content: (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Saved ways of asking, shown as buttons on every item. A skill is
            instructions the assistant is given while it runs, so this is where
            you encode how your team defines work. Every workspace starts with{" "}
            {BUILT_IN_SKILLS.length} of ours: edit one to make it yours, switch
            off any you do not want, or add your own. Skills run on the model
            this workspace connected under Model, and nothing a skill produces
            is applied to an item until someone accepts it.
          </p>
          <AssistantSkillsEditor initial={skills} canEdit={canEditSkills} />
        </div>
      ),
    },
    {
      key: "connections",
      label: "Connections",
      content: (
        <div className="space-y-4">
          <McpCard endpoint={endpoint} />
          <ConnectedAgentsCard initialConnections={connections} />
        </div>
      ),
    },
    {
      key: "identities",
      label: "Identities",
      content: (
        <AgentsCard
          initialAgents={agents}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          canManage={isAdmin}
        />
      ),
    },
    {
      key: "model",
      label: "Model",
      content: (
        <ModelProviderCard
          initialProvider={modelProvider}
          canManage={isAdmin}
        />
      ),
    },
    {
      key: "usage",
      label: "Usage",
      content: <UsageCard initialSummary={usage} canManage={isAdmin} />,
    },
    {
      key: "schedules",
      label: "Schedules",
      content: (
        <SchedulesCard initialSchedules={schedules} canManage={isAdmin} />
      ),
    },
  ];

  return <SettingsTabs tabs={tabs} ariaLabel="Agents" initialTab={tab} />;
}
