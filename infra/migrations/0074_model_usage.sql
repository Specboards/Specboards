-- What Specboards has spent at the customer's model provider, and the caps that
-- stop it spending more.
--
-- The arrangement this exists for: the customer brings their own endpoint and
-- their own key, so every token the assistant produces is billed to them by a
-- vendor we have no relationship with. That is the deal they agreed to, and it
-- still goes badly for us if the first they hear of it is a line on a provider
-- invoice they cannot attribute. Two tables, because they answer two different
-- questions: what happened (`model_usage_events`) and what is allowed
-- (`workspace_usage_limits`).
--
-- ── Why a ledger and not counters ───────────────────────────────────────────
-- The obvious cheap shape is a running total per workspace per month, updated
-- in place. It is deliberately not done. The question that actually gets asked
-- is "what is this charge on my bill", and a counter cannot answer it: it
-- cannot say which feature, which person, or which day. It also cannot be
-- recomputed once it drifts, and it will drift, because the writes happen on a
-- best-effort path beside a streaming response. A row per call is recomputable
-- from first principles for ever, which is the property that makes this a
-- defence rather than a dashboard.
--
-- Volume is not a concern at the scale this shape is for: one row per assistant
-- turn is orders of magnitude below `item_events`, which is already per edit.
-- If it ever is, a rollup table is additive and derivable from these rows,
-- which is the direction that stays available.
--
-- ── Why `assistant_messages` is not enough ──────────────────────────────────
-- 0068 already records prompt/completion tokens on the assistant turn, and its
-- own note says accounting would aggregate those rather than reimplement them.
-- That turned out to be half true. Those rows cover the assistant panel and
-- nothing else: a breakdown persists no message (by design, see
-- `breakdown-service.ts`), a connection test persists nothing at all, and a
-- cancelled turn is deliberately not written. Aggregating only what happened to
-- leave a message behind would under-report the bill, which is the one error
-- this feature must not make. So every call through
-- `model-provider-service.ts` writes here, whatever it was for and however it
-- ended, and the columns on `assistant_messages` stay what they are: what that
-- turn cost, beside the turn.

CREATE TABLE "model_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- Who the call was made on behalf of. A snapshot with no FK, matching
  -- `assistant_messages.author_id` and `notifications.actor_id`: deactivating
  -- somebody must not rewrite the record of what was spent in their name, which
  -- is exactly the record a billing dispute turns on.
  "user_id" uuid NOT NULL,
  -- What triggered the call: 'assistant_turn', 'breakdown', 'connection_test'.
  -- Deliberately unconstrained text rather than a CHECK. The vocabulary lives
  -- in `lib/usage-service.ts`, and the alternative is that adding a call site
  -- needs a migration, which is the kind of friction that ends with somebody
  -- reusing an existing label and quietly corrupting the attribution.
  "feature" text NOT NULL,
  -- What the endpoint said answered, which is not always what was asked for.
  -- NULL when the call failed before anything answered.
  "model" text,
  -- As reported by the endpoint. NULL means it reported nothing, which is not
  -- zero: several runtimes omit usage entirely, and a streamed answer that was
  -- cancelled never reaches the chunk that carries it. Summing these must treat
  -- NULL as unknown rather than free, so the UI reports how many calls went
  -- unmeasured instead of implying the total is complete.
  "prompt_tokens" integer,
  "completion_tokens" integer,
  -- How it ended. 'cancelled' is its own outcome rather than an error because
  -- the tokens produced before the stop are still billed by the provider, and a
  -- ledger that filed them as a failure would be describing a charge the
  -- customer can see as one that never happened.
  "outcome" text NOT NULL,
  -- The adapter's `ModelErrorKind` when `outcome` is 'error', so "your key is
  -- wrong" stays distinguishable from "the endpoint was down" months later.
  "error_kind" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_usage_events_outcome_check"
    CHECK ("outcome" IN ('ok', 'error', 'cancelled')),
  -- Tokens are counts. A negative one means something upstream is being parsed
  -- wrongly, and it should fail loudly here rather than silently reduce a total
  -- that somebody is about to be shown as a bill.
  CONSTRAINT "model_usage_events_tokens_check"
    CHECK (
      ("prompt_tokens" IS NULL OR "prompt_tokens" >= 0)
      AND ("completion_tokens" IS NULL OR "completion_tokens" >= 0)
    )
);--> statement-breakpoint

-- Every aggregate read is "this workspace, this period", so the index carries
-- the period as well as the tenant.
CREATE INDEX "model_usage_events_ws_time_idx"
  ON "model_usage_events" ("workspace_id", "created_at");--> statement-breakpoint

-- The per-user cap is checked on every call before anything is spent, so its
-- lookup ("this person, today") gets its own index rather than filtering the
-- one above.
CREATE INDEX "model_usage_events_ws_user_time_idx"
  ON "model_usage_events" ("workspace_id", "user_id", "created_at");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- The caps.
--
-- ── Why not columns on `model_providers` ────────────────────────────────────
-- There is exactly one provider row per workspace, so a cap column there would
-- be a true 1:1 and one fewer table. It is deliberately not done, for one
-- reason: `deleteModelProvider` drops the row, so swapping endpoints or
-- rotating a connection would silently take the spend guardrail with it. A
-- guardrail that disappears when somebody reconfigures the thing it guards is
-- worse than no guardrail, because nobody is told it has gone.
--
-- ── Why null means uncapped ─────────────────────────────────────────────────
-- Not zero, which is a real and different instruction ("stop entirely"). A
-- workspace that has never opened this page has no row at all, and no row means
-- no cap: the product must not start refusing to work because a feature was
-- deployed.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "workspace_usage_limits" (
  -- The workspace is the identity: one policy per tenant, so resolution is a
  -- primary key lookup and no code has to pick a winner between two rows.
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- Total tokens (prompt + completion) this workspace may spend through
  -- Specboards in a calendar month. NULL is uncapped.
  "monthly_token_cap" integer,
  -- Tokens one person may spend in a day. NULL is uncapped. Present because the
  -- failure a monthly cap does not catch is one person's runaway loop eating
  -- the whole team's month in an afternoon.
  "daily_user_token_cap" integer,
  -- Who last changed it. A cap being raised right before a large bill is a
  -- thing somebody will want to look up.
  "updated_by" uuid,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_usage_limits_monthly_check"
    CHECK ("monthly_token_cap" IS NULL OR "monthly_token_cap" >= 0),
  CONSTRAINT "workspace_usage_limits_daily_check"
    CHECK ("daily_user_token_cap" IS NULL OR "daily_user_token_cap" >= 0)
);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS.
--
-- Both tables read at member level. That is a deliberate choice and not the
-- cautious one: the alternative is owner-only, matching `model_providers`
-- writes. But the cap check runs inside an ordinary member's request, before
-- their question is sent, and it has to read both the limits row and the
-- period's totals to do it. Owner-only reads would mean either a privilege
-- escalation in the service or a cap that cannot be enforced. Neither is worth
-- hiding an aggregate token count from the people generating it, who can see
-- every answer it paid for anyway.
--
-- The per-person breakdown is a different matter, and it is gated in the route
-- rather than here: "how much did each colleague spend" is management
-- information, and `/api/v1/model-provider/usage` is org-admin only.
--
-- Writes: usage events are member-INSERT (any member's question writes one) and
-- have no UPDATE or DELETE policy at all, so the ledger is append-only to the
-- app. Limits are org-admin, like every other setting that decides what the
-- product may spend.
--
-- ── Enforced since 0078 ────────────────────────────────────────────────────
-- Until then `usage-service.ts` ran on the owner connection, which RLS exempts,
-- so all of the above was a description of intent. In particular the
-- append-only property was a property of the policies and not of the running
-- system: on the owner connection an UPDATE or DELETE against the ledger would
-- have succeeded, and what actually held was that no code issued one. The
-- service now runs as `specboards_app`, where the missing UPDATE and DELETE
-- policies and the withheld grant below both bite.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "model_usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_usage_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY model_usage_events_read ON "model_usage_events"
  FOR SELECT USING (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY model_usage_events_append ON "model_usage_events"
  FOR INSERT WITH CHECK (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_usage_limits_read ON "workspace_usage_limits"
  FOR SELECT USING (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_usage_limits_write ON "workspace_usage_limits"
  FOR ALL USING (specboards_is_org_admin("workspace_id"))
  WITH CHECK (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

-- Table privileges for the app connection. `infra/rls-role.sql` sets ALTER
-- DEFAULT PRIVILEGES so new tables are reachable automatically, but the live
-- test and prod clusters predate that script and use a `writer` group role with
-- per-table grants instead: without this the tables are invisible to
-- specboards_app on exactly the two databases that matter. Same guarded shape
-- as 0067 and 0068; see the note in 0067 for what the failure looks like.
--
-- SELECT and INSERT only on the ledger, deliberately. RLS already withholds
-- UPDATE and DELETE by having no policy for them, and withholding the privilege
-- too means the append-only property survives somebody later adding a policy
-- without thinking about it.
--
-- Not granted to specboards_worker, for the reason 0067 and 0068 withheld the
-- model tables: no background job calls a model, so none has a reason to read
-- what a customer spent doing it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT ON "model_usage_events" TO writer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_usage_limits" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT ON "model_usage_events" TO specboards_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_usage_limits" TO specboards_app;
  END IF;
END $$;
