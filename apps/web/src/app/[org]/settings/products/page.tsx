import { ProductsManager } from "@/components/products-manager";
import { getDb } from "@/lib/db";
import { getStore } from "@/lib/store";
import { listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Products settings: create and manage the org's products (sibling backlogs).
 * Everyone sees the list; only the owner can create products, and only the
 * owner or a product's own admin can edit, delete, or manage its members
 * (matching the /api/v1/products authorization).
 */
export default async function ProductsSettingsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);

  // Org admins (and local file mode) can create products and manage any one.
  const isOrgAdmin = !access || access.role === "owner";

  // Workspace members feed the "add member" picker on private products.
  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Products</h2>
        <p className="text-sm text-muted-foreground">
          Products are sibling backlogs in your organization. Switch between
          them on the Board and Roadmap.
        </p>
      </div>
      <ProductsManager
        products={products}
        groups={groups}
        members={members}
        isOrgAdmin={isOrgAdmin}
      />
    </div>
  );
}
