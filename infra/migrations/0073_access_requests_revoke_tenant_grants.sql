-- Take the tenant connection's privileges back off `access_requests`.
--
-- 0072 said the table was "deliberately NOT granted to writer / specboards_app"
-- and that was wrong on the clusters that matter. Both live databases carry
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
-- TO writer` (see infra/rls-role.sql section 3), so every table the migration
-- owner creates is granted to `writer` the moment it exists, whatever the
-- migration does or does not say. Confirmed on specboard-test-db after 0072
-- deployed: `writer` held all four.
--
-- Nothing leaked. `access_requests` has RLS enabled with no policies, and
-- `specboards_app` is a non-owner without bypassrls, so every row was invisible
-- to it regardless of the grant. This is the second layer, not the first: the
-- point of granting nothing was that a future migration adding a policy to this
-- table (or a role gaining bypassrls) should not silently hand the tenant
-- connection full DML over contact details for people who are not customers.
--
-- Revoked rather than "fixed" in 0072 because 0072 has already run on test, and
-- an applied migration is history. Guarded on role existence so this is a no-op
-- on self-host and local clusters that have neither role.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    REVOKE ALL ON "access_requests" FROM writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    REVOKE ALL ON "access_requests" FROM specboards_app;
  END IF;
END $$;
