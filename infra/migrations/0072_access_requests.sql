-- Persist "Request access" submissions so the team has a queue instead of an
-- inbox.
--
-- Until now `POST /api/access-request` only sent two emails (the review inbox
-- and the requester's confirmation) and kept no record, so nothing tracked
-- which requests had been dealt with and the admin portal had nothing to show.
-- This table is what the portal lists, and what it marks when a team member
-- approves a request and the requester is emailed the sign-up code.
--
-- No `workspace_id`: a requester has no workspace yet, and this is
-- deployment-global data like `github_app` / `rate_limits`. Unlike those, RLS
-- is ENABLED with no policies. The table holds contact details for people who
-- are not customers, and with RLS on and no policy the tenant-scoped
-- `specboards_app` role can read nothing at all here, whatever a future query
-- does by mistake. The intake route runs on the owner connection, which
-- bypasses RLS, and the admin portal connects as `specboards_admin_ro`, which
-- is `bypassrls` by design.

CREATE TYPE "access_request_status" AS ENUM ('pending', 'approved', 'declined');--> statement-breakpoint

CREATE TABLE "access_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- Lowercased by the route before insert, like "invitations"."email".
  "email" text NOT NULL,
  "company" text NOT NULL,
  "team_size" text DEFAULT '' NOT NULL,
  "use_case" text NOT NULL,
  "status" "access_request_status" DEFAULT 'pending' NOT NULL,
  "decided_by" text,
  "decided_at" timestamptz,
  -- When the approval email actually left Postmark. Null on an approved row
  -- means the send failed and the requester never got their code.
  "code_sent_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "access_requests_status_idx" ON "access_requests" ("status");--> statement-breakpoint
CREATE INDEX "access_requests_created_at_idx" ON "access_requests" ("created_at");--> statement-breakpoint

-- One open request per address. A partial unique index rather than a plain one
-- so a person who was declined (or approved) can come back later, while a
-- repeat submission from someone already in the queue updates their existing
-- row (ON CONFLICT in the intake route) instead of queueing a duplicate.
CREATE UNIQUE INDEX "access_requests_pending_email_uq"
  ON "access_requests" ("email")
  WHERE "status" = 'pending';--> statement-breakpoint

-- Deny-all for every non-owner role: RLS on, no policies.
ALTER TABLE "access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Deliberately not granted to `writer` / `specboards_app`: nothing on the
-- tenant connection has any business reading or writing this table, and the RLS
-- deny-all above is belt-and-braces on top of that.
--
-- Saying nothing here turned out NOT to be enough. Both live clusters set
-- ALTER DEFAULT PRIVILEGES granting new tables to `writer` (infra/rls-role.sql
-- section 3), so this table was granted to it on creation anyway; 0073 revokes
-- that explicitly. Left as it ran rather than edited, because this migration
-- has already been applied.
--
-- The admin portal's role gets SELECT *and UPDATE*, and this is the one table
-- where it gets more than SELECT. Approving a request is a status flip plus an
-- email, both of which the portal does itself; routing that through an admin
-- API on this app would have meant a shared secret across two deployments for a
-- gate that retires with the pre-release beta. UPDATE only, on this table only:
-- the portal cannot insert or delete rows here, and stays SELECT-only on every
-- other table (`infra/product-read-role.sql` in the Admin-Portal repo is the
-- allowlist of record, re-run per cluster). Guarded on existence so this
-- migration is a no-op on clusters (self-host, local) that have no such role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_admin_ro') THEN
    GRANT SELECT, UPDATE ON "access_requests" TO specboards_admin_ro;
  END IF;
END $$;
