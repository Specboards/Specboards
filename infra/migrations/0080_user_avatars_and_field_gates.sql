-- Two unrelated-looking changes that ship together because they are the same
-- round of Settings work: uploaded profile pictures, and stage gates that can
-- require a field to be populated rather than a box to be ticked.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1. Uploaded profile pictures.
--
-- `users.image` has always been a URL, which meant the only way to have an
-- avatar was to host the file somewhere else first. That is not a thing most
-- people can do, so in practice nobody had one. This stores the bytes.
--
-- ── Why bytea and not object storage ────────────────────────────────────────
-- The obvious answer is S3 or a Tigris bucket, and it is the right answer at a
-- size this will not reach. An avatar is capped at 512x512 and 256 KB (the
-- browser downsamples before it uploads, see `avatar-picker.tsx`), one row per
-- person, and a workspace is tens of people. That is single-digit megabytes for
-- a whole tenant, against the cost of a second storage system with its own
-- credentials, lifecycle, backup story and failure mode. Postgres already has
-- all four. If avatars ever grow into attachments this table is the thing that
-- gets replaced, and `users.image` still holds a URL either way, so the
-- migration path out is a backfill and a URL rewrite rather than a schema
-- change everywhere that renders a face.
--
-- ── Why its own table and not a column on `users` ───────────────────────────
-- `users` is read on nearly every request that names a person (assignee
-- display, member rosters, comment authors) and Postgres would keep the bytea
-- out of line in TOAST anyway, but a SELECT * on a hot table that carries an
-- image column is a foot-gun waiting for someone to write one. Splitting it
-- means the bytes are only read by the one route that serves them.
--
-- ── Why no RLS ──────────────────────────────────────────────────────────────
-- Consistent with `users`, `sessions` and `accounts`, which carry none: these
-- are not tenant-scoped rows and there is no workspace for a policy to key on.
-- The identity that owns an avatar is a user, not a member, and the same person
-- has one face across every workspace they belong to. Authorization is in the
-- route instead: writes require a session and can only touch that session's own
-- user id, and reads require a session at all (an avatar is not public).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "user_avatars" (
  -- The user IS the identity here: one avatar per person, so serving one is a
  -- primary key lookup and nothing has to pick a winner between two rows.
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  -- Narrow by CHECK rather than by convention. This value is echoed back as a
  -- Content-Type header, so an unconstrained column is a stored-XSS primitive:
  -- a row saying "text/html" would have the browser render the bytes as a
  -- document on our own origin. The route validates too; this is the backstop
  -- that survives the next route.
  "mime_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  -- Denormalized so `Content-Length` and the quota check never have to read the
  -- blob itself.
  "byte_size" integer NOT NULL,
  -- Cache-busts the img src. `users.image` points at
  -- /api/avatars/<user_id>?v=<epoch millis of this>, so replacing a picture
  -- changes the URL and no stale copy survives in a browser cache or a CDN.
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_avatars_mime_check"
    CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/webp')),
  -- 256 KB. Matches the route's limit; a row past it means something bypassed
  -- the route, which should fail loudly rather than quietly cost us storage.
  CONSTRAINT "user_avatars_size_check"
    CHECK ("byte_size" > 0 AND "byte_size" <= 262144)
);--> statement-breakpoint

-- Table privileges for the app connection, for the reason spelled out in 0074:
-- the live test and prod clusters predate `infra/rls-role.sql` and use a
-- `writer` group role with per-table grants, so a new table is invisible to
-- specboards_app there without this. Guarded so a fresh database (where neither
-- role exists yet) still migrates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_avatars" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_avatars" TO specboards_app;
  END IF;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Stage gates that require a field.
--
-- A gate has been a checklist item somebody ticks by hand. That answers "did we
-- do the thing" but not "is the data actually there", and the second is what
-- most exit criteria really mean: an admin who writes "Target End Date is set"
-- as a checklist item is asking for a field check and getting a promise. A
-- ticked box is also permanently satisfied, so the item can advance and then
-- have the value cleared out from under it.
--
-- ── Why a kind column and not a second table ────────────────────────────────
-- The two kinds are the same thing to almost everything that touches them: both
-- attach to a stage, both order within it, both block the same forward move,
-- both render in the same checklist on the item, and both are edited in the same
-- admin panel. A second table would fork every one of those and force a union
-- in the one query that matters. What differs is only how a gate decides it is
-- satisfied, which is a branch in the enforcement helper.
--
-- ── Why `field_key` is unconstrained text ───────────────────────────────────
-- It names either a built-in field ('assignee', 'release', 'cycle', 'parent',
-- 'tags') or a custom property by key, prefixed 'cf:'. No FK to
-- `workspace_properties`, deliberately: deleting a property must not silently
-- delete an admin's exit criterion, because the resulting state (a stage that
-- quietly stopped enforcing something) is invisible. A gate pointing at a
-- property that no longer exists resolves as unsatisfiable and says so on the
-- item, which is a state somebody can see and fix.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspace_stage_gates"
  ADD COLUMN "kind" text DEFAULT 'checklist' NOT NULL;--> statement-breakpoint

ALTER TABLE "workspace_stage_gates"
  ADD COLUMN "field_key" text;--> statement-breakpoint

ALTER TABLE "workspace_stage_gates"
  ADD CONSTRAINT "workspace_stage_gates_kind_check"
  CHECK ("kind" IN ('checklist', 'field'));--> statement-breakpoint

-- A field gate without a field is not a gate, and a checklist gate with one is a
-- sign the writer branched wrongly. Both should fail at the write rather than
-- resolve to "always satisfied" at the read, which is the failure mode that
-- makes a guardrail disappear without telling anyone.
ALTER TABLE "workspace_stage_gates"
  ADD CONSTRAINT "workspace_stage_gates_field_key_check"
  CHECK (
    ("kind" = 'field' AND "field_key" IS NOT NULL AND "field_key" <> '')
    OR ("kind" = 'checklist' AND "field_key" IS NULL)
  );
