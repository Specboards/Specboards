-- Every attempt to write a spec, recorded in the product.
--
-- Not a duplicate of git history, for two reasons. It answers the question
-- inside the app, where the people asking it are, without anyone needing a
-- checkout or a GitHub account. And it stays answerable when the write did not
-- land: a save refused for permissions, a proposal closed without merging, a
-- GitHub outage. Git has no record of a commit that never happened, which is
-- exactly the case someone is investigating when they ask why a change they
-- remember making is not there.
--
-- `attribution` is what makes this worth keeping once user tokens exist: it
-- records whether a change was committed as the author, credited to them
-- through a co-author trailer, or attributed to nobody. Without it, a repo
-- history full of app-authored commits cannot be told apart from one where
-- attribution silently stopped working.
--
-- `outcome` covers refusal as deliberately as success, and `detail` carries the
-- reason in the words the author was shown, so the record answers "why" and not
-- merely "no".
--
-- No foreign key to users: an audit row must outlive the account it names, or
-- it stops being an audit trail the moment someone leaves.

CREATE TABLE IF NOT EXISTS "spec_write_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "actor_id" uuid,
  "actor_label" text,
  "spec_id" uuid,
  "repo_id" uuid,
  "path" text NOT NULL,
  "action" text NOT NULL,
  "mode" text,
  "outcome" text NOT NULL,
  "attribution" text NOT NULL,
  "commit_sha" text,
  "pull_request_number" integer,
  "detail" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "spec_write_audit_ws_created_idx"
  ON "spec_write_audit" ("workspace_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "spec_write_audit_spec_idx"
  ON "spec_write_audit" ("spec_id");

-- Readable by any member of the workspace: this is the workspace's own record
-- of what happened to its documents, not a per-user secret. Append-only in
-- practice; nothing in the app updates or deletes a row.
ALTER TABLE "spec_write_audit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY spec_write_audit_member_all ON "spec_write_audit"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));
