import type { ReactNode } from "react";

import { SettingsNav } from "@/components/settings-nav";

export const metadata = { title: "Settings · Specboards" };

/** Shell for the Settings section: a heading plus the sub-nav and content. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, repositories, organization, and workspace configuration.
        </p>
      </div>
      <div className="flex flex-col gap-6 sm:flex-row">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </section>
  );
}
