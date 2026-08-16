import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentsCard, type AgentView } from "./agents-card";

/**
 * What the Agents card shows before anyone touches it.
 *
 * Two properties matter enough to pin down in markup. The form must not be
 * sitting open (the "add" UX rule in CLAUDE.md), and a non-owner must not be
 * shown the listing at all, since it names every product each agent can reach.
 * Rendering to static markup keeps this a plain assertion about output; the
 * behaviour behind the buttons is covered by `service-accounts.int.test.ts`.
 */

const PRODUCTS = [
  { id: "prod-1", name: "Atlas" },
  { id: "prod-2", name: "Beacon" },
];

const agent: AgentView = {
  userId: "agent-1",
  name: "Atlas planning agent",
  createdAt: "2026-08-01T00:00:00.000Z",
  scopes: ["features:write", "specs:write", "statuses:read"],
  productGrants: [{ productId: "prod-1", role: "contributor" }],
  key: {
    id: "key-1",
    prefix: "sb_a1b2c3d4",
    lastUsedAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
};

function render(agents: AgentView[], canManage = true) {
  return renderToStaticMarkup(
    <AgentsCard initialAgents={agents} products={PRODUCTS} canManage={canManage} />,
  );
}

describe("AgentsCard", () => {
  it("offers an affordance rather than an open form", () => {
    const html = render([agent]);
    expect(html).toContain("Add agent");
    // The scope grid and the name field only exist once the owner opts in.
    expect(html).not.toContain("Agent name");
    expect(html).not.toContain("What this agent may do");
  });

  it("prompts to add the first agent when there are none", () => {
    const html = render([]);
    expect(html).toContain("No agents yet");
    expect(html).toContain("Add agent");
  });

  it("summarises an agent's authority without opening anything", () => {
    const html = render([agent]);
    expect(html).toContain("Atlas planning agent");
    expect(html).toContain("sb_a1b2c3d4");
    // Two writes, one read: enough to judge the agent at a glance.
    expect(html).toContain("1 read, 2 write");
    expect(html).toContain("Atlas (contributor)");
  });

  it("says so plainly when an agent has no product access", () => {
    const html = render([{ ...agent, productGrants: [] }]);
    expect(html).toContain("No product access");
  });

  it("calls an empty scope list what it is", () => {
    // `[]` is unrestricted at the key layer. Rendering it as "0 scopes" would
    // read as the safest agent on the page when it is the most powerful.
    const html = render([{ ...agent, scopes: [] }]);
    expect(html).toContain("Unrestricted");
  });

  it("shows a non-owner nothing but the reason", () => {
    const html = render([agent], false);
    expect(html).toContain("Only the workspace owner");
    expect(html).not.toContain("Atlas planning agent");
    expect(html).not.toContain("Add agent");
  });
});
