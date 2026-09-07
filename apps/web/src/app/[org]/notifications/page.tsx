import { NotificationCenter } from "@/components/notification-center";
import { listNotifications } from "@/lib/notifications-service";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * The notification centre: everything that has happened to the reader's work,
 * with somewhere to stand while they catch up.
 *
 * The bell panel is a summary of the newest few and always was; that was fine
 * while a mention was the only thing that could reach it and useless once every
 * assignment and status change does. There was nowhere to go to answer "what
 * happened to my work this week".
 *
 * Workspace-scoped rather than product-scoped, which answers the card's open
 * question. The content is personal, but the scope is the workspace: a
 * notification about one product and a notification about another belong in one
 * list, which is exactly why the page has a product *filter* rather than a
 * product in its path. It sits beside Dashboard for the same reason.
 *
 * The first page is rendered on the server so the list is there on arrival;
 * filtering and paging past it are client fetches against the same endpoint.
 */
export default async function NotificationsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const [initial, products] = await Promise.all([
    listNotifications(access ?? undefined),
    store.listProducts(access ?? undefined),
  ]);

  return (
    <section className="mx-auto max-w-3xl">
      <NotificationCenter
        initial={initial}
        products={products.map((p) => ({ key: p.key, name: p.name }))}
      />
    </section>
  );
}
