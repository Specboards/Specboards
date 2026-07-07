import { redirect } from "next/navigation";

import { orgPath } from "@/lib/org-path";
import { currentOrgSlug } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** API keys moved under the consolidated Integrations page (API keys tab). */
export default async function ApiKeysSettingsPage() {
  redirect(orgPath(await currentOrgSlug(), "/settings/integrations?tab=api-keys"));
}
