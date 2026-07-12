import { redirect } from "next/navigation";

import { orgPath } from "@/lib/org-path";
import { currentOrgSlug } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Repository management moved under the consolidated Integrations page
 * (Repositories tab). Preserve any callback/setup query params (e.g.
 * `?connected=1`, `?error=...`) so the GitHub install/callback redirects and
 * bookmarked links still land on the right banner.
 */
export default async function RepositoriesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams({ tab: "repositories" });
  for (const [key, value] of Object.entries(params)) {
    if (key === "tab") continue;
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value) && value[0]) qs.set(key, value[0]);
  }
  redirect(orgPath(await currentOrgSlug(), `/settings/integrations?${qs.toString()}`));
}
