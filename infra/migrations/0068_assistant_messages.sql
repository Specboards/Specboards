-- The assistant's conversation about an item. First schema the spec-assistant
-- epic needs, and the thinnest one that makes a definition session survive a
-- closed tab.
--
-- ── Why there is no `assistant_conversations` table ─────────────────────────
-- The obvious shape is conversations, each with messages, so an item can hold
-- several independent threads. It is deliberately not done. One thread per item
-- is what the feature is for: a colleague opening the card should see how this
-- definition was arrived at, and with several threads they see one of them and
-- cannot tell whether it is the one that mattered. A thread list is also a UI
-- affordance nobody has asked for, and inventing the parent table now means
-- every read carries a join that resolves to the same row every time.
--
-- Adding it later is additive: a nullable `conversation_id` here, backfilled to
-- one row per item. Removing a parent table that turned out to have exactly one
-- child grouping is the harder direction, so this starts without it.
--
-- ── Why `feature_id` and not `spec_id` ──────────────────────────────────────
-- Same as `comments`: the internal row id carries an FK, so deleting an item
-- takes its conversation with it. `spec_id` is only unique per workspace and
-- carries no referential integrity, so a conversation keyed on it would outlive
-- the item it discusses, holding a copy of that item's content indefinitely.
--
-- ── Why token counts live on the message ────────────────────────────────────
-- NOT accounting: that is its own feature (usage accounting and spend
-- guardrails), and it will aggregate these rather than being implemented here.
-- They are recorded because the endpoint reports them in the same response that
-- produced the row, they are the only place that number is ever available, and
-- an assistant that has spent a customer's money with no record of how much is
-- not a state to ship even for one release. Nullable, because a runtime is free
-- not to report them and several do not.

CREATE TABLE "assistant_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "feature_id" uuid NOT NULL REFERENCES "features"("id") ON DELETE CASCADE,
  -- Who spoke. 'system' is deliberately not storable: the system prompt is
  -- assembled from the item on every request (see lib/ai/item-context.ts) so
  -- that a conversation started before a prompt change does not keep replaying
  -- the old one, and persisting it would make that impossible to fix.
  "role" text NOT NULL,
  "content" text NOT NULL,
  -- The human this turn belongs to: who typed it for a 'user' turn, and who
  -- asked for it for an 'assistant' turn. Non-null for both, so every row in
  -- the thread names a person who is accountable for it. A snapshot with no FK,
  -- matching `notifications.actor_id`: deactivating someone must not rewrite the
  -- record of how a definition was arrived at.
  "author_id" uuid NOT NULL,
  -- What the endpoint said answered, which is not always what was asked for:
  -- gateways alias and substitute. NULL on a 'user' turn.
  "model" text,
  -- As reported by the endpoint. NULL means it reported nothing, which is not
  -- the same as zero and must not be summed as if it were.
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "assistant_messages_role_check" CHECK ("role" IN ('user', 'assistant'))
);--> statement-breakpoint

-- Every read is "this item's thread, oldest first", so the index carries the
-- ordering as well as the lookup.
CREATE INDEX "assistant_messages_feature_idx"
  ON "assistant_messages" ("workspace_id", "feature_id", "created_at");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS.
--
-- Read follows the item, not the workspace: a member who cannot see the product
-- must not read the conversation about one of its items, which would otherwise
-- be a way to read the item's content through the back door (the thread quotes
-- it). Copied in shape from `comments_read` in 0012 for exactly that reason.
--
-- Write is member-level, because the product-level write check lives in the
-- service and the API route. Anyone who can read an item can ask the assistant
-- about it, the same rule as commenting on it.
--
-- ── "RLS here is the backstop rather than the gate" was aspirational ───────
-- It was not true when it was written: the assistant routes ran on the owner
-- connection, which RLS exempts, so these policies were never evaluated and the
-- service check was the whole of the enforcement. 0078 moved those routes onto
-- `specboards_app`, and the sentence is now accurate.
--
-- Worth keeping in mind for the next table: `comments`, which this policy was
-- copied from, was live all along because comments are read through
-- `getStore()`. Same shape, different connection, opposite answer. Which
-- connection a path uses is the thing to check. See `getDb()` and `getAppDb()`
-- in apps/web/src/lib/db.ts.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY assistant_messages_read ON "assistant_messages"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM features f
      WHERE f.id = assistant_messages.feature_id
        AND specboards_can_read_product(f.workspace_id, f.product_id)
    )
  );--> statement-breakpoint

CREATE POLICY assistant_messages_write ON "assistant_messages"
  FOR ALL USING (specboards_is_member("workspace_id"))
  WITH CHECK (specboards_is_member("workspace_id"));--> statement-breakpoint

-- Table privileges for the app connection. `infra/rls-role.sql` sets ALTER
-- DEFAULT PRIVILEGES so new tables are reachable automatically, but the live
-- test and prod clusters predate that script and use a `writer` group role with
-- per-table grants instead: without this the table is invisible to
-- specboards_app on exactly the two databases that matter. Same guarded shape as
-- 0067; see the note there for what the failure looks like.
--
-- Not granted to specboards_worker, for the same reason 0067 withheld the model
-- provider tables: no background job calls a model, and none should be able to
-- read what a customer discussed with one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_messages" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_messages" TO specboards_app;
  END IF;
END $$;
