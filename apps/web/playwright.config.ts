import { defineConfig, devices } from "@playwright/test";

// Importing constants first sets the canonical E2E env on process.env so both
// this runner and the app server (webServer below) share DB + fixture paths.
import { BASE_URL, STORAGE_STATE } from "./e2e/helpers/constants";

export default defineConfig({
  testDir: "./e2e",
  // Serial: tests share one database and one GitHub fixture file, and each
  // test resets that state in beforeEach. Parallel workers would race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 30_000,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Assumes the app is already built (pnpm -w build). `next start` serves the
    // production build with the E2E seams enabled via SPECBOARDS_E2E.
    command: "pnpm exec next start -p 3100",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SPECBOARDS_E2E: "1",
      SPECBOARDS_BOOTSTRAP_TOKEN: process.env.SPECBOARDS_BOOTSTRAP_TOKEN!,
      DATABASE_URL: process.env.DATABASE_URL!,
      // The public portal reads through `getPortalDb()`, which returns null
      // when this is unset, so without it every portal URL 404s and the portal
      // specs cannot run at all. It points at the same database as everything
      // else here, which means the portal role's RLS policies are NOT what
      // gates these tests: this suite runs single-tenant on the owner
      // connection throughout (there is no DATABASE_URL_APP either), and the
      // portal is no exception.
      //
      // That is a real gap and it is covered elsewhere on purpose.
      // `portal-role-rls.int.test.ts` connects as the actual `specboards_portal`
      // role and asserts what it can and cannot see, which needs a provisioned
      // role and is integration work rather than end-to-end.
      //
      // What these specs cover instead is the half that lives in the
      // application: routing, the 404 for an unpublished portal, the absence of
      // the app's chrome, and session parity. Those hold on this connection
      // precisely because `resolvePortal` checks `portal_enabled` itself rather
      // than relying only on the policy, which is the reason that check exists.
      DATABASE_URL_PORTAL: process.env.DATABASE_URL!,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
      BETTER_AUTH_URL: BASE_URL,
      APP_URL: BASE_URL,
      SPECBOARDS_E2E_GITHUB_FIXTURE: process.env.SPECBOARDS_E2E_GITHUB_FIXTURE!,
      // Let the webhook e2e deliver to a loopback receiver (SSRF guard blocks
      // private targets by default). This only works because the suite runs
      // SINGLE-tenant: a multi-tenant deployment ignores the flag and refuses
      // to boot with it set, since tenants there supply the webhook URLs (see
      // lib/webhooks/ssrf.ts). Do not add SPECBOARDS_MULTI_TENANT here without
      // giving the webhook spec another way to reach its receiver.
      SPECBOARDS_WEBHOOK_ALLOW_PRIVATE: "1",
    },
  },
});
