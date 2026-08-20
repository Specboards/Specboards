-- Skills: the standing instructions a team gives their assistant.
--
-- ── Why a table at all, when the skills ship in code ────────────────────────
-- The three built-in skills (see lib/ai/skills.ts) are constants, so a fresh
-- self-host has them with no seeding and no backfill. This table holds only what
-- a workspace has actually changed: an override of a built-in (a row carrying
-- its key), a skill of their own (any other key), or a built-in switched off
-- (`enabled = false`). A workspace that has never opened the page owns no rows,
-- and so keeps tracking the code as we improve those prompts.
--
-- ── Why the key is stored and not derived ──────────────────────────────────
-- `key` is what makes an override an override, and it is what a live
-- conversation refers to (see `assistant_messages.skill_key` below). Deriving it
-- from the name would mean renaming "Grill me" to "Interrogate me" silently
-- stopped overriding the built-in and orphaned every thread that was running it.
CREATE TABLE IF NOT EXISTS "workspace_assistant_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "name" text NOT NULL,
  -- One line under the button in the panel. Never sent to the model: it is there
  -- to help a person choose, and a model given the description as well as the
  -- instructions tends to answer the description.
  "description" text NOT NULL DEFAULT '',
  "instructions" text NOT NULL,
  -- False hides a skill from the panel without losing its wording, which is what
  -- a team wants when they are retiring one of ours rather than replacing it.
  "enabled" boolean NOT NULL DEFAULT true,
  -- Order of the team's own skills among themselves. Built-ins are always first
  -- and in code order, so the flagship does not move when someone adds one.
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- One row per key per workspace. Two rows claiming a key means one of them is
-- silently ignored and the person who wrote it cannot tell which.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_assistant_skills_key_idx"
  ON "workspace_assistant_skills" ("workspace_id", "key");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- Every member reads them, because every member sees the buttons. Only an org
-- admin writes them: a skill is a standing instruction attached to every future
-- question anyone on the team asks, and to every edit the assistant proposes
-- off the back of one. That is a different kind of power from asking a question,
-- and it belongs with the people who chose the model endpoint.
--
-- Enforced by the route, not by these policies. `/api/v1/assistant-skills`
-- resolves `getDb()`, the owner connection, which RLS exempts; these rules are
-- only reached over `specboards_app`, which nothing touching this table
-- connects as. Same situation as 0067 and 0068, and the same note applies: see
-- `getDb()` in apps/web/src/lib/db.ts.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspace_assistant_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY workspace_assistant_skills_read ON "workspace_assistant_skills"
  FOR SELECT USING (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_assistant_skills_write ON "workspace_assistant_skills"
  FOR ALL USING (specboards_is_org_admin("workspace_id"))
  WITH CHECK (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

-- Which skill was in force for a turn.
--
-- Recorded rather than recomputed, because the wording of a skill changes and
-- the thread has to stay readable afterwards: without this, a conversation that
-- was a grilling reads back as a series of unprompted questions. It is also what
-- the panel reseeds from, so reopening an item picks the interrogation back up
-- where it was rather than dropping the person into a blank composer.
--
-- NULL means an ordinary typed question. A key that no longer resolves to a
-- skill is treated as NULL rather than as an error: deleting a skill must not
-- break the threads that used it.
ALTER TABLE "assistant_messages"
  ADD COLUMN IF NOT EXISTS "skill_key" text;--> statement-breakpoint

-- Table privileges for the app connection, guarded for the live clusters that
-- predate `infra/rls-role.sql`'s default privileges. Same shape and same reason
-- as 0068; not granted to specboards_worker, which has no business reading what
-- a customer instructs their model to do.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_assistant_skills" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_assistant_skills" TO specboards_app;
  END IF;
END $$;
