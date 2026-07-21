import { extractSections } from "@specboard/core";
import { features, repositories, specIndex, type Database } from "@specboard/db";

import { ensureDefaultProduct } from "@/lib/workspace";

/**
 * Self-contained sample board for first-run onboarding. Baked in (not read from
 * the repo's `specs/` dir) so it works inside the deployed container. The
 * entries double as a getting-started checklist. Seeded into a synthetic
 * "sample" repo so it's clearly separate from any real connected repository and
 * easy to ignore once the user's own specs arrive.
 */
interface SampleFeature {
  specId: string;
  title: string;
  status: string;
  tags: string[];
  path: string;
  content: string;
}

const SAMPLE_FEATURES: SampleFeature[] = [
  {
    specId: "a0000000-0000-4000-8000-000000000001",
    title: "Welcome to Specboards",
    status: "ready",
    tags: ["welcome"],
    path: "specs/welcome/spec.md",
    content:
      "## What this is\n\nSpecboards manages product work as **git-native specs**. Each feature is a `spec.md` in your repo; the board adds status, assignee, and release metadata on top.\n\n## Try it\n\nChange this card's status with the dropdown. The edit lands in the database, while the spec content stays canonical in git.",
  },
  {
    specId: "a0000000-0000-4000-8000-000000000002",
    title: "Connect your GitHub repository",
    status: "backlog",
    tags: ["setup", "git-sync"],
    path: "specs/connect-repo/spec.md",
    content:
      "## Goal\n\nConnect the GitHub repo where your specs live. Specboards installs a GitHub App, imports every `specs/**/spec.md`, and keeps the board in sync on every push.\n\n## Next\n\nAn admin connects the repo; once specs import, this sample board can be cleared.",
  },
  {
    specId: "a0000000-0000-4000-8000-000000000003",
    title: "Write your first spec",
    status: "defining",
    tags: ["specs"],
    path: "specs/first-spec/spec.md",
    content:
      "## Format\n\nA spec is markdown with `id` and `title` frontmatter. Specboards injects a stable `id` automatically on first import, so you only write the `title`.\n\n## Sections\n\nUse `##` headings. They're parsed into structured sections shown on the feature page.",
  },
  {
    specId: "a0000000-0000-4000-8000-000000000004",
    title: "Invite your team",
    status: "backlog",
    tags: ["team"],
    path: "specs/invite-team/spec.md",
    content:
      "## Roles\n\nThe first user is the workspace owner. Everyone invited after joins as a member; the owner (or a product admin) grants them a Contributor or Admin role on a product to let them edit it.",
  },
];

/**
 * Seed the sample board into a freshly created workspace. Idempotent (upserts
 * on the stable spec id) and run through the owner connection. Returns the
 * number of sample features written.
 */
export async function seedSampleData(db: Database, workspaceId: string): Promise<number> {
  const [repo] = await db
    .insert(repositories)
    .values({
      workspaceId,
      githubInstallationId: "sample",
      owner: "specboard",
      name: "getting-started",
    })
    .onConflictDoUpdate({
      target: [repositories.workspaceId, repositories.owner, repositories.name],
      set: { githubInstallationId: "sample" },
    })
    .returning();
  if (!repo) throw new Error("Failed to create sample repository.");

  const productId = await ensureDefaultProduct(db, workspaceId);

  for (const sample of SAMPLE_FEATURES) {
    const [feature] = await db
      .insert(features)
      .values({
        workspaceId,
        repoId: repo.id,
        productId,
        specId: sample.specId,
        title: sample.title,
        status: sample.status,
        tags: sample.tags,
      })
      .onConflictDoUpdate({
        target: [features.repoId, features.specId],
        set: { title: sample.title, updatedAt: new Date() },
      })
      .returning({ id: features.id });
    if (!feature) continue;

    const parsed = { title: sample.title, sections: extractSections(sample.content) };
    await db
      .insert(specIndex)
      .values({
        featureId: feature.id,
        path: sample.path,
        blobSha: `sample:${sample.specId}`,
        content: sample.content,
        parsed,
      })
      .onConflictDoUpdate({
        target: specIndex.featureId,
        set: {
          path: sample.path,
          blobSha: `sample:${sample.specId}`,
          content: sample.content,
          parsed,
          lastSyncedAt: new Date(),
        },
      });
  }

  return SAMPLE_FEATURES.length;
}
