-- Let a member's request use the workspace's model key without being able to
-- read it.
--
-- Context, and why this function has to exist before anything else can move.
-- The model-provider, usage, assistant and skills paths run on the owner
-- connection (`getDb()`), where row-level security does not apply at all: an
-- owner is exempt unless the table sets FORCE ROW LEVEL SECURITY, and nothing
-- does. Moving them onto `specboards_app`, the role the policies are written
-- for, is the point of this change.
--
-- One read does not survive that move as it stands. `resolveConfig` in
-- `model-provider-service.ts` reads `model_provider_credentials.secret` inside
-- an ORDINARY MEMBER's assistant request, and `model_provider_credentials_admin`
-- (0067) is org-admin only, including for SELECT. Measured against a migrated
-- database:
--
--     acting as a member, on specboards_app   ->  0 rows
--     acting as an org admin, on specboards_app -> 1 row
--     on the owner connection                 ->  1 row
--
-- The calling code reads `cred ? decryptSecret(cred.secret) : null`, so zero
-- rows is not an error. The key would silently resolve to null and every
-- non-admin's assistant call would fail against a keyed endpoint with nothing
-- in the response to explain it. `owner-connection-rls.int.test.ts` pins that.
--
-- ── Why a function rather than widening the policy ──────────────────────────
-- Widening `model_provider_credentials_admin` to members would be one line and
-- would give every member SELECT on every credential column for ever, which is
-- exactly the separation 0067 split the table in two to get. The distinction
-- worth keeping is between USING the key and READING it: a member's question
-- may spend the workspace's credit at the endpoint, and may not come back with
-- the secret in a response body.
--
-- A SECURITY DEFINER function draws that line. It runs as its owner, so it sees
-- the row, and it answers exactly one question ("the secret for this
-- credential, if it belongs to this workspace and you are a member of it")
-- rather than handing out a table.
--
-- ── What it is not ─────────────────────────────────────────────────────────
-- Not a way to read a key out of Specboards. What comes back is the stored
-- ciphertext; decryption happens in the application with a key held in the
-- environment and never in the database. Someone who could call this function
-- directly would hold an encrypted blob, which is the same thing an owner
-- connection has always been able to fetch.
--
-- `SET search_path` is pinned, which is the standard requirement for a SECURITY
-- DEFINER function: without it a caller who can create objects could shadow
-- `specboards_is_member` or the table and have this function run their version
-- with the owner's rights.

CREATE OR REPLACE FUNCTION specboards_resolve_provider_credential(
  p_workspace_id uuid,
  p_credential_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.secret
  FROM model_provider_credentials c
  WHERE c.id = p_credential_id
    AND c.workspace_id = p_workspace_id
    -- The membership check is inside the function, not left to the caller.
    -- A SECURITY DEFINER function that trusted its arguments would be a way to
    -- read any workspace's credential by guessing two uuids.
    AND specboards_is_member(p_workspace_id);
$$;--> statement-breakpoint

-- REVOKE from PUBLIC first: a new function is executable by everyone by
-- default, which for a SECURITY DEFINER function means every role on the
-- cluster. Granted back to exactly the roles that need it.
REVOKE ALL ON FUNCTION specboards_resolve_provider_credential(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT EXECUTE ON FUNCTION specboards_resolve_provider_credential(uuid, uuid)
      TO specboards_app;
  END IF;
  -- Deliberately NOT granted to specboards_worker. No background job calls a
  -- model, so none has a reason to resolve the key that would pay for it. Same
  -- reasoning as 0067's withheld table grant.
END $$;
