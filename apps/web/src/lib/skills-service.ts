import { asc, eq, workspaceAssistantSkills, type Database } from "@specboards/db";

import { asUser, type ScopedTx } from "@/lib/db-scope";

import {
  mergeSkills,
  type Skill,
  type SkillRow,
} from "@/lib/ai/skills";

/**
 * Reading and replacing a workspace's assistant skills.
 *
 * Beside `assistant-service.ts` and querying the database directly rather than
 * going through the store interface, for the same reason the conversation does:
 * this is a table the app owns outright, with no file-mode equivalent and no
 * business appearing in the local-file store that backs a repo-only install.
 *
 * ── Why replace-all rather than create/update/delete ────────────────────────
 * The thing being edited is a *set*: the panel shows a row of buttons, and the
 * decisions a person makes on this page are about that row as a whole (this one
 * off, this one reworded, this one added, in this order). Three endpoints
 * modelling it as independent records would mean the browser issuing a
 * correlated burst of them and inventing its own idea of what happens when the
 * third fails. The same call the stage gates editor makes, for the same reason.
 */

/** Who is asking, and about which workspace. Both are needed: see the note above. */
export interface SkillScope {
  userId: string;
  workspaceId: string;
}

/** The workspace's skills as the app sees them: built-ins plus its own rows. */
export async function listSkills(
  db: Database,
  scope: SkillScope,
): Promise<Skill[]> {
  return mergeSkills(await asUser(db, scope.userId, (tx) => readRows(tx, scope.workspaceId)));
}

/**
 * One skill by key, or null.
 *
 * Null covers three cases on purpose: no such key, a skill the workspace
 * disabled, and a skill that has since been deleted. All three mean the same
 * thing to a caller about to run one, and distinguishing them would only give a
 * caller a way to probe for skills it is not being offered.
 */
export async function findEnabledSkill(
  db: Database,
  scope: SkillScope,
  key: string,
): Promise<Skill | null> {
  const skills = await listSkills(db, scope);
  return skills.find((s) => s.key === key && s.enabled) ?? null;
}

/**
 * Replace the workspace's stored skills with exactly this set.
 *
 * Deleting first and inserting after, inside one transaction, because the input
 * is a whole set and a diff would have to reason about renames, reorders and
 * key reuse to arrive at the same place. Nothing here is hot: this runs when an
 * admin presses Save on a settings page.
 */
export async function replaceSkills(
  db: Database,
  scope: SkillScope,
  rows: readonly SkillRow[],
): Promise<Skill[]> {
  const { workspaceId } = scope;
  // One transaction, and it is the same one that carries `app.user_id`: the
  // delete and the insert are both governed by the org-admin write policy, and
  // a caller who is not an admin must fail before either lands rather than
  // between them.
  await asUser(db, scope.userId, async (tx) => {
    await tx
      .delete(workspaceAssistantSkills)
      .where(eq(workspaceAssistantSkills.workspaceId, workspaceId));
    if (rows.length > 0) {
      await tx.insert(workspaceAssistantSkills).values(
        rows.map((r, i) => ({
          workspaceId,
          key: r.key,
          name: r.name,
          description: r.description,
          instructions: r.instructions,
          surface: r.surface,
          enabled: r.enabled,
          // Positions are assigned from the submitted order rather than taken
          // from the input, so a client that sends duplicates or gaps cannot
          // produce an order nobody can reproduce.
          position: i,
        })),
      );
    }
  });
  return listSkills(db, scope);
}

async function readRows(tx: ScopedTx, workspaceId: string): Promise<SkillRow[]> {
  const rows = await tx
    .select({
      key: workspaceAssistantSkills.key,
      name: workspaceAssistantSkills.name,
      description: workspaceAssistantSkills.description,
      instructions: workspaceAssistantSkills.instructions,
      surface: workspaceAssistantSkills.surface,
      enabled: workspaceAssistantSkills.enabled,
      position: workspaceAssistantSkills.position,
    })
    .from(workspaceAssistantSkills)
    .where(eq(workspaceAssistantSkills.workspaceId, workspaceId))
    .orderBy(asc(workspaceAssistantSkills.position));

  // The column is `text` with a CHECK, so the database guarantees the value and
  // the type does not. Narrowed here rather than asserted: a row that somehow
  // holds an unknown surface falls back to the item panel, which is where every
  // skill lived before releases had an assistant, instead of resolving to a
  // button that renders nowhere and looks like the save silently failed.
  return rows.map((r) => ({
    ...r,
    surface: r.surface === "release" ? ("release" as const) : ("item" as const),
  }));
}
