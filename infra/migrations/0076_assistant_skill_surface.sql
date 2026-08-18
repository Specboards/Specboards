-- Which surface a skill belongs to.
--
-- Until now every skill was a button on an item, so there was nothing to say.
-- Now that a release carries an assistant too, the set has to be split: "Grill
-- me" on a release is nonsense, and "Draft the release notes" on a work item is
-- worse than nonsense, because a team that presses it gets a confident answer
-- about the wrong thing.
--
-- ── Why a column and not a naming convention ────────────────────────────────
-- The alternative was to infer it from the key (anything starting `release-`).
-- That works until a team invents a skill of their own, which is the case this
-- table exists for: they would have to know our prefix convention to get their
-- button to appear, and nothing would tell them. A column is a control in the
-- editor rather than a rule nobody can see.
--
-- Defaults to 'item' rather than being backfilled per row: every skill that
-- exists today is an item skill, and a default means an older client that does
-- not know about surfaces keeps writing rows that land in the right place.

ALTER TABLE "workspace_assistant_skills"
  ADD COLUMN "surface" text NOT NULL DEFAULT 'item';--> statement-breakpoint

-- A closed set, in the database as well as in code. Unlike `UsageFeature`,
-- where a CHECK was deliberately avoided because adding a call site should not
-- need a migration, a surface is a place in the product: there is no way to add
-- one without building the panel that renders it, and a typo here would hide a
-- team's skill with no error anywhere.
ALTER TABLE "workspace_assistant_skills"
  ADD CONSTRAINT "workspace_assistant_skills_surface_check"
  CHECK ("surface" IN ('item', 'release'));--> statement-breakpoint

-- The key is unique per workspace and stays that way across surfaces. A team
-- with one "Tighten the wording" skill should not silently end up with two that
-- are impossible to tell apart in the editor; if they want one on each surface
-- they name them separately, which is also what makes each one's instructions
-- readable on its own.
CREATE INDEX "workspace_assistant_skills_surface_idx"
  ON "workspace_assistant_skills" ("workspace_id", "surface", "position");
