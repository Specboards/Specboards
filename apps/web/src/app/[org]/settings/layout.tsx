import type { ReactNode } from "react";

import { SettingsNav } from "@/components/settings-nav";
import { visibleSettingsSections } from "@/lib/settings-sections";
import { isMultiTenant } from "@/lib/tenancy";
import {
  listSidebarProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";

export const metadata = { title: "Settings · Specboards" };

/** Shell for the Settings section: a heading plus the sub-nav and content. */
export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await requireWorkspaceAccess();
  // Local file mode has no accounts and nothing to gate, so it sees the lot.
  const isOwner = !access || access.role === "owner";
  // Products and Cards are editable by the admin of a single product, which is
  // a per-product grant rather than a workspace role. Resolved here because
  // the nav is a client component and this is a database question.
  const products = isOwner ? [] : await listSidebarProducts();
  const sections = visibleSettingsSections({
    isOwner,
    managesAnyProduct: products.some((p) => p.viewerRole === "admin"),
    // Mail transport is the deployment's, not the workspace's. A hosted tenant
    // cannot change it and has no reason to read it, so the entry is left out
    // there rather than offered and refused.
    canConfigureMail: !isMultiTenant(),
  });

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, repositories, organization, and workspace configuration.
        </p>
      </div>
      <div className="flex flex-col gap-6 sm:flex-row">
        <SettingsNav sections={sections} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </section>
  );
}
