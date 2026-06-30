#!/usr/bin/env node
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { ApiError, SpecboardClient, type Feature, type FeaturePatch } from "./client.js";
import { clearFileConfig, loadFileConfig, resolveConfig, saveFileConfig } from "./config.js";

// Read the version from package.json at runtime (bin lives at dist/index.js, so
// the manifest is one level up) rather than hardcoding it, so `specboard
// --version` always matches the released package without a second bump site.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const HELP = `SpecBoard CLI

Usage: specboard <command> [options]

Auth
  auth login [--url <url>] [--key <key>]   Save the deployment URL + API key
  auth logout                              Remove stored credentials
  whoami                                   Show the authenticated user + workspace

Work
  features [--mine] [--status <s>]         List features (work items)
           [--product <key>] [--assignee <id>]
  show <specId>                            Show one feature
  status <specId> <status>                 Set a feature's status
  assign <specId> <me|none|userId>         Set or clear the assignee
  priority <specId> <number|none>          Set or clear the priority
  link <specId> (--pr <n> | --issue <n> | --branch <name>)
                                           Link a GitHub PR / issue / branch
  products                                 List products

Other
  version                                  Print the CLI version

Statuses: backlog, defining, ready, in_progress, in_review, done, archived

Config lives at ~/.specboard/config.json. Env SPECBOARD_URL / SPECBOARD_TOKEN
override it.`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Build an authenticated client from config, or exit with guidance. */
function client(): SpecboardClient {
  const { baseUrl, apiKey } = resolveConfig();
  if (!baseUrl || !apiKey) {
    fail("not logged in. Run `specboard auth login` first.");
  }
  return new SpecboardClient(baseUrl, apiKey);
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
    options: { url: { type: "string" }, key: { type: "string" } },
  });
  const existing = loadFileConfig();
  const baseUrl =
    values.url ?? process.env.SPECBOARD_URL ?? existing.baseUrl ??
    (await ask("Deployment URL (e.g. https://app.specboard.ai): "));
  const apiKey =
    values.key ?? process.env.SPECBOARD_TOKEN ??
    (await ask("API key (sb_…): ", { secret: true }));
  if (!baseUrl || !apiKey) fail("a URL and an API key are required.");

  // Verify before saving so a bad key fails loudly here, not on first use.
  const me = await new SpecboardClient(baseUrl, apiKey).me().catch((err) => {
    if (err instanceof ApiError && err.status === 401) {
      fail("that API key was rejected (401). Check the key and try again.");
    }
    throw err;
  });
  saveFileConfig({ baseUrl, apiKey });
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
  process.stdout.write(
    `${pad("STATUS", 12)} ${pad("PRI", 4)} ${pad("TITLE", 44)} SPEC\n`,
  );
  for (const f of features) {
    process.stdout.write(
      `${pad(f.status, 12)} ${pad(f.priority == null ? "-" : String(f.priority), 4)} ` +
        `${pad(f.title, 44)} ${f.specId}\n`,
    );
  }
}

async function cmdShow(specId: string): Promise<void> {
  const f = await client().getFeature(specId);
  const lines = [
    `${f.title}`,
    `spec:     ${f.specId}`,
    `status:   ${f.status}`,
    `priority: ${f.priority ?? "-"}`,
    `level:    ${f.level}${f.isDbNative ? " (db-native)" : ""}`,
    `assignee: ${f.assigneeId ?? "-"}`,
    `product:  ${f.productId ?? "-"}`,
    `tags:     ${f.tags.length ? f.tags.join(", ") : "-"}`,
    `roadmap:  ${f.roadmapQuarter ?? "-"}`,
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
  if ("priority" in patch) return f.priority == null ? "none" : String(f.priority);
  if ("assigneeId" in patch) return f.assigneeId ?? "unassigned";
  return "updated";
}

async function cmdAssign(specId: string, who: string): Promise<void> {
  let assigneeId: string | null;
  if (who === "none") assigneeId = null;
  else if (who === "me") assigneeId = (await client().me()).user?.id ?? null;
  else assigneeId = who;
  if (who === "me" && assigneeId === null) fail("could not resolve your user id (local mode?).");
  await patchAndReport(specId, { assigneeId }, "assignee");
}

async function cmdPriority(specId: string, value: string): Promise<void> {
  let priority: number | null;
  if (value === "none") priority = null;
  else {
    priority = Number(value);
    if (!Number.isFinite(priority)) fail(`priority must be a number or "none", got "${value}".`);
  }
  await patchAndReport(specId, { priority }, "priority");
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
      if (!rest[0] || !rest[1]) fail("usage: specboard status <specId> <status>");
      return patchAndReport(rest[0], { status: rest[1] }, "status");
    case "assign":
      if (!rest[0] || !rest[1]) fail("usage: specboard assign <specId> <me|none|userId>");
      return cmdAssign(rest[0], rest[1]);
    case "priority":
      if (!rest[0] || !rest[1]) fail("usage: specboard priority <specId> <number|none>");
      return cmdPriority(rest[0], rest[1]);
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
