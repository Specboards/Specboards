import type { ComponentType } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  GitBranch,
  LayoutGrid,
  ListTodo,
  Map,
  Server,
  Workflow,
} from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { GithubIcon } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { GITHUB_URL, SIGN_UP_URL, site } from "@/lib/site";

/** Icon components accept a className; lucide icons and our inline brand glyphs
 * both satisfy this. */
type IconComponent = ComponentType<{ className?: string }>;

export default function HomePage() {
  return (
    <div id="top">
      <SiteNav />
      <main>
        <Hero />
        <ValueStrip />
        <Features />
        <HowItWorks />
        <OpenCore />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

/* --------------------------------- Hero --------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* soft brand glow backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] bg-gradient-to-b from-indigo-50 via-white to-white"
      />
      <div className="mx-auto max-w-6xl px-6 pb-20 pt-20 sm:pt-28">
        <div className="mx-auto max-w-3xl text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:text-gray-900"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
            Open-core · Apache-2.0 · Self-host or hosted
          </a>

          <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight text-gray-900 sm:text-6xl">
            Product management that lives in your{" "}
            <span className="text-brand">git specs</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-600">
            {site.description}
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={SIGN_UP_URL} size="lg">
              Get started — it&apos;s free
              <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink href={GITHUB_URL} target="_blank" rel="noreferrer" variant="secondary" size="lg">
              <GithubIcon className="h-4 w-4" />
              View on GitHub
            </ButtonLink>
          </div>
        </div>

        <BoardPreview />
      </div>
    </section>
  );
}

/** CSS-only stylized board so the hero has a product visual with no image
 * assets to ship or keep in sync. */
function BoardPreview() {
  const columns: { title: string; tone: string; cards: { title: string; tag: string }[] }[] = [
    {
      title: "Backlog",
      tone: "bg-gray-400",
      cards: [
        { title: "Public idea portal", tag: "feature" },
        { title: "Saved board views", tag: "feature" },
      ],
    },
    {
      title: "In progress",
      tone: "bg-amber-400",
      cards: [
        { title: "Org tenancy & product switcher", tag: "epic" },
        { title: "GitHub spec sync", tag: "feature" },
      ],
    },
    {
      title: "In review",
      tone: "bg-pink-400",
      cards: [{ title: "Work-item permalinks", tag: "feature" }],
    },
    {
      title: "Done",
      tone: "bg-emerald-400",
      cards: [
        { title: "MCP tools for agents", tag: "feature" },
        { title: "Email auth + reset", tag: "feature" },
      ],
    },
  ];

  return (
    <div className="mx-auto mt-16 max-w-5xl">
      <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-2xl shadow-indigo-100/60 ring-1 ring-black/5">
        {/* fake window chrome */}
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-gray-200" />
          <span className="ml-3 rounded-md bg-gray-50 px-2 py-0.5 text-xs text-gray-400">
            app.specboard.ai
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-3 sm:grid-cols-4">
          {columns.map((col) => (
            <div key={col.title} className="min-w-0">
              <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-gray-600">
                <span className={`h-2 w-2 rounded-full ${col.tone}`} />
                {col.title}
              </div>
              <div className="space-y-2">
                {col.cards.map((card) => (
                  <div
                    key={card.title}
                    className="rounded-lg border border-gray-200 bg-white p-2.5 text-left shadow-sm"
                  >
                    <p className="text-xs font-medium text-gray-900">{card.title}</p>
                    <span className="mt-1.5 inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                      {card.tag}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Value strip ----------------------------- */

function ValueStrip() {
  const points = [
    "Specs stay canonical in git — versioned with code, read by AI agents.",
    "PM metadata layered on top — no duplication into Jira or Aha.",
    "One source of truth for PM, UX, and engineering.",
  ];
  return (
    <section className="border-y border-gray-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-4 px-6 py-10 sm:grid-cols-3">
        {points.map((point) => (
          <div key={point} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-brand">
              <Check className="h-3.5 w-3.5" />
            </span>
            <p className="text-sm text-gray-600">{point}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------- Features ------------------------------- */

const FEATURES: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: GitBranch,
    title: "Git-native specs",
    body: "Your specs/**/spec.md files stay the source of truth. SpecBoard reads frontmatter and keeps a live index — renames and edits survive because every spec carries a stable id.",
  },
  {
    icon: ListTodo,
    title: "Backlog & prioritization",
    body: "Rank, assign, tag, and prioritize work items in a fast backlog. Drag to reorder, save custom views, and filter by product, status, or owner.",
  },
  {
    icon: LayoutGrid,
    title: "Kanban board",
    body: "A status board with a workflow-validated state machine — backlog, defining, ready, in progress, in review, done — so status always means the same thing.",
  },
  {
    icon: Map,
    title: "Roadmap",
    body: "Group features into epics and initiatives and lay them out by quarter. Communicate the plan without spreadsheets or a second tool.",
  },
  {
    icon: GithubIcon,
    title: "One-click GitHub sync",
    body: "Connect a repo with a one-click GitHub App. SpecBoard imports specs, reconciles on every push, and links live PR and issue state to features.",
  },
  {
    icon: Bot,
    title: "MCP for AI agents",
    body: "An MCP server exposes prioritized, assigned, status-aware specs to coding agents — list_features, read_spec, update_status — so agents work from the same plan.",
  },
];

function Features() {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title="Everything to run product on top of your specs"
      subtitle="The planning layer your repo was missing — without pulling specs out of git."
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-brand">
              <Icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ----------------------------- How it works ----------------------------- */

const STEPS: { icon: IconComponent; step: string; title: string; body: string }[] = [
  {
    icon: GithubIcon,
    step: "01",
    title: "Connect your repo",
    body: "Set up the GitHub App in one click. No secrets to paste — credentials are created and stored encrypted for you.",
  },
  {
    icon: Workflow,
    step: "02",
    title: "Specs import automatically",
    body: "SpecBoard scans specs/** per your .specboard/config.yml, homes each under a Feature, and keeps the index in sync on every push.",
  },
  {
    icon: LayoutGrid,
    step: "03",
    title: "Plan, track, and ship",
    body: "Work the Backlog, Board, and Roadmap in the app. Your AI agents read the same prioritized plan over MCP.",
  },
];

function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title="From repo to roadmap in minutes"
      subtitle="No migration project. Point SpecBoard at a repo and your specs become a managed backlog."
      muted
    >
      <div className="grid gap-5 md:grid-cols-3">
        {STEPS.map(({ icon: Icon, step, title, body }) => (
          <div key={step} className="relative rounded-2xl border border-gray-200 bg-white p-6">
            <span className="text-xs font-semibold text-brand">{step}</span>
            <div className="mt-3 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-900 text-white">
              <Icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-gray-900">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------ Open core ------------------------------- */

function OpenCore() {
  return (
    <Section
      eyebrow="Open core"
      title="Yours to run, or hosted by us"
      subtitle="The core is Apache-2.0. Self-host the whole thing for free, or use the managed SaaS and skip the ops."
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white p-7">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-brand">
            <Server className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-gray-900">Self-host</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            The full web app, MCP server, and GitHub sync run from one Docker image with your
            own Postgres. No feature gates on the core.
          </p>
          <ButtonLink
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            className="mt-5"
          >
            <GithubIcon className="h-4 w-4" />
            Get the code
          </ButtonLink>
        </div>
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-7">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-white">
            <ArrowRight className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-gray-900">Hosted SaaS</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            Sign up and connect a repo in minutes. We run the database, deploys, and updates so
            your team can focus on the product.
          </p>
          <ButtonLink href={SIGN_UP_URL} className="mt-5">
            Start free
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------ Final CTA ------------------------------- */

function FinalCta() {
  return (
    <section className="px-6 pb-24">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gray-900 px-8 py-16 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Bring product management to your specs
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-gray-300">
          Spin up a workspace, connect a repo, and put your backlog, board, and roadmap where
          your specs already live.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <ButtonLink href={SIGN_UP_URL} size="lg">
            Get started — it&apos;s free
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            variant="ghost"
            size="lg"
            className="text-gray-300 hover:text-white"
          >
            <GithubIcon className="h-4 w-4" />
            Star on GitHub
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- Helpers -------------------------------- */

function Section({
  id,
  eyebrow,
  title,
  subtitle,
  muted,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={muted ? "bg-gray-50" : "bg-white"}>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand">{eyebrow}</p>
          <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl">
            {title}
          </h2>
          <p className="mt-4 text-pretty text-gray-600">{subtitle}</p>
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}
