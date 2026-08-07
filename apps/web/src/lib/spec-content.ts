import { randomUUID } from "node:crypto";

import {
  canWriteProduct,
  featureSlug,
  isLeafLevel,
  leafLevel,
  resolveWriteMode,
  rewriteSpecBody,
} from "@specboards/core";
import type { WritePullRequest } from "@specboards/git";
import {
  and,
  eq,
  features,
  repositories,
  specIndex,
  type Database,
} from "@specboards/db";

import { recordWritePullRequest } from "@/lib/github-links-service";
import {
  resolveRepoClient,
  resolveRepoDefaultProduct,
  syncRepository,
  type RepoRecord,
} from "@/lib/github-sync";
import { getStore, type WorkspaceScope } from "@/lib/store";

/**
 * Writing a spec's Markdown means committing to the connected GitHub repo (git
 * is canonical; `spec_index` is a cache). These operations therefore live
 * alongside the sync in `github-sync.ts`, not in the store, and run on the
 * owner DB connection - but only after the caller's read + product-write access
 * has been verified through the RLS-enforced store. That keeps agents from
 * reaching specs their role can't touch even though the git write bypasses RLS.
 */

/** Raised when a spec can't be written (no repo, no access, name clash, ...). */
export class SpecContentError extends Error {}

/** The feature's git pointers, resolved on the owner connection. */
interface SpecGitTarget {
  repo: RepoRecord;
  path: string;
  title: string;
}

/**
 * Confirm the caller may write the spec `specId`, then resolve its repo + path.
 * Read access is checked through the store (RLS); product-write is checked
 * explicitly because the git write below uses the owner connection.
 */
async function authorizeSpecWrite(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<SpecGitTarget> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new SpecContentError(`No item with spec id ${specId}.`);
  if (feature.isDbNative) {
    throw new SpecContentError(
      "This is a DB-native card, not a git-backed spec. Edit its body with " +
        "update_item (details) instead.",
    );
  }
  const access = await store.getProductAccess(scope);
  const allowed =
    feature.productId === null
      ? access.isOrgAdmin
      : canWriteProduct(access, feature.productId);
  if (!allowed) {
    throw new SpecContentError("Your role does not permit editing this spec.");
  }

  const [row] = await db
    .select({
      repoId: features.repoId,
      path: specIndex.path,
    })
    .from(features)
    .leftJoin(specIndex, eq(specIndex.featureId, features.id))
    .where(
      and(
        eq(features.specId, specId),
        eq(features.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
  if (!row?.repoId || !row.path) {
    throw new SpecContentError(
      "This spec has no connected repository file to edit.",
    );
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, row.repoId))
    .limit(1);
  if (!repo) {
    throw new SpecContentError("The spec's repository is no longer connected.");
  }
  return { repo, path: row.path, title: feature.title };
}

export interface SpecWriteResult {
  specId: string;
  path: string;
  commitSha: string;
  /**
   * The pull request the change was proposed through, when the repo's write
   * mode is `pr`. Its presence means the change is *not* on the default branch
   * and the board still shows the old text, which is the single most important
   * thing to tell whoever made the edit.
   */
  pullRequest?: WritePullRequest;
}

/**
 * Replace an existing spec's Markdown body, preserving its frontmatter (and so
 * its stable `id`), and write it back to the connected repo. `body` is the
 * Markdown after the frontmatter, as returned by read_item's `content`.
 *
 * How the write reaches the repo depends on the repo's resolved write mode:
 *
 * - `direct` commits onto the default branch and re-syncs, so the board shows
 *   the new text immediately.
 * - `pr` commits to a working branch for this file and proposes it, joining the
 *   pull request already open for that file if there is one. Nothing on the
 *   default branch changed, so there is nothing to sync: the board keeps showing
 *   the current text until the change is reviewed and merged. The pull request
 *   is recorded on the item and returned, so the proposal is traceable from the
 *   card and the author can be told where their change went.
 *
 * Note the gap PR mode leaves open until the concurrency guard lands: an author
 * who reloads the page reads the *default branch* text, not what they proposed,
 * so a second edit made from a fresh session would be written on top of a base
 * that is missing their own open proposal. Guarding the write with the blob sha
 * the editor loaded turns that into a conflict the author can resolve, which is
 * what the next feature in this release is for.
 */
export async function updateSpecContent(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  body: string,
  opts: { message?: string } = {},
): Promise<SpecWriteResult> {
  const { repo, path, title } = await authorizeSpecWrite(db, scope, specId);
  const client = await resolveRepoClient(db, repo);
  const existing = await client.readFile(path);
  const content = rewriteSpecBody(existing.raw, body, { id: specId, title });
  const message = opts.message?.trim() || `docs(specboard): update ${path}`;
  const { mode } = resolveWriteMode(repo.config);
  const { commitSha, pullRequest } = await client.writeFile({
    path,
    content,
    message,
    mode,
  });

  if (!pullRequest) {
    await syncRepository(db, repo);
    return { specId, path, commitSha };
  }

  // The commit has already landed on the working branch, so a link that fails
  // to record is a traceability problem, not a failed save. Say so in the log
  // and return anyway: the caller still gets the pull request url to show.
  try {
    await recordWritePullRequest(specId, repo.id, pullRequest, message, scope);
  } catch (err) {
    console.warn(
      `[specboards] couldn't link pull request #${pullRequest.number} to ${specId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return { specId, path, commitSha, pullRequest };
}

/**
 * Delete a work item's attached spec file from its repo, returning the path
 * removed. Used by the delete path: an item with a spec can only be deleted
 * together with its file, since a surviving file is re-imported by the next
 * sync (ADR 0003 D4). Authorization is the same product-write check as any
 * other spec write.
 *
 * The sync deliberately is *not* run afterwards. The caller deletes the
 * `features` row immediately after this returns, and a sync in between would
 * see a spec that no longer exists on disk while its row still does.
 *
 * Unlike {@link updateSpecContent} this does not honour the repo's write mode,
 * and the omission is deliberate rather than pending. Removing the file is only
 * half of a delete: the caller drops the item the moment this returns, and a
 * removal sitting unmerged on a branch would leave the file on the default
 * branch for the next sync to re-import as a brand-new item (ADR 0003 D4). A
 * reviewable delete has to keep the item alive until the pull request merges,
 * which is a different feature from this one, not a parameter on it.
 */
export async function deleteSpecFile(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  opts: { message?: string } = {},
): Promise<{ path: string; commitSha: string }> {
  const { repo, path } = await authorizeSpecWrite(db, scope, specId);
  const client = await resolveRepoClient(db, repo);
  const { commitSha } = await client.deleteFile({
    path,
    message: opts.message?.trim() || `docs(specboard): remove spec ${path}`,
  });
  return { path, commitSha };
}

/**
 * The Markdown a new spec starts from when nothing else has filled it: the
 * template the caller picked, else the one the workspace assigned to its leaf
 * level, else null for the stub.
 *
 * This is only ever consulted for an *empty* body, which is the whole safety
 * property: a skeleton must never displace something a person wrote. It also
 * means a picked template silently does nothing when there is real content to
 * keep, so callers should not offer the choice where that is the case.
 *
 * Templates are read through the RLS-scoped store, so an id from another tenant
 * reads as unknown rather than leaking that tenant's Markdown.
 */
async function resolveTemplateBody(
  store: Awaited<ReturnType<typeof getStore>>,
  scope: WorkspaceScope,
  templateId: string | undefined,
  levels: Awaited<ReturnType<Awaited<ReturnType<typeof getStore>>["listLevels"]>>,
): Promise<string | null> {
  const wanted =
    templateId ?? leafLevel(levels).detailTemplateId ?? undefined;
  if (!wanted) return null;
  const templates = await store.listDetailTemplates(scope);
  const found = templates.find((t) => t.id === wanted);
  if (!found) {
    // An explicit pick that cannot be resolved is the caller's error and worth
    // saying so. A stale *level* default is not: an admin deleting a template
    // should not start failing everyone's spec creation, so that falls through
    // to the stub.
    if (templateId) {
      throw new SpecContentError("That template no longer exists.");
    }
    return null;
  }
  return found.body.trim() || null;
}

/** The spec file body committed for a brand-new spec (fresh id in frontmatter). */
function newSpecFile(id: string, title: string, body: string | undefined): string {
  const trimmed = (body ?? "").trim();
  const content = trimmed || `# ${title}\n\nDescribe this spec.`;
  // JSON-quote the title (valid YAML) so names with colons stay parseable.
  return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nkind: feature\n---\n\n${content}\n`;
}

/**
 * Create a spec file in a connected repo, commit it, and sync so it appears on
 * the board.
 *
 * With `workItemId`, the spec **attaches** to that existing work item: the file
 * carries the item's own id in frontmatter, so the sync recognises it and links
 * a `spec_index` row to the row that is already there, rather than creating a
 * second one (ADR 0003 D3). This is how work tracked in the app first and
 * documented later keeps one identity throughout.
 *
 * Without it, a fresh id is generated and the sync creates the work item.
 * Callers that want it parented under a particular card follow up with an
 * update_item on `parentSpecId` - this keeps the git write focused and lets the
 * store enforce the hierarchy rules.
 *
 * When attaching and the caller gives no `body`, the item's existing details
 * become the spec's body. This is not a convenience: once a spec is attached
 * the board reads the item's body from the file (`spec_index.content ?? details`
 * in the store), so a description left behind stops being rendered and reads to
 * its author as the app having eaten their writing. Seeding it here rather than
 * in the caller is deliberate - the caller's copy of the item may be seconds
 * stale, and the one case that matters most is an author who typed a
 * description and attached a spec in the same breath.
 *
 * Otherwise the body comes from a template: `templateId` when the caller picked
 * one, else whichever detail template the workspace has assigned to its leaf
 * level. A blank page is the wrong starting point for the non-technical authors
 * this is for - the sections *are* the prompt - and reusing the templates
 * admins already maintain in Settings beats a second, parallel set of them that
 * says the same thing in a different place. See {@link resolveTemplateBody} for
 * why a template can never displace real writing.
 */
export async function createSpec(
  db: Database,
  scope: WorkspaceScope,
  input: {
    title: string;
    body?: string;
    repoId?: string;
    message?: string;
    /** An existing work item to attach the new spec to, by its specId. */
    workItemId?: string;
    /** A detail template to start the spec from, by id. */
    templateId?: string;
  },
): Promise<SpecWriteResult> {
  const title = input.title.trim();
  if (!title) throw new SpecContentError("title is required.");
  const slug = featureSlug(title);
  if (!slug) {
    throw new SpecContentError(
      "Give the spec a title with at least one letter or number.",
    );
  }

  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, scope.workspaceId));
  if (repos.length === 0) {
    throw new SpecContentError(
      "No connected repository. Connect a GitHub spec repo first.",
    );
  }
  let repo: RepoRecord;
  if (input.repoId) {
    const found = repos.find((r) => r.id === input.repoId);
    if (!found) {
      throw new SpecContentError("Repository not found in your workspace.");
    }
    repo = found;
  } else {
    // Prefer the designated spec repo, else the first connected repo.
    repo = repos.find((r) => r.isSpecRepo) ?? repos[0]!;
  }

  // New specs sync into the target repo's default product; require write there.
  const store = await getStore();
  const access = await store.getProductAccess(scope);
  const defaultProductId = await resolveRepoDefaultProduct(db, repo);
  if (!access.isOrgAdmin && !canWriteProduct(access, defaultProductId)) {
    throw new SpecContentError(
      "Your role does not permit creating specs in this workspace.",
    );
  }

  const client = await resolveRepoClient(db, repo);
  const path = `specs/${slug}/spec.md`;
  let exists = false;
  try {
    await client.readFile(path);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    throw new SpecContentError(
      `${path} already exists in ${repo.owner}/${repo.name}. Pick a different title.`,
    );
  }

  // Attaching: reuse the target item's own id as the spec's frontmatter id, so
  // sync links the file to that row instead of creating a new one. Validated
  // through the RLS-scoped store, so an id from another tenant reads as unknown.
  let id: string;
  let body = input.body;
  const levels = await store.listLevels(scope);
  if (input.workItemId) {
    const target = await store.getFeature(input.workItemId, scope);
    if (!target) {
      throw new SpecContentError(`No item with spec id ${input.workItemId}.`);
    }
    if (!target.isDbNative) {
      throw new SpecContentError(
        `${target.title} already has a spec attached (${target.path}). ` +
          "Edit it with update_spec_content instead.",
      );
    }
    // Only the leaf level carries specs. Attaching to a grouping would let the
    // sync reconcile that row down to the leaf level on its next run, silently
    // demoting an initiative or epic and stranding its children.
    if (!isLeafLevel(target.level, levels)) {
      const leaf = leafLevel(levels);
      throw new SpecContentError(
        `Specs attach to ${leaf.label.toLowerCase()} only; ` +
          `${target.title} is a ${target.level}. Create the spec on one of ` +
          "its children instead.",
      );
    }
    const targetAllowed =
      target.productId === null
        ? access.isOrgAdmin
        : access.isOrgAdmin || canWriteProduct(access, target.productId);
    if (!targetAllowed) {
      throw new SpecContentError(
        "Your role does not permit attaching a spec to this item.",
      );
    }
    id = input.workItemId;
    // Carry the card's description into the spec unless the caller supplied a
    // body of its own. Read here, from the item we just fetched, so it is the
    // current text rather than whatever the caller last saw.
    if (body === undefined) body = target.content;
  } else {
    id = randomUUID();
  }

  // Only a blank spec falls back to a template. Order matters and is checked
  // last on purpose: a caller's body, and an attached card's own description,
  // are things a person wrote, and a skeleton must not paper over either.
  if (!body?.trim()) {
    body = (await resolveTemplateBody(store, scope, input.templateId, levels)) ?? body;
  }

  // Creating a spec commits to the default branch whatever the repo's write
  // mode, for the same reason deleting one does (see deleteSpecFile). The card
  // for a new spec is created by the sync that reads the file back, so a file
  // parked on an unmerged branch would produce no card at all, and an attach
  // would leave its item tracked in the app with the spec it is waiting for
  // invisible. Proposing a *new* spec for review means showing it as pending
  // until it merges, which this release does not build.
  const { commitSha } = await client.writeFile({
    path,
    content: newSpecFile(id, title, body),
    message:
      input.message?.trim() ||
      (input.workItemId
        ? `docs(specboard): attach spec ${path}`
        : `docs(specboard): add spec ${path}`),
    mode: "direct",
  });
  await syncRepository(db, repo);
  return { specId: id, path, commitSha };
}
