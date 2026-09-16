import { redirect } from "next/navigation";

import { orgPath } from "@/lib/org-path";
import { currentOrgSlug } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Skills moved to the consolidated Agents page, along with the model
 * connection they run on and the identities agents authenticate as.
 *
 * Kept as a redirect rather than deleted: this was a navigation entry for
 * several releases, so it is in bookmarks and in the revalidate path of the
 * skills API. Same treatment `/settings/api-keys` got when it folded into
 * Integrations.
 */
export default async function AssistantSettingsPage() {
  redirect(orgPath(await currentOrgSlug(), "/settings/agents?tab=skills"));
}
