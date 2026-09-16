import { ReviewInbox, type ReviewRowView } from "@/components/review-inbox";
import { getAppDb } from "@/lib/db";
import { listReviewQueue } from "@/lib/proposals/inbox";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * The review queue: everything an agent has produced that wants a decision.
 *
 * Workspace-scoped, not product-scoped, and that is the same call the
 * notification centre made for the same reason: a proposal about one product
 * and a proposal about another are one queue to work down. Scoping the page
 * to a product would mean a person with three products checking three
 * queues to answer one question.
 *
 * Rendered on the server so the list is there on arrival. There is no client
 * paging yet: the queue is meant to be worked down rather than browsed, and
 * a page of it that is long enough to need paging is a signal about the
 * agents rather than about the page.
 */
export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const access = await requireWorkspaceAccess();
  const db = getAppDb();

  // Local file mode has no proposals table and no agents to fill it. An empty
  // queue is the honest answer there, and is what the component renders.
  const rows = db && access ? await listReviewQueue(db, access) : [];

  // Product keys, for the links out. Resolved here rather than joined into
  // the query because the page already needs the caller's product list and a
  // join would return the key once per row.
  const store = await getStore();
  const products = await store.listProducts(access ?? undefined);
  const keyById = new Map(products.map((p) => [p.id, p.key]));

  const view: ReviewRowView[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ...(r.proposalKind ? { proposalKind: r.proposalKind } : {}),
    targetType: r.targetType,
    targetId: r.targetId,
    targetRef: r.targetRef,
    targetTitle: r.targetTitle,
    targetLevel: r.targetLevel,
    productKey: r.productId ? (keyById.get(r.productId) ?? null) : null,
    actorName: r.actorName,
    runId: r.runId,
    evidenceCount: r.evidenceCount,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Reviews</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Changes agents have drafted, and runs that stopped to ask something.
          Nothing here is applied until somebody applies it.
        </p>
      </header>
      <ReviewInbox initial={view} org={org} />
    </section>
  );
}
