/**
 * Seed a local database from the repo's own specs: creates a `local`
 * workspace + repository, then a feature + spec_index row per
 * `specs/<slug>/spec.md`. Re-runnable (upserts on the stable spec id).
 *
 *   DATABASE_URL=postgres://... pnpm --filter @specboards/db seed
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LEVELS,
  DEFAULT_PRODUCT_KEY,
  leafLevel,
  parseSpec,
} from "@specboards/core";

import { createDb } from "./client.js";
import {
  features,
  products,
  repositories,
  specIndex,
  workspaceLevels,
  workspaces,
} from "./schema.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** Sample metadata applied on first insert so boards aren't empty. */
const SAMPLE_METADATA = JSON.parse(
  await fs
    .readFile(path.join(repoRoot, ".specboards", "local-metadata.json"), "utf8")
    .catch(() => "{}"),
) as Record<
  string,
  {
    status?: string;
    tags?: string[];
  }
>;

function gitBlobSha(content: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
}

async function walkSpecFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSpecFiles(full)));
    else if (entry.isFile() && entry.name === "spec.md") files.push(full);
  }
  return files;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL is required, e.g. postgres://postgres:postgres@localhost:5432/specboard",
  );
  process.exit(1);
}
const db = createDb(connectionString);

const [workspace] = await db
  .insert(workspaces)
  .values({ name: "Local", slug: "local" })
  .onConflictDoUpdate({ target: workspaces.slug, set: { name: "Local" } })
  .returning();

// Seed the default hierarchy levels so feature inserts satisfy the level FK.
await db
  .insert(workspaceLevels)
  .values(
    DEFAULT_LEVELS.map((l) => ({
      workspaceId: workspace!.id,
      key: l.key,
      label: l.label,
      position: l.position,
      isLeaf: l.isLeaf,
    })),
  )
  .onConflictDoNothing({
    target: [workspaceLevels.workspaceId, workspaceLevels.key],
  });

// Seed the default product so feature inserts have somewhere to land.
const [product] = await db
  .insert(products)
  .values({ workspaceId: workspace!.id, key: DEFAULT_PRODUCT_KEY, name: "Local", position: 0 })
  .onConflictDoUpdate({
    target: [products.workspaceId, products.key],
    set: { name: "Local" },
  })
  .returning();

const [repository] = await db
  .insert(repositories)
  .values({
    workspaceId: workspace!.id,
    githubInstallationId: "local",
    owner: "local",
    name: path.basename(repoRoot),
  })
  .onConflictDoUpdate({
    target: [repositories.workspaceId, repositories.owner, repositories.name],
    set: { githubInstallationId: "local" },
  })
  .returning();

const files = await walkSpecFiles(path.join(repoRoot, "specs"));
let count = 0;
for (const file of files) {
  const raw = await fs.readFile(file, "utf8");
  let parsed;
  try {
    parsed = parseSpec(raw, file);
  } catch (err) {
    console.warn(`Skipping ${file}: ${(err as Error).message}`);
    continue;
  }
  const meta = SAMPLE_METADATA[parsed.frontmatter.id] ?? {};
  const [feature] = await db
    .insert(features)
    .values({
      workspaceId: workspace!.id,
      repoId: repository!.id,
      productId: product!.id,
      specId: parsed.frontmatter.id,
      level: leafLevel(DEFAULT_LEVELS).key,
      title: parsed.frontmatter.title,
      status: meta.status ?? "backlog",
      tags: meta.tags ?? [],
    })
    .onConflictDoUpdate({
      target: [features.repoId, features.specId],
      set: { title: parsed.frontmatter.title, updatedAt: new Date() },
    })
    .returning();

  await db
    .insert(specIndex)
    .values({
      featureId: feature!.id,
      path: path.relative(repoRoot, file),
      blobSha: gitBlobSha(raw),
      content: parsed.content,
      parsed: { title: parsed.frontmatter.title, sections: parsed.sections },
    })
    .onConflictDoUpdate({
      target: specIndex.featureId,
      set: {
        path: path.relative(repoRoot, file),
        blobSha: gitBlobSha(raw),
        content: parsed.content,
        parsed: { title: parsed.frontmatter.title, sections: parsed.sections },
        lastSyncedAt: new Date(),
      },
    });
  count++;
}

console.log(`Seeded ${count} feature(s) into workspace "local".`);
process.exit(0);
