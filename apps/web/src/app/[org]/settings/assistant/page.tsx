import Link from "next/link";

import { AssistantSkillsEditor } from "@/components/assistant-skills-editor";
import { CollapsibleSettingsGroup } from "@/components/collapsible-settings-group";
import { BUILT_IN_SKILLS, mergeSkills } from "@/lib/ai/skills";
import { getAppDb } from "@/lib/db";
import { orgPath } from "@/lib/org-path";
import { listSkills } from "@/lib/skills-service";
import { currentOrgSlug, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Assistant settings: what this workspace's assistant knows how to do.
 *
 * Its own page rather than a panel under Cards, because the question it answers
 * is "how do I teach the assistant the way we work", and nobody looks for that
 * under a heading about card fields. The model connection is the other half of
 * the same question and still lives under Integrations; consolidating the two
 * here is the obvious next move and deliberately not part of this change.
 *
 * Every member reads it, because every member presses these buttons. Writing is
 * owner-only, matching the API and the RLS behind it: a skill is a standing
 * instruction attached to every question anyone on the team asks afterwards, and
 * to every edit the assistant proposes off the back of one.
 */
export default async function AssistantSettingsPage() {
  const access = await requireWorkspaceAccess();
  const db = getAppDb();

  // Local file mode has no database and therefore no stored overrides. The
  // built-ins still exist, so the page shows what the assistant can do rather
  // than an error about a table nobody asked about.
  const skills =
    db && access
      ? await listSkills(db, access)
      : mergeSkills([]);
  const canEdit = Boolean(db) && (!access || access.role === "owner");
  const modelHref = orgPath(
    await currentOrgSlug(),
    "/settings/integrations?tab=model",
  );

  return (
    <div className="space-y-8">
      <CollapsibleSettingsGroup
        id="skills"
        title="Skills"
        description="Saved ways of asking, shown as buttons on every item. A skill is instructions the assistant is given while it runs, so this is where you encode how your team defines work."
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Every workspace starts with {BUILT_IN_SKILLS.length} of ours. Edit
            one to make it yours, switch off any you do not want, or add your
            own. Skills run on the model this workspace connected under{" "}
            <Link href={modelHref} className="text-link hover:underline">
              Integrations
            </Link>
            , and nothing a skill produces is applied to an item until someone
            accepts it.
          </p>
          <AssistantSkillsEditor initial={skills} canEdit={canEdit} />
        </div>
      </CollapsibleSettingsGroup>
    </div>
  );
}
