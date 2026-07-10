import postgres from "postgres";

/**
 * Deploy-time verification that the tenant-data connection actually gets
 * row-level security. RLS silently stops applying when the connected role is
 * a superuser, has BYPASSRLS, or owns the tables, so "the policies exist" is
 * not the same as "the policies are enforced". The web app probes its
 * `DATABASE_URL_APP` connection at boot and refuses to start a hosted
 * deployment whose tenant connection would bypass RLS.
 */

/** What the tenant connection looks like from inside Postgres. */
export interface TenantConnectionProbe {
  /** The role the connection authenticates as. */
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** True when the role is (or inherits) the owner of the probed table. */
  ownsTenantTable: boolean;
  /** Owner of the probed table, for error messages. */
  tableOwner: string;
  /** `relrowsecurity` on the probed table. */
  rlsEnabled: boolean;
  /** Number of policies on the probed table. */
  policyCount: number;
  /** The table the checks ran against. */
  table: string;
}

/**
 * Inspect `connectionString` from the database's point of view, using
 * `table` (a canonical RLS-protected tenant table) as the reference object.
 * Opens a single throwaway connection and closes it before returning.
 */
export async function probeTenantConnection(
  connectionString: string,
  table = "features",
): Promise<TenantConnectionProbe> {
  const sql = postgres(connectionString, { prepare: false, max: 1 });
  try {
    const [role] = await sql`
      select
        current_user as role,
        (select rolsuper from pg_roles where rolname = current_user) as superuser,
        (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls
    `;
    const [tbl] = await sql`
      select
        relrowsecurity as rls_enabled,
        pg_has_role(current_user, relowner, 'usage') as owns_table,
        relowner::regrole::text as table_owner
      from pg_class
      where oid = ${`public.${table}`}::regclass
    `;
    const [pol] = await sql`
      select count(*)::int as n
      from pg_policies
      where schemaname = 'public' and tablename = ${table}
    `;
    if (!role || !tbl || !pol) {
      throw new Error(`RLS probe returned no rows for table "${table}".`);
    }
    return {
      role: String(role.role),
      superuser: Boolean(role.superuser),
      bypassRls: Boolean(role.bypass_rls),
      ownsTenantTable: Boolean(tbl.owns_table),
      tableOwner: String(tbl.table_owner),
      rlsEnabled: Boolean(tbl.rls_enabled),
      policyCount: Number(pol.n),
      table,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The ways a probed connection would escape RLS, as human-readable findings.
 * Empty means the connection is safe to serve tenant data.
 */
export function tenantIsolationViolations(probe: TenantConnectionProbe): string[] {
  const violations: string[] = [];
  if (probe.superuser) {
    violations.push(`role "${probe.role}" is a superuser`);
  }
  if (probe.bypassRls) {
    violations.push(`role "${probe.role}" has BYPASSRLS`);
  }
  if (probe.ownsTenantTable) {
    violations.push(
      `role "${probe.role}" is or inherits "${probe.tableOwner}", the owner of "${probe.table}" (owners bypass RLS)`,
    );
  }
  if (!probe.rlsEnabled) {
    violations.push(`row-level security is not enabled on "${probe.table}"`);
  }
  if (probe.policyCount === 0) {
    violations.push(`"${probe.table}" has no RLS policies (non-owners would see nothing)`);
  }
  return violations;
}
