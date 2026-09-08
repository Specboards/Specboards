import { resolve } from "node:path";

/**
 * Canonical E2E environment. Setting these on `process.env` here (imported first
 * by playwright.config.ts) guarantees the Playwright test-runner process and the
 * app server process it spawns agree on the same database and GitHub fixture
 * file. All values are overridable from the outer environment (CI sets its own).
 */
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/specboard_e2e";
process.env.BETTER_AUTH_SECRET ??= "e2e-only-better-auth-secret-0123456789abcdef";
process.env.SPECBOARDS_E2E_GITHUB_FIXTURE ??= resolve(process.cwd(), "e2e/.tmp/github.json");
process.env.SPECBOARDS_E2E ??= "1";
// The E2E database starts empty, so global setup's first sign-up meets the
// first-run gate. Configuring a token rather than exempting the suite means
// the gate is exercised on every run instead of only in unit tests.
process.env.SPECBOARDS_BOOTSTRAP_TOKEN ??= "e2e-first-run-token";

/** Where the app server listens during E2E (distinct from `next dev` on 3000). */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

/** Saved authenticated browser state produced by global setup, reused by tests. */
export const STORAGE_STATE = resolve(process.cwd(), "e2e/.tmp/state.json");

/** The admin account global setup creates (first user => workspace admin). */
export const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@example.com",
  password: "e2e-Password-123!",
};

/** Organization name global setup provisions; its slug drives page routes. */
export const ORG_NAME = "E2E Org";
