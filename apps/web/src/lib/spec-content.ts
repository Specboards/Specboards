import { randomUUID } from "node:crypto";

import {
  canWriteProduct,
  conflictingSections,
  featureSlug,
  isLeafLevel,
  leafLevel,
  merge3,
  resolveWriteMode,
  rewriteSpecBody,
  specBody,
} from "@specboards/core";
import {
  GitWriteConflictError,
  type GitRepoClient,
  type WriteFileInput,
  type WriteFileResult,
  type WritePullRequest,
} from "@specboards/git";
import {
  and,
  eq,
  features,
  repositories,
  specIndex,
  type Database,
} from "@specboards/db";

import {
  resolveCommitAuthor,
  specCommitMessage,
} from "@/lib/commit-attribution";
import { DomainError } from "@/lib/errors";
import { recordWritePullRequest } from "@/lib/github-links-service";
import { recordSpecWrite } from "@/lib/spec-write-audit";
import {
  resolveRepoClient,
  resolveRepoDefaultProduct,
  resolveSpecWriteClient,
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
export class SpecContentError extends DomainError {}

/**
 * The spec moved in git between the author loading it and saving. Kept apart
 * from {@link SpecContentError} so the UI can offer a resolution instead of a
 * failure message: everything needed to resolve it is on the error, because a
 * conflict view that has to go back for the losing version is a second round
 * trip during the one moment the author is least patient.
 *
 * `currentContent` is the body with frontmatter stripped, matching what the
 * editor holds, so the two versions can be put side by side without either
 * side re-parsing.
 */
export class SpecConflictError extends DomainError {
  constructor(
    readonly path: string,
    readonly currentContent: string,
    readonly currentBlobSha: string,
    /**
     * Headings both sides rewrote, when they can be worked out. Empty means the
     * overlap could not be narrowed down, not that there is none. The empty
     * string names the text above the first heading.
     */
    readonly sections: string[] = [],
  ) {
    super(conflictMessage(sections));
    this.name = "SpecConflictError";
  }
}

/** Say what actually clashed, in the words the people involved would use. */
function conflictMessage(sections: string[]): string {
  const named = sections.map((s) => s || "the opening");
  const where =
    named.length === 0
      ? "this spec"
      : named.length === 1
        ? `${named[0]}`
        : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return (
    `Someone else changed ${where} while you were writing, so this could not ` +
    "be merged automatically. Your version has not been saved yet."
  );
}

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

/**
 * Write a spec file, turning a lost guard into a {@link SpecConflictError} that
 * carries the version which won.
 *
 * The losing write names the branch it was aimed at, and that is what gets read
 * back: in PR mode the version that beat the author is on the working branch,
 * and reporting the default branch's copy instead would show them a document
 * they are not in conflict with. If that read fails the conflict is still
 * reported, with an empty current version, because "you lost a race and here is
 * nothing" is a worse answer than the plain error the caller would otherwise
 * get, but silently completing the write would be worse than both.
 */
async function writeGuarded(
  client: GitRepoClient,
  input: WriteFileInput,
): Promise<WriteFileResult> {
  try {
    return await client.writeFile(input);
  } catch (err) {
    if (!(err instanceof GitWriteConflictError)) throw err;
    let current = { raw: "", blobSha: "" };
    try {
      current = await client.readFile(input.path, err.ref);
    } catch {
      // Reported below as an empty incoming version.
    }
    throw new SpecConflictError(
      input.path,
      specBody(current.raw),
      current.blobSha,
    );
  }
}

/**
 * How many times a save may re-merge and retry before giving up and asking the
 * author. Each round trip costs GitHub calls, and a spec being rewritten fast
 * enough to lose three races in a row is a document two people should be
 * talking about rather than one the server should keep patching.
 */
const MAX_MERGE_ATTEMPTS = 3;

/**
 * Write a spec body, merging around anyone who got there first.
 *
 * This is the difference between concurrency control that protects work and
 * concurrency control that blocks it. A product manager rewriting the problem
 * statement and a designer filling in the interaction notes are not in
 * conflict, and telling the second one their save was refused, with a wall of
 * the other's text and a choice between overwriting a colleague or redoing
 * their own afternoon, is a worse outcome than the lost write it prevents.
 *
 * So a rejected write is retried against what is actually there: fetch the base
 * the author loaded (by sha, since by now it may be on no branch at all), merge
 * their body with the current one, and write the result. The retry is itself
 * guarded, against the version just read, so a third writer arriving mid-merge
 * is not clobbered either; it simply merges again.
 *
 * Only a genuine overlap, where both sides rewrote the same lines, reaches the
 * author, and it arrives naming the sections they disagree about. Frontmatter
 * never takes part: it is machine-managed and is taken from whichever file is
 * current, so it cannot be the thing two people conflict over.
 */
async function writeMerged(
  client: GitRepoClient,
  input: WriteFileInput & { expectedBlobSha?: string },
  spec: { id: string; title: string; body: string },
): Promise<WriteFileResult & { mergedWith: number; mergedBody?: string }> {
  let expectedBlobSha = input.expectedBlobSha;
  let content = input.content;
  let body = spec.body;
  let mergedWith = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await client.writeFile({ ...input, content, expectedBlobSha });
      return {
        ...result,
        mergedWith,
        ...(mergedWith > 0 ? { mergedBody: body } : {}),
      };
    } catch (err) {
      if (!(err instanceof GitWriteConflictError)) throw err;
      // Unguarded writes cannot reach here, and without the base there is
      // nothing to merge against: fall back to reporting the conflict.
      if (!expectedBlobSha || attempt + 1 >= MAX_MERGE_ATTEMPTS) {
        throw await describeConflict(client, input.path, err.ref, null, body);
      }

      const theirs = await client.readFile(input.path, err.ref);
      let base: string;
      try {
        base = specBody(await client.readBlobBySha(expectedBlobSha));
      } catch {
        // The base is unreachable (a repo that garbage-collected it, or a sha
        // from somewhere else). Merging without it would be guessing.
        throw await describeConflict(client, input.path, err.ref, null, body);
      }

      const theirBody = specBody(theirs.raw);
      const merged = merge3(base, body, theirBody);
      if (!merged.clean) {
        throw await describeConflict(client, input.path, err.ref, base, body);
      }

      body = merged.merged;
      // Frontmatter comes from the file that is actually there, so the merge
      // never has to reconcile machine-managed keys.
      content = rewriteSpecBody(theirs.raw, body, { id: spec.id, title: spec.title });
      expectedBlobSha = theirs.blobSha;
      mergedWith++;
    }
  }
}

/**
 * Build the conflict handed back to the author. With a `base` the sections both
 * sides rewrote can be named, which is the whole difference between "someone
 * changed this spec" and "you and Sam both rewrote Acceptance Criteria".
 */
async function describeConflict(
  client: GitRepoClient,
  path: string,
  ref: string | undefined,
  base: string | null,
  mine: string,
): Promise<SpecConflictError> {
  let current = { raw: "", blobSha: "" };
  try {
    current = await client.readFile(path, ref);
  } catch {
    // Reported as an empty incoming version rather than swallowed.
  }
  const theirBody = specBody(current.raw);
  return new SpecConflictError(
    path,
    theirBody,
    current.blobSha,
    base === null ? [] : conflictingSections(base, mine, theirBody),
  );
}

export interface SpecWriteResult {
  specId: string;
  path: string;
  commitSha: string;
  /**
   * Blob sha of what was just written. An editor still holding the document
   * guards its *next* save with this: without it a second save in one session
   * would be checked against the sha the page loaded, which its own first save
   * has already made stale, and every author would hit a conflict with
   * themselves.
   */
  blobSha: string;
  /**
   * The pull request the change was proposed through, when the repo's write
   * mode is `pr`. Its presence means the change is *not* on the default branch
   * and the board still shows the old text, which is the single most important
   * thing to tell whoever made the edit.
   */
  pullRequest?: WritePullRequest;
  /**
   * How many other people's changes this save merged with on its way in. Zero
   * for the ordinary case. Worth telling the author about when it is not: their
   * spec now contains an edit they have not read.
   */
  mergedWith?: number;
  /**
   * The body as written, returned only when it is not what the caller sent,
   * i.e. after a merge. An editor that keeps showing the author's own text
   * after a merged save is holding a document that is missing somebody else's
   * paragraph, and its next save would delete that paragraph while passing the
   * guard cleanly. So the merged text goes back and the editor adopts it.
   */
  mergedBody?: string;
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
 * `expectedBlobSha` is the concurrent-edit guard: the sha of the file the
 * *editor loaded*, which is the only value that means anything here. Reading a
 * fresh sha inside this function and passing that would satisfy GitHub and
 * guard nothing, because the window the author is exposed to opened when the
 * page rendered, not when the request arrived. Omitting it keeps the old
 * last-write-wins behaviour, which is what the sync's own housekeeping commits
 * want and what a caller with no loaded copy (an agent writing a body it
 * composed) is left with.
 *
 * One sha covers both write modes without a special case, because a blob sha
 * addresses content rather than a branch: in `direct` mode it is checked against
 * the default branch, and in `pr` mode against the working branch, where a
 * proposal the author has not seen shows up as a different sha and stops the
 * write. That is what closes the gap PR mode would otherwise leave, where an
 * author reloading the page reads the default branch and would silently write
 * over their own open proposal.
 *
 * A failed guard does not go straight to the author. The write is merged with
 * whatever landed first and retried, so two people editing different parts of a
 * spec, which is what a product manager and a designer working the same
 * afternoon actually do, both keep their work and neither is asked to redo it.
 * Only a real overlap raises {@link SpecConflictError}, naming the sections both
 * sides rewrote, with `mergedWith` reporting how many other changes a save
 * absorbed on the way through.
 */
export async function updateSpecContent(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  body: string,
  opts: {
    message?: string;
    expectedBlobSha?: string;
    /**
     * The text came from the assistant and a person accepted it, which changes
     * only how the commit is worded. Passed as a flag rather than as a
     * pre-built `message` so that attribution stays assembled in one place:
     * whether the acting user gets a co-author trailer depends on whether their
     * own GitHub token authored the commit, and only this function knows that.
     */
    assistantDrafted?: boolean;
  } = {},
): Promise<SpecWriteResult> {
  // A refusal is recorded too. Git has no record of a commit that never
  // happened, and that is exactly the case someone is investigating when they
  // ask why a change they remember making is not there.
  let target: SpecGitTarget;
  try {
    target = await authorizeSpecWrite(db, scope, specId);
  } catch (err) {
    await recordSpecWrite(db, {
      workspaceId: scope.workspaceId,
      actorId: scope.userId,
      specId,
      path: specId,
      action: "update",
      outcome: "refused",
      attribution: "none",
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const { repo, path, title } = target;
  // Commits as the author when they have connected an account and can push,
  // which makes the trailer unnecessary: naming someone as co-author on a
  // commit they already authored reads as two people having written it.
  const { client, asAuthor } = await resolveSpecWriteClient(db, repo, scope);
  const existing = await client.readFile(path);
  const content = rewriteSpecBody(existing.raw, body, { id: specId, title });
  const message =
    opts.message?.trim() ||
    specCommitMessage({
      action: "update",
      title,
      path,
      author: asAuthor ? null : await resolveCommitAuthor(db, scope.userId),
      ...(opts.assistantDrafted ? { assistantDrafted: true } : {}),
    });
  const { mode } = resolveWriteMode(repo.config, repo.writeModeOverride);
  const { commitSha, blobSha, pullRequest, mergedWith, mergedBody } = await writeMerged(
    client,
    {
      path,
      content,
      message,
      mode,
      ...(opts.expectedBlobSha ? { expectedBlobSha: opts.expectedBlobSha } : {}),
    },
    { id: specId, title, body },
  );

  const audit = {
    workspaceId: scope.workspaceId,
    actorId: scope.userId,
    specId,
    repoId: repo.id,
    path,
    action: "update" as const,
    mode,
    attribution: (asAuthor ? "author" : "co_author") as "author" | "co_author",
    commitSha,
  };

  if (!pullRequest) {
    await recordSpecWrite(db, { ...audit, outcome: "committed" });
    await syncRepository(db, repo);
    return { specId, path, commitSha, blobSha, mergedWith, mergedBody };
  }

  await recordSpecWrite(db, {
    ...audit,
    outcome: "proposed",
    pullRequestNumber: pullRequest.number,
  });

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
  return { specId, path, commitSha, blobSha, pullRequest, mergedWith, mergedBody };
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
  const { repo, path, title } = await authorizeSpecWrite(db, scope, specId);
  const { client, asAuthor } = await resolveSpecWriteClient(db, repo, scope);
  const { commitSha } = await client.deleteFile({
    path,
    message:
      opts.message?.trim() ||
      specCommitMessage({
        action: "remove",
        title,
        path,
        author: asAuthor ? null : await resolveCommitAuthor(db, scope.userId),
      }),
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

  const { client, asAuthor } = await resolveSpecWriteClient(db, repo, scope);
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
  //
  // `expectedBlobSha: null` means "the file must not exist yet", which is the
  // create the existence check above only *looks* like: between that read and
  // this write someone else can commit the same path, and without the guard we
  // would overwrite their brand-new spec while reporting a success. The check
  // stays because it produces the far better message ("pick a different
  // title"); the guard is what makes the answer true.
  const { commitSha, blobSha } = await writeGuarded(client, {
    path,
    content: newSpecFile(id, title, body),
    message:
      input.message?.trim() ||
      specCommitMessage({
        action: "create",
        title,
        path,
        author: asAuthor ? null : await resolveCommitAuthor(db, scope.userId),
      }),
    mode: "direct",
    expectedBlobSha: null,
  });
  await syncRepository(db, repo);
  return { specId: id, path, commitSha, blobSha };
}
