-- An assistant turn can carry a proposed edit. This records what happened to it.
--
-- ── Why this is columns on the message and not a `proposals` table ──────────
-- A proposal is not an object with a life of its own: it is one thing an
-- assistant turn may contain, it belongs to exactly one message, and it is only
-- ever read while reading that message. A separate table would add a join to
-- every thread read to answer a question the row itself can answer, and would
-- make "a message with two proposals" representable when the parser only ever
-- produces one (see lib/ai/proposals.ts).
--
-- The proposed text itself is deliberately NOT stored here. It is already in
-- `content`, between the markers, and copying it into a column would create two
-- versions of the same string that can disagree: the panel renders one, the
-- accept applies the other, and nothing would notice. The parser is the single
-- reader of both.
--
-- ── Why the base sha is recorded ────────────────────────────────────────────
-- A proposal is drafted against the description as it was at that moment. If
-- someone edits the spec while the answer is being written, or the proposal sits
-- unaccepted for a day, accepting it must not silently overwrite what landed in
-- between. Storing the sha the draft was made from lets the accept take the same
-- guarded, three-way-merged path a human editor's save takes, so a proposal that
-- can be merged in is, and one that genuinely collides is refused with the
-- conflict rather than applied over the top. NULL for a DB-native card, which
-- has no blob and no such guard today.

ALTER TABLE "assistant_messages"
  -- NULL means unresolved, which for a message with no proposal in it is also
  -- the permanent state. What decides whether there is a proposal at all is the
  -- content, so this column never has to answer that question.
  ADD COLUMN "proposal_outcome" text,
  ADD COLUMN "proposal_resolved_by" uuid,
  ADD COLUMN "proposal_resolved_at" timestamptz,
  -- The commit an accepted proposal landed in, for a git-backed spec. The item's
  -- history is the fuller record; this is what makes the thread itself able to
  -- say "and here is where it went".
  ADD COLUMN "proposal_commit_sha" text,
  ADD COLUMN "proposal_base_sha" text;--> statement-breakpoint

ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_proposal_outcome_check"
  CHECK ("proposal_outcome" IS NULL OR "proposal_outcome" IN ('accepted', 'rejected'));--> statement-breakpoint

-- Resolving one is a decision a person made, and the whole point of the feature
-- is that it was a person. Recorded together or not at all, so a row can never
-- claim to have been accepted by nobody.
ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_proposal_resolution_check"
  CHECK (
    ("proposal_outcome" IS NULL
      AND "proposal_resolved_by" IS NULL
      AND "proposal_resolved_at" IS NULL)
    OR ("proposal_outcome" IS NOT NULL
      AND "proposal_resolved_by" IS NOT NULL
      AND "proposal_resolved_at" IS NOT NULL)
  );
