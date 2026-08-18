-- Let an assistant thread be about a release, not only about an item.
--
-- ── Why widen this table rather than add a second one ───────────────────────
-- The alternative was `release_assistant_messages`, which keeps every existing
-- constraint untouched and duplicates the reader, the view mapper, the proposal
-- columns and the retention story. Everything above the row is already
-- subject-agnostic: the panel, the streaming protocol, the history cap and the
-- spend accounting neither know nor care what the thread is about. Forking the
-- storage to keep one NOT NULL would fork all of that with it, and the two
-- copies would drift on the first change to either.
--
-- ── Why there is no `subject_type` column ───────────────────────────────────
-- It would be a second source of truth for a fact the columns already carry,
-- and the two could disagree. Same reasoning as `proposal_outcome`, where
-- whether a turn *contains* a proposal is decided by parsing the content and
-- never by a column: a row saying `subject_type = 'release'` with a `feature_id`
-- set is a row nothing can interpret. `num_nonnulls` gives the same guarantee
-- with nothing to keep in step.
--
-- ── What stays true ─────────────────────────────────────────────────────────
-- Deleting the subject still takes its conversation with it. That was the whole
-- point of keying on the internal row id rather than on `spec_id` (see 0068),
-- and a release thread earns it for the same reason: the thread quotes the
-- notes, so a thread outliving its release would hold a copy of content
-- somebody deleted.

ALTER TABLE "assistant_messages"
  ADD COLUMN "release_id" uuid REFERENCES "releases"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Was NOT NULL. The check below is what replaces it: every row still has
-- exactly one subject, and now there are two kinds it can be.
ALTER TABLE "assistant_messages"
  ALTER COLUMN "feature_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_subject_check"
  CHECK (num_nonnulls("feature_id", "release_id") = 1);--> statement-breakpoint

-- Every read is "this subject's thread, oldest first", so this carries the
-- ordering as well as the lookup, matching `assistant_messages_feature_idx`.
CREATE INDEX "assistant_messages_release_idx"
  ON "assistant_messages" ("workspace_id", "release_id", "created_at");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS: read still follows the subject rather than the workspace.
--
-- A member who cannot see a product must not read the conversation about one of
-- its releases, which would otherwise be a back door to the release's contents
-- (the thread quotes them). `specboards_can_read_product` returns true for a
-- NULL product, so a portfolio release's thread is readable by any member,
-- which is the same rule a portfolio release itself already follows. Writing to
-- one is org-admin-only, and that gate lives in the service where the rest of
-- the product-write checks are.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS assistant_messages_read ON "assistant_messages";--> statement-breakpoint

CREATE POLICY assistant_messages_read ON "assistant_messages"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM features f
      WHERE f.id = assistant_messages.feature_id
        AND specboards_can_read_product(f.workspace_id, f.product_id)
    )
    OR EXISTS (
      SELECT 1 FROM releases r
      WHERE r.id = assistant_messages.release_id
        AND specboards_can_read_product(r.workspace_id, r.product_id)
    )
  );
