-- Process each GitHub webhook delivery once.
--
-- The handler verifies the HMAC over the raw body but has never recorded which
-- deliveries it already handled: `x-github-delivery` was read only for logging.
-- So a valid, signed delivery could be replayed - captured in transit, or
-- re-sent from GitHub's own redelivery UI - and the sync path would run again.
-- GitHub also retries on its own, so duplicate processing is not purely
-- adversarial.
--
-- Impact was bounded because ingestion is largely convergent (re-syncing the
-- same commits mostly lands in the same place), which is why this sat in the
-- backlog rather than with the P0s. "Largely" is doing work in that sentence
-- though: the pull_request path raises notifications, and a replayed delivery
-- means the author is told twice about the same merge.
--
-- Deliberately NOT the `webhook_deliveries` table, which records our OUTBOUND
-- deliveries to customer endpoints. Same word, opposite direction; sharing it
-- would confuse both.
--
-- No workspace_id and no RLS: a delivery id is a GitHub-side identifier for the
-- whole deployment, carries no tenant data, and is looked up before the payload
-- has been parsed into anything workspace-shaped. `github_app` is precedent for
-- a deployment-singleton table without RLS.
CREATE TABLE IF NOT EXISTS "github_webhook_deliveries" (
  "delivery_id" text PRIMARY KEY,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Pruning scans by age, and the table is otherwise only ever hit by primary key.
CREATE INDEX IF NOT EXISTS "github_webhook_deliveries_received_at_idx"
  ON "github_webhook_deliveries" ("received_at");

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
    -- Same reasoning as 0056 and 0058 for granting here as well as in
    -- infra/worker-role.sql: that file stays the readable source of truth for
    -- the worker's surface, and repeating it means a deploy cannot leave the
    -- webhook sink unable to write. This one matters more than most - the
    -- insert IS the dedup check, so a missing grant would fail every delivery
    -- rather than merely lose a row.
    GRANT SELECT, INSERT, DELETE ON "github_webhook_deliveries" TO specboards_worker;

    -- The sink spans every workspace and runs with no `app.user_id`. A
    -- role-targeted policy is only evaluated when the connected role IS
    -- specboards_worker, so this loosens nothing for specboards_app. Included
    -- for parity with the other worker tables even though this one has no RLS
    -- enabled, so that enabling RLS later cannot silently lock the sink out.
    DROP POLICY IF EXISTS github_webhook_deliveries_worker_all ON "github_webhook_deliveries";
  END IF;
END $$;
