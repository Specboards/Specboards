-- Per-repository write mode override.
--
-- How a spec edit made in the app reaches git (a pull request, or a commit
-- straight onto the default branch) is declared in the repo's own
-- .specboards/config.yml. That is the right home for it: the setting travels
-- with the code and is reviewed like anything else in the repo.
--
-- It is also, for some customers, unreachable. A Specboard admin connecting a
-- repository they do not own cannot commit to `.specboards/config.yml`, and
-- telling them to open a pull request in order to change how pull requests get
-- made is a poor answer on the first day. This column is the escape hatch: an
-- admin-set value that wins over the repo config.
--
-- NULL means "no override", which is the state every existing repository is
-- correctly in, so this migration changes no repo's behaviour. The check
-- constraint keeps the column to the two values the resolver understands
-- rather than trusting every future write path to get it right.

ALTER TABLE "repositories" ADD COLUMN "write_mode_override" text;--> statement-breakpoint

ALTER TABLE "repositories" ADD CONSTRAINT "repositories_write_mode_override_check"
  CHECK ("write_mode_override" IS NULL OR "write_mode_override" IN ('pr', 'direct'));
