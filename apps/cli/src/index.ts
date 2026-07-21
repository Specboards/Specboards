#!/usr/bin/env node
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { ApiError, SpecboardsClient, type Feature, type FeaturePatch } from "./client.js";
import { clearFileConfig, loadFileConfig, resolveConfig, saveFileConfig } from "./config.js";
import { shortestTransitionPath } from "./workflow.js";

// Read the version from package.json at runtime (bin lives at dist/index.js, so
// the manifest is one level up) rather than hardcoding it, so `specboard
// --version` always matches the released package without a second bump site.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const HELP = `Specboards CLI

Usage: specboard <command> [options]

Auth
  auth login [--url <url>] [--key <key>]   Save the deployment URL + API key
  auth logout                              Remove stored credentials
  whoami                                   Show the authenticated user + workspace

Work
  features [--mine] [--status <s>]         List features (work items)
           [--product <key>] [--assignee <id>]
  show <specId>                            Show one feature
  status <specId> <status> [--advance]     Set a feature's status
                                           (--advance walks intermediate steps)
  assign <specId> <me|none|userId>         Set or clear the assignee
  link <specId> (--pr <n> | --issue <n> | --branch <name>)
                                           Link a GitHub PR / issue / branch
  products                                 List products

Other
  version                                  Print the CLI version

Statuses: backlog, defining, ready, in_progress, in_review, done, archived

Config lives at ~/.specboards/config.json. Env SPECBOARDS_URL / SPECBOARDS_TOKEN
override it.`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Build an authenticated client from config, or exit with guidance. */
function client(): SpecboardsClient {
  const { baseUrl, apiKey, orgSlug } = resolveConfig();
  if (!baseUrl || !apiKey) {
    fail("not logged in. Run `specboard auth login` first.");
  }
  return new SpecboardsClient(baseUrl, apiKey, orgSlug);
}

async function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (opts.secret) {
    // Mute echo while the user types/pastes the key.
    const out = process.stdout as NodeJS.WriteStream & { _writeToOutput?: unknown };
    const orig = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) out.write(s);
    };
    void orig;
  }
  try {
    const answer = await rl.question(question);
    if (opts.secret) process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function cmdLogin(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      key: { type: "string" },
      org: { type: "string" },
    },
  });
  const existing = loadFileConfig();
  const baseUrl =
    values.url ?? process.env.SPECBOARDS_URL ?? existing.baseUrl ??
    (await ask("Deployment URL (e.g. https://app.specboards.ai): "));
  const apiKey =
    values.key ?? process.env.SPECBOARDS_TOKEN ??
    (await ask("API key (sb_…): ", { secret: true }));
  const orgSlug = values.org ?? process.env.SPECBOARDS_ORG ?? existing.orgSlug;
  if (!baseUrl || !apiKey) fail("a URL and an API key are required.");

  // Verify before saving so a bad key fails loudly here, not on first use.
  const me = await new SpecboardsClient(baseUrl, apiKey, orgSlug).me().catch((err) => {
    if (err instanceof ApiError && err.status === 401) {
      fail("that API key was rejected (401). Check the key and try again.");
    }
    throw err;
  });
  saveFileConfig({ baseUrl, apiKey, orgSlug });
  if (me.user) {
    process.stdout.write(
      `Logged in as ${me.user.name} <${me.user.email}>` +
        (me.workspace ? ` in ${me.workspace.name}` : "") +
        (me.role ? ` (${me.role})` : "") +
        "\n",
    );
  } else {
    process.stdout.write("Saved. Note: this deployment reports local (no-account) mode.\n");
  }
}

async function cmdWhoami(): Promise<void> {
  const me = await client().me();
  if (!me.user) {
    process.stdout.write("Authenticated, but the deployment is in local (no-account) mode.\n");
    return;
  }
  process.stdout.write(
    `${me.user.name} <${me.user.email}>\n` +
      `workspace: ${me.workspace?.name ?? "?"} (${me.workspace?.slug ?? "?"})\n` +
      `role:      ${me.role ?? "?"}\n`,
  );
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

async function cmdFeatures(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      mine: { type: "boolean" },
      status: { type: "string" },
      product: { type: "string" },
      assignee: { type: "string" },
    },
  });
  const api = client();
  let myId: string | null = null;
  if (values.mine) myId = (await api.me()).user?.id ?? null;

  let features = await api.listFeatures();
  let productId: string | null = null;
  if (values.product) {
    const products = await api.listProducts();
    const match = products.find((p) => p.key === values.product || p.id === values.product);
    if (!match) fail(`no product with key/id "${values.product}".`);
    productId = match.id;
  }

  features = features.filter((f) => {
    if (values.status && f.status !== values.status) return false;
    if (productId && f.productId !== productId) return false;
    if (values.assignee && f.assigneeId !== values.assignee) return false;
    if (myId && f.assigneeId !== myId) return false;
    return true;
  });

  if (features.length === 0) {
    process.stdout.write("No matching features.\n");
    return;
  }
  process.stdout.write(`${pad("STATUS", 12)} ${pad("TITLE", 44)} SPEC\n`);
  for (const f of features) {
    process.stdout.write(
      `${pad(f.status, 12)} ${pad(f.title, 44)} ${f.specId}\n`,
    );
  }
}

async function cmdShow(specId: string): Promise<void> {
  const f = await client().getFeature(specId);
  const lines = [
    `${f.title}`,
    `spec:     ${f.specId}`,
    `status:   ${f.status}`,
    `level:    ${f.level}${f.isDbNative ? " (db-native)" : ""}`,
    `assignee: ${f.assigneeId ?? "-"}`,
    `product:  ${f.productId ?? "-"}`,
    `tags:     ${f.tags.length ? f.tags.join(", ") : "-"}`,
    `release:  ${f.releaseId ?? "-"}`,
    `parent:   ${f.parentSpecId ?? "-"}`,
    `path:     ${f.path}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function patchAndReport(specId: string, patch: FeaturePatch, label: string): Promise<void> {
  const f: Feature = await client().patchFeature(specId, patch);
  process.stdout.write(`${f.specId}: ${label} -> ${describe(f, patch)}\n`);
}

function describe(f: Feature, patch: FeaturePatch): string {
  if ("status" in patch) return f.status;
  if ("assigneeId" in patch) return f.assigneeId ?? "unassigned";
  return "updated";
}

/**
 * `status <specId> <target> [--advance]`. Without `--advance` this is a single
 * transition (the server rejects an illegal jump). With `--advance` the CLI
 * walks the spec through the shortest legal chain of intermediate statuses,
 * PATCHing each hop, so e.g. `backlog -> in_progress` succeeds via
 * `defining -> ready`. The path is computed from the workflow the server
 * reports, so it honors custom / config.yml workflows too.
 */
async function cmdStatus(specId: string, target: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { advance: { type: "boolean" } },
  });
  if (!values.advance) {
    await patchAndReport(specId, { status: target }, "status");
    return;
  }

  const api = client();
  const current = (await api.getFeature(specId)).status;
  if (current === target) {
    process.stdout.write(`${specId}: already ${target}\n`);
    return;
  }
  const workflow = await api.getWorkflow();
  const path = shortestTransitionPath(current, target, workflow);
  if (path === null) {
    fail(`no legal path from "${current}" to "${target}" in this workflow.`);
  }

  let from = current;
  for (const step of path) {
    const f = await api.patchFeature(specId, { status: step });
    process.stdout.write(`${specId}: ${from} -> ${f.status}\n`);
    from = f.status;
  }
}

async function cmdAssign(specId: string, who: string): Promise<void> {
  let assigneeId: string | null;
  if (who === "none") assigneeId = null;
  else if (who === "me") assigneeId = (await client().me()).user?.id ?? null;
  else assigneeId = who;
  if (who === "me" && assigneeId === null) fail("could not resolve your user id (local mode?).");
  await patchAndReport(specId, { assigneeId }, "assignee");
}

async function cmdLink(specId: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: "string" },
      issue: { type: "string" },
      branch: { type: "string" },
    },
  });
  let input: { kind: "pull_request" | "issue" | "branch"; number?: number; branch?: string };
  if (values.pr != null) input = { kind: "pull_request", number: Number(values.pr) };
  else if (values.issue != null) input = { kind: "issue", number: Number(values.issue) };
  else if (values.branch != null) input = { kind: "branch", branch: values.branch };
  else fail("specify one of --pr <n>, --issue <n>, or --branch <name>.");
  if ("number" in input && !Number.isFinite(input.number)) fail("PR/issue number must be numeric.");
  await client().linkGithub(specId, input);
  process.stdout.write(`${specId}: linked ${input.kind.replace("_", " ")}\n`);
}

async function cmdProducts(): Promise<void> {
  const products = await client().listProducts();
  if (products.length === 0) {
    process.stdout.write("No products.\n");
    return;
  }
  for (const p of products) {
    process.stdout.write(`${pad(p.key, 20)} ${p.name}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`specboard ${VERSION}\n`);
      return;
    case "auth": {
      const sub = rest[0];
      if (sub === "login") return cmdLogin(rest.slice(1));
      if (sub === "logout") {
        clearFileConfig();
        process.stdout.write("Logged out.\n");
        return;
      }
      fail("usage: specboard auth <login|logout>");
      break;
    }
    case "whoami":
      return cmdWhoami();
    case "features":
      return cmdFeatures(rest);
    case "show":
      if (!rest[0]) fail("usage: specboard show <specId>");
      return cmdShow(rest[0]);
    case "status":
      if (!rest[0] || !rest[1]) fail("usage: specboard status <specId> <status> [--advance]");
      return cmdStatus(rest[0], rest[1], rest.slice(2));
    case "assign":
      if (!rest[0] || !rest[1]) fail("usage: specboard assign <specId> <me|none|userId>");
      return cmdAssign(rest[0], rest[1]);
    case "link":
      if (!rest[0]) fail("usage: specboard link <specId> (--pr <n> | --issue <n> | --branch <name>)");
      return cmdLink(rest[0], rest.slice(1));
    case "products":
      return cmdProducts();
    default:
      fail(`unknown command "${command}". Run \`specboard help\`.`);
  }
}

main().catch((err) => {
  if (err instanceof ApiError) fail(err.message);
  fail((err as Error).message ?? String(err));
});
