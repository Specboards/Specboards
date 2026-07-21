ALTER TABLE "releases" ADD COLUMN "shipped_date" text;--> statement-breakpoint
-- Backfill: releases already marked shipped predate this column. Their actual
-- ship date wasn't captured structurally (it lived in free-form notes), so seed
-- shipped_date from the planned target_date as the best available signal. This
-- gives the newest-shipped-first ordering real data to sort on; editors can
-- reopen/re-ship to correct any that shipped off-target.
UPDATE "releases" SET "shipped_date" = "target_date"
  WHERE "status" = 'shipped' AND "shipped_date" IS NULL;
