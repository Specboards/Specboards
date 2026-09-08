-- Let the notification fan-out see who may read a private product.
--
-- The fan-out resolves recipients from assignment and watching, subtracts the
-- actor, and keeps only active workspace members. It never asked whether the
-- recipient may read the item's PRODUCT, because it had no way to: the worker
-- role holds no grant on product_members, and the table carries RLS keyed on
-- the acting session rather than on a user passed in.
--
-- The cost of not asking was two different failures. In the app, the row was
-- written and then hidden, because the inbox query inner-joins `features` and
-- that carries `specboards_can_read_product`: a notification that exists, is
-- invisible, and raises nothing, because `fanOutNotifications` swallows its
-- own errors. By email it was worse, because email does not fail silently: the
-- person was sent a real message, with a deep link they get a 404 on, whose
-- body carried the title of work in a product they had deliberately not been
-- given access to.
--
-- SELECT only, and no write of any kind. The worker reads the roster to honour
-- it, exactly as it already does with `members`, and can no more edit who may
-- see a product than it can edit who belongs to a workspace.
--
-- The role-targeted policy matches every other table on the worker's surface
-- (see infra/worker-role.sql): the table's own policies are written for a
-- tenant session with `app.user_id` set, and the relay has no such session
-- because it is acting on behalf of an event rather than a person.
--
-- Granted here as well as in infra/worker-role.sql for the same reason as
-- migrations 0002 and 0003: that file is run by hand once per database, and
-- this makes an already-provisioned database correct the moment the migration
-- lands rather than the next time somebody remembers to re-run it.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT ON product_members TO specboards_worker;

        DROP POLICY IF EXISTS product_members_worker_all ON product_members;
        CREATE POLICY product_members_worker_all ON product_members
            FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
    END IF;
END $$;
