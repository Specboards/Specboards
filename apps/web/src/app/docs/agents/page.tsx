import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { QUOTAS } from "@/lib/rate-limit";
import { CONNECTION_GRANTS } from "@/lib/mcp/connection-grants";

export const metadata: Metadata = {
  title: "Connect your own agent — Specboards",
  description:
    "Point a coding agent or in-house automation at your Specboards board over MCP: connecting, what it may do, worked authoring flows, limits, and attribution.",
};

export const dynamic = "force-dynamic";

/**
 * The customer-facing guide for connecting an agent.
 *
 * Lives in the app rather than in the repo README on purpose: the audience is
 * someone using a board they pay for, not someone reading our source. It is
 * outside the `[org]` shell so it is reachable without picking a workspace, and
 * it ships in every build, hosted and self-host alike, so a self-hoster's
 * endpoint URL is their own.
 *
 * Figures that could drift (the endpoint origin, the quotas, the grant names)
 * are read from the code that enforces them rather than typed in, because a
 * limits section that quietly goes stale is worse than none: a reader budgets
 * against it.
 */

async function endpoint(): Promise<string> {
  const configured = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  if (configured) return `${configured.replace(/\/+$/, "")}/api/mcp`;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}/api/mcp`;
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
      {children}
    </pre>
  );
}

export default async function AgentDocsPage() {
  const url = await endpoint();
  const writeWindowMinutes = QUOTAS.mcpWrite.windowSec / 60;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        ← Back to Specboards
      </Link>

      <h1 className="mt-6 text-2xl font-semibold">Connect your own agent</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Specboards speaks the Model Context Protocol, so an agent can work your
        backlog the way a person does: read what is planned, define and break
        down features, write specs into git, and move work through your
        workflow. This guide covers connecting one, deciding what it may do, and
        what happens when it gets something wrong.
      </p>

      <Section id="connect" title="1. Connect">
        <p>
          Your endpoint is:
        </p>
        <Pre>{url}</Pre>
        <p>
          There are two ways to authenticate, and which you want depends on
          whether a person is behind the agent.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          OAuth, for a person&rsquo;s own coding agent
        </h3>
        <p>
          Point your MCP client (Claude Code, Claude Desktop, claude.ai, or your
          own) at the URL above with no credentials. It will discover the
          authorization server, send you to sign in, and show a consent screen.
          The connection then acts as you.
        </p>
        <p>The consent screen asks you two things:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Which workspace</strong> the
            connection is for, if you belong to more than one. Your answer is
            remembered per client, so the agent never has to send a header.
          </li>
          <li>
            <strong className="text-foreground">What it may do</strong>, which
            is the grant described in the next section.
          </li>
        </ul>

        <h3 className="pt-2 font-medium text-foreground">
          An agent identity, for anything running unattended
        </h3>
        <p>
          CI jobs, in-house services and scheduled automation have no person at
          a browser to consent, so they get an identity of their own. A
          workspace owner creates one under{" "}
          <strong className="text-foreground">
            Settings → Integrations → Agents
          </strong>
          , choosing its scopes, its expiry and which products it may reach. The
          key is shown once.
        </p>
        <Pre>{`Authorization: Bearer sb_…`}</Pre>
        <p>
          If your agent belongs to a person who is a member of several
          organizations, add <Code>x-org-slug: your-org</Code> to name one.
          An agent identity belongs to exactly one workspace, so it never needs
          this.
        </p>
        <p>
          Prefer an agent identity to a personal API key for anything
          unattended. A personal key authenticates <em>as you</em> and inherits
          everything you can do; an agent identity is its own member, so its
          edits are attributable to it, it can be granted less than you have,
          and revoking it leaves your own access untouched.
        </p>
      </Section>

      <Section id="permissions" title="2. What your agent can and cannot do">
        <p>
          An agent can never reach a product you cannot: its access is a subset
          of the identity behind it, never a superset. Within that, you choose
          how much.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          OAuth connections: pick a grant
        </h3>
        <ul className="space-y-2">
          {CONNECTION_GRANTS.map((g) => (
            <li key={g.id}>
              <strong className="text-foreground">{g.label}</strong>
              {g.id === "author" ? " (the default)" : ""} — {g.describe}
            </li>
          ))}
        </ul>
        <p>
          You can change your mind: disconnect the agent under{" "}
          <strong className="text-foreground">
            Settings → Integrations → MCP
          </strong>
          , and it will ask again next time it connects.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          Agent identities: pick scopes and products
        </h3>
        <p>
          Two independent questions. <em>Scopes</em> say what kind of thing the
          agent may touch (work items, specs, docs, releases, goals, …), each as
          read or read-and-write. <em>Product grants</em> say whose: an agent
          with no product granted can read the workspace but write nothing.
        </p>
        <p>Framed by job, the common ones are:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Review the backlog</strong>{" "}
            &mdash; every resource at read.
          </li>
          <li>
            <strong className="text-foreground">
              Define and break down work
            </strong>{" "}
            &mdash; write on <Code>features</Code>, <Code>specs</Code>,{" "}
            <Code>comments</Code> and <Code>docs</Code>; read on{" "}
            <Code>statuses</Code> and <Code>products</Code> so it can find the
            right stage and the right board.
          </li>
          <li>
            <strong className="text-foreground">Keep status in step with CI</strong>{" "}
            &mdash; write on <Code>features</Code> (status changes and PR links)
            and read on <Code>statuses</Code>.
          </li>
        </ul>
        <p>
          Deleting is deliberately separate. An OAuth connection granted
          &ldquo;read and author&rdquo; can edit anything it may write but
          cannot delete items, goals or pages, because a scope alone cannot tell
          those apart.
        </p>
      </Section>

      <Section id="flows" title="3. Worked examples">
        <p>
          Every one of these is a normal tool call; the point is the order, and
          the calls that stop an agent guessing.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          Orient on a board you did not set up
        </h3>
        <p>
          Call <Code>whoami</Code> first. It reports your role, the hierarchy
          levels this workspace uses (they are configurable, so do not assume
          &ldquo;epic&rdquo; exists), and which products you can write. Then{" "}
          <Code>list_statuses</Code> for the stage keys and whether the workflow
          is strict.
        </p>
        <p>
          On a large board, filter. <Code>list_items</Code> with no arguments
          returns the whole workspace; pass <Code>product</Code>,{" "}
          <Code>status</Code>, <Code>release</Code>, <Code>cycle</Code> or{" "}
          <Code>limit</Code>.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          Take an idea to a defined feature
        </h3>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <Code>create_item</Code> for the card, at whichever level fits.
          </li>
          <li>
            <Code>create_spec</Code> with that item&rsquo;s{" "}
            <Code>workItemId</Code> to attach a spec to it. Without{" "}
            <Code>workItemId</Code> you get a second card for the same work.
          </li>
          <li>
            <Code>create_spec</Code> again for each child, then{" "}
            <Code>update_item(parentSpecId)</Code> to nest them.
          </li>
          <li>
            <Code>update_item(details)</Code> on the parent to roll a summary
            up.
          </li>
        </ol>

        <h3 className="pt-2 font-medium text-foreground">
          Move work through a strict workflow
        </h3>
        <p>
          Where <Code>list_statuses</Code> reports{" "}
          <Code>transitionMode: &quot;strict&quot;</Code>, stages must be walked
          in order. Do not issue one call per stage: pass{" "}
          <Code>update_item(advance: true)</Code> once and it walks the
          intermediate stages for you. Stage gates still apply at each one.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          Understand where your spec edit went
        </h3>
        <p>
          Specs live in git, and a connected repository can be configured to
          take edits as pull requests rather than commits. When it is,{" "}
          <Code>update_spec_content</Code> returns a <Code>pullRequest</Code>{" "}
          field. That means the change is <em>proposed, not landed</em>: the
          board still shows the previous text until someone merges it. An agent
          that reports &ldquo;done&rdquo; on seeing a successful write, without
          checking for that field, will be wrong.
        </p>
      </Section>

      <Section id="limits" title="4. Limits and failure modes">
        <p>Quotas are per credential, so one agent cannot starve another.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">
              {QUOTAS.mcpRequest.limit} calls per minute.
            </strong>{" "}
            A batch counts as its number of calls, not as one request.
          </li>
          <li>
            <strong className="text-foreground">
              {QUOTAS.mcpWrite.limit} git writes per {writeWindowMinutes}{" "}
              minutes.
            </strong>{" "}
            Creating or editing specs and docs commits to your repository, which
            is far more expensive than a read, so it has its own budget.
          </li>
        </ul>
        <p>
          Over the first, the endpoint answers <Code>429</Code> with a{" "}
          <Code>Retry-After</Code> header <em>and</em> a JSON-RPC error carrying
          the delay, so an MCP client can read the reason rather than seeing a
          bare disconnect. Over the second, the individual tool call fails with
          a message naming the wait; reads keep working.
        </p>
        <p>Other refusals an agent should expect to handle:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">A revoked or expired key</strong>{" "}
            stops working on the next call, with no grace period. The same is
            true of a disconnected OAuth connection.
          </li>
          <li>
            <strong className="text-foreground">A missing scope</strong> names
            the scope it needed. That is fixed by granting it, not by retrying.
          </li>
          <li>
            <strong className="text-foreground">A stage gate</strong> refuses a
            status change until its checklist is satisfied. Read the item&rsquo;s{" "}
            <Code>allowedTransitions</Code> rather than guessing at stage keys.
          </li>
          <li>
            <strong className="text-foreground">
              A stale <Code>expectedBlobSha</Code>
            </strong>{" "}
            means the spec changed in git since you read it. The error carries
            the current content and sha; re-read, merge, and send again.
          </li>
        </ul>
      </Section>

      <Section id="attribution" title="5. What the board records">
        <p>
          Every change an agent makes is attributed to the agent, not silently
          to you, so &ldquo;who changed this?&rdquo; has an answer for your own
          automation.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            An OAuth connection is recorded under the name the client
            registered, as{" "}
            <span className="text-foreground">Claude Code (agent)</span>. The
            person who authorized it is still on the row.
          </li>
          <li>
            An agent identity is recorded under its own name, as{" "}
            <span className="text-foreground">Release bot (automation)</span>.
          </li>
          <li>
            Spec writes are additionally recorded in an audit trail, including
            the ones that failed, with the path and whether the change was
            committed or proposed.
          </li>
        </ul>
        <p>
          Item history shows all of this in the app, on each item&rsquo;s
          Activity view.
        </p>
      </Section>

      <p className="mt-12 border-t pt-6 text-xs text-muted-foreground">
        Managing your connections:{" "}
        <strong className="text-foreground">Settings → Integrations</strong>
        {" "}&mdash; the MCP tab lists your connected agents and disconnects
        them, and the Agents tab is where an owner creates, rotates and revokes
        agent identities.
      </p>
    </main>
  );
}
