import { TagsManager } from "@/components/tags-manager";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Tags settings: the workspace's shared tag list.
 *
 * Its own section rather than a panel under Cards, because tags are not
 * card configuration. Everything else on that page is per product, scoped by a
 * product picker at the top; tags are workspace-wide, so they sat under a
 * control that did not apply to them and read as if switching product would
 * switch the list. Bulk management (multi-select removal, CSV upload) also
 * wants more room than a subsection inside a collapsed group.
 *
 * Any member sees the list. Changing it is owner-only, matching the write gates
 * on /api/v1/tags/:id, /api/v1/tags/bulk and /api/v1/tags/import, and the RLS
 * behind them.
 */
export default async function TagsSettingsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const tags = await store.listTags(access ?? undefined);
  const isOwner = !access || access.role === "owner";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Tags</h2>
        <p className="text-sm text-muted-foreground">
          One shared tag list for the whole workspace, so the same tag can&rsquo;t
          be spelled two ways. Tags are not tied to a product. Anyone can add one
          from a card; renaming one here renames it on every item that carries
          it.
        </p>
      </div>
      <TagsManager tags={tags} canEdit={isOwner} />
    </div>
  );
}
