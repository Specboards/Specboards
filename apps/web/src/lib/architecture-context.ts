import type { Database } from "@specboards/db";

import { loadGithubDocIndex, readGithubDocFile } from "@/lib/github-docs";
import { getStore } from "@/lib/store";
import type { DocPageRecord, WorkspaceScope } from "@/lib/store/types";

/**
 * Reading a product's Architecture area, so a skill can check work against it.
 *
 * ── Why this is a deliberate widening ───────────────────────────────────────
 * Every skill until now ran on one item and nothing else. `lib/ai/item-context.ts`
 * says so in its own docstring and excludes "other items" and "anything from
 * settings" by name. An architecture review cannot work that way: the whole
 * point is the second document, and a review that quietly read only the spec
 * would report that everything is fine, which is worse than not running.
 *
 * So this module exists to make the widening explicit and bounded. It decides
 * what may be read, and `item-context.ts` turns what comes back into fields,
 * which is what puts every page into the disclosure a person sees before they
 * press the button. A team whose architecture docs are confidential has to be
 * able to see that those pages are about to go to their model provider, and the
 * only way that stays true is if this module never hands text to the prompt by
 * any route but the field list.
 *
 * ── What is sent, and why not simply "the area" ─────────────────────────────
 * An architecture area is a tree, and a real one does not fit in a prompt.
 * Truncating it hands the model an arbitrary prefix and lets it report
 * confidently on the half it happened to receive, which is the failure this
 * whole feature is trying to prevent rather than reproduce.
 *
 * Two things go instead:
 *
 * - **The whole outline**: every page's path, no text. It is cheap, and it is
 *   what lets the model say "this touches the event bus, see Events/Bus"
 *   without having read that page, and notice that what is being proposed has
 *   no page at all.
 * - **The text of as many pages as the budget allows**, breadth-first. The
 *   pages a team put at the top of its area are its overviews; depth is reached
 *   only when there is room.
 *
 * A page too large to fit is skipped whole rather than cut, and the outline
 * still names it. Half a page of architecture is the arbitrary prefix again, in
 * miniature.
 *
 * ── Why "marked as the constitution" is not here yet ────────────────────────
 * The better rule is that a team marks the pages every review must read. That
 * is a stored designation and a migration, and the thin version answers the
 * same question well enough to find out whether anybody wants the feature at
 * all. Breadth-first is the stand-in, and it is deliberately a rule a reader
 * can predict rather than a heuristic.
 */

/** One page whose text is going into the prompt. */
export interface ArchitecturePage {
  /** Path within the area, as it appears in the outline. */
  path: string;
  body: string;
}

export interface ArchitectureContext {
  /** Every page in the area, breadth-first, one path per entry. */
  outline: string[];
  /** The pages whose text was read, in outline order. */
  pages: ArchitecturePage[];
  /** True when the area holds more pages than the outline could list. */
  outlineTruncated: boolean;
}

/**
 * Why there was nothing to read.
 *
 * Three cases rather than one because a person can act on each differently:
 * set the area up, move the docs somewhere we can read, or write something in
 * it. "No architecture context" would tell them none of that.
 */
type ArchitectureGap = "none" | "external" | "empty";

type ArchitectureRead =
  | { ok: true; context: ArchitectureContext }
  | { ok: false; gap: ArchitectureGap };

/**
 * Most pages whose text is sent.
 *
 * Bounded by requests as much as by characters: in a GitHub-backed area each
 * page is a separate read, so an unbounded rule would turn one button press
 * into a crawl of somebody's documentation repository.
 */
const PAGE_LIMIT = 8;

/**
 * Total characters of page text.
 *
 * Beside `BODY_CHAR_LIMIT` rather than instead of it: the item's own
 * description still gets its budget, and this is what the prompt grows by when
 * an architecture skill runs. Set smaller than the body limit on purpose. The
 * item is the subject and the architecture is the reference, and a prompt where
 * the reference outweighs the subject produces a review of the architecture.
 */
const PAGE_CHAR_LIMIT = 6_000;

/**
 * Most paths the outline lists.
 *
 * Generous, because an outline entry is a line rather than a document, and
 * bounded because an area with four thousand pages would otherwise spend the
 * whole prompt proving it.
 */
const OUTLINE_LIMIT = 200;

/** A page as the chooser sees it: where it is, and how much of the budget it costs. */
interface PageMeta {
  path: string;
  chars: number;
}

/** How deep a path sits. The area root is depth 1. */
function depthOf(path: string): number {
  return path.split("/").length;
}

/**
 * Which pages to send, breadth-first, within the budget.
 *
 * Pure and exported for its tests: the rule is the part of this module that has
 * to be predictable, and it is the part that would otherwise only be observable
 * by watching what a model was sent.
 *
 * An oversized page is skipped and the scan continues rather than stopping.
 * Stopping would let one large document at the top of an area hide everything
 * below it, and the reader would see an outline full of pages and a review that
 * mentioned none of them.
 */
export function choosePages(pages: readonly PageMeta[]): string[] {
  const ordered = [...pages].sort(
    (a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path),
  );

  const chosen: string[] = [];
  let spent = 0;
  for (const page of ordered) {
    if (chosen.length >= PAGE_LIMIT) break;
    if (spent + page.chars > PAGE_CHAR_LIMIT) continue;
    chosen.push(page.path);
    spent += page.chars;
  }
  return chosen;
}

/**
 * The path a locally-held page is known by: its folder titles and its own,
 * joined.
 *
 * Titles rather than ids, because the path is read by a model and quoted back
 * to a person. A cycle in the parent chain (which the store's folder checks
 * should prevent, but which a hand-edited database could hold) stops at the
 * page rather than looping.
 */
function localPath(page: DocPageRecord, byId: Map<string, DocPageRecord>): string {
  const parts = [page.title.trim()];
  const seen = new Set<string>([page.id]);
  let parentId = page.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.title.trim());
    parentId = parent.parentId;
  }
  return parts.join("/");
}

/** The outline, with the entries that did not fit dropped from the end. */
function outlineOf(paths: readonly string[]): {
  outline: string[];
  outlineTruncated: boolean;
} {
  return {
    outline: paths.slice(0, OUTLINE_LIMIT),
    outlineTruncated: paths.length > OUTLINE_LIMIT,
  };
}

/**
 * Pages held in Specboards itself. One read, text included.
 *
 * `configured` is what separates the two ways of having nothing: a team that
 * chose this area and has not written in it yet is told the area is empty, and
 * a team that never set one up is told to set one up. Collapsing the two sends
 * somebody to Plan to create an area they are already looking at, or leaves
 * somebody who has none waiting for pages to appear in it.
 */
async function readLocal(
  scope: WorkspaceScope,
  productId: string,
  configured: boolean,
): Promise<ArchitectureRead> {
  const store = await getStore();
  const rows = await store.listDocPages(productId, "architecture", scope);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const pages = rows
    .filter((r) => r.kind === "page")
    .map((r) => ({ page: r, path: localPath(r, byId) }))
    .filter((p) => p.path.trim() !== "");
  if (pages.length === 0) {
    return { ok: false, gap: configured ? "empty" : "none" };
  }

  const byPath = new Map(pages.map((p) => [p.path, p.page]));
  const chosen = choosePages(
    pages.map((p) => ({ path: p.path, chars: p.page.content.length })),
  );
  const { outline, outlineTruncated } = outlineOf(
    // Sorted the way the chooser sorts, so the outline a reader sees and the
    // order pages were taken in are the same order. An outline in one order and
    // a selection in another reads as arbitrary.
    [...pages].map((p) => p.path).sort(
      (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
    ),
  );

  return {
    ok: true,
    context: {
      outline,
      outlineTruncated,
      pages: chosen.map((path) => ({
        path,
        body: byPath.get(path)?.content ?? "",
      })),
    },
  };
}

/**
 * Pages held in a GitHub repository.
 *
 * The index first, which is a single request carrying every path and size, then
 * one read per page actually being sent. Loading the whole tree would be the
 * obvious thing and is what `loadGithubDocs` is for; it is one request per file
 * in the repository, to send at most eight of them.
 */
async function readGithub(
  db: Database,
  scope: WorkspaceScope,
  productId: string,
): Promise<ArchitectureRead> {
  const store = await getStore();
  const space = await store.getDocSpace(productId, "architecture", scope);
  const index = await loadGithubDocIndex(db, scope.workspaceId, space);
  if (index.entries.length === 0) return { ok: false, gap: "empty" };

  const { outline, outlineTruncated } = outlineOf(
    [...index.entries]
      .map((e) => e.path)
      .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)),
  );
  // `size` is bytes and the budget is characters. They agree for ASCII and the
  // byte count is the larger of the two for anything else, so using it spends
  // the budget slightly early rather than overrunning it. Worth the
  // approximation: the alternative is downloading every file to measure it,
  // which is the request storm this path exists to avoid.
  const chosen = choosePages(
    index.entries.map((e) => ({ path: e.path, chars: e.size })),
  );

  const pages: ArchitecturePage[] = [];
  for (const path of chosen) {
    try {
      const file = await readGithubDocFile(db, scope.workspaceId, space, path);
      pages.push({ path, body: file.content });
    } catch {
      // A page the index listed and the read could not fetch is left out and
      // still named in the outline, which is the same treatment an oversized
      // page gets. Failing the whole review over one unreadable file would
      // throw away a review that is mostly fine.
    }
  }

  return { ok: true, context: { outline, outlineTruncated, pages } };
}

/**
 * The architecture context for one product, or why there is none.
 *
 * Never throws for an area that simply is not set up: "no architecture docs" is
 * an answer a person can act on, and the caller turns it into a refusal before
 * any model is called. A GitHub area that is configured but unreachable does
 * throw, because that is a fault rather than an absence, and reporting it as
 * "you have no architecture docs" would send somebody to set up an area they
 * already have.
 */
export async function readArchitecture(
  db: Database,
  scope: WorkspaceScope,
  productId: string,
): Promise<ArchitectureRead> {
  const store = await getStore();
  const space = await store.getDocSpace(productId, "architecture", scope);

  if (space.mode === "external") return { ok: false, gap: "external" };
  if (space.mode === "github") return readGithub(db, scope, productId);
  // `local` and `unset` are the same read. An area nobody configured still
  // holds pages if anybody wrote one, because `createDocPage` never asked about
  // the mode, and telling a team that the pages they can see on screen do not
  // exist would be a strange way to start a review. The mode is carried
  // through only to tell the two empty cases apart.
  return readLocal(scope, productId, space.mode === "local");
}

/** What to tell somebody whose review cannot run, in terms they can act on. */
export function architectureGapMessage(gap: ArchitectureGap): string {
  switch (gap) {
    case "external":
      return (
        "This product's Architecture area links out to another system, so its " +
        "pages cannot be read from here. Move them into Specboards or a " +
        "connected repository to review work against them."
      );
    case "empty":
      return (
        "This product's Architecture area has no pages yet, so there is " +
        "nothing to review this against."
      );
    default:
      return (
        "This product has no Architecture area set up, so there is nothing to " +
        "review this against. Set one up under Plan to use this skill."
      );
  }
}
