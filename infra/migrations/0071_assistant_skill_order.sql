-- Let a workspace put its skills in its own order without freezing their wording.
--
-- ── The problem ────────────────────────────────────────────────────────────
-- 0070 stored a row only for a skill a team had actually rewritten, so the ones
-- they left alone kept resolving from the code and kept tracking every later
-- improvement to those prompts. Ordering breaks that arrangement: a position is
-- per skill, so dragging one built-in past another needs a row for both, and a
-- row that must carry the text as well would silently pin all of them to
-- whatever they said that afternoon. Nobody would ever connect "we reordered the
-- buttons last spring" to "our assistant's prompts stopped improving".
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- The text columns become nullable, and null means "whatever the built-in says".
-- A row then states two separable things: where this skill sits and whether it
-- is on (always), and what it says (only once a team has rewritten it).
--
-- Null is meaningless on a skill the team invented, since there is no code to
-- fall back to; `lib/ai/skills.ts` refuses to store one rather than letting a
-- nameless button that instructs nothing into the table. That rule needs to know
-- which keys are built in, which is a fact about the application rather than the
-- schema, so it is not a CHECK here.
ALTER TABLE "workspace_assistant_skills"
  ALTER COLUMN "name" DROP NOT NULL,
  ALTER COLUMN "instructions" DROP NOT NULL,
  ALTER COLUMN "description" DROP NOT NULL,
  -- The default came from 0070, where every stored row carried its own text and
  -- '' meant "no description". It has to go, or a position-only row inserted
  -- without a description would land as '' and read as "this team deliberately
  -- cleared our one-liner" instead of "they never touched it".
  ALTER COLUMN "description" DROP DEFAULT;--> statement-breakpoint

-- ── Backfill: keep the buttons where they were ─────────────────────────────
-- Under 0070 the display order was "built-ins first, in code order, then the
-- team's own by position", and only changed skills had rows at all. Under the
-- new rule a stored position wins outright, so a workspace that had customised
-- one built-in (position 0, being its only row) would find it jumping to the
-- front of the row of buttons the moment this deploys. Nobody asked for that,
-- and it is exactly the kind of change people assume they caused themselves.
--
-- So every workspace that owns any row gets a complete, explicit arrangement
-- that reproduces what it was already looking at. The three keys are spelled out
-- because that is what the code shipped in 0070 defined; a built-in added later
-- has no row here and sorts last, which is where a new button belongs.
INSERT INTO "workspace_assistant_skills"
  ("workspace_id", "key", "name", "description", "instructions", "enabled", "position")
SELECT DISTINCT s."workspace_id", b.key, NULL, NULL, NULL, true, 0
FROM "workspace_assistant_skills" s
CROSS JOIN (VALUES ('grill'), ('gaps'), ('draft')) AS b(key)
WHERE NOT EXISTS (
  SELECT 1 FROM "workspace_assistant_skills" x
  WHERE x."workspace_id" = s."workspace_id" AND x."key" = b.key
);--> statement-breakpoint

WITH ordered AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "workspace_id"
      ORDER BY
        -- Built-ins first in code order, then everything else by the position
        -- it had, which is precisely how 0070 rendered them. `id` only breaks
        -- ties so the result is deterministic rather than left to the planner.
        CASE "key" WHEN 'grill' THEN 0 WHEN 'gaps' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
        "position",
        "id"
    ) - 1 AS pos
  FROM "workspace_assistant_skills"
)
UPDATE "workspace_assistant_skills" s
SET "position" = o.pos
FROM ordered o
WHERE o."id" = s."id";
