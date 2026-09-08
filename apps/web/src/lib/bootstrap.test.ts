import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first-run gate.
 *
 * The property worth pinning is the one the card was written about: an
 * unclaimed instance does not hand workspace-owner rights to whoever reaches
 * the URL first. Everything here is a way of asking that, and the negative
 * cases matter more than the positive one, because a gate that admits nobody
 * is a support ticket while a gate that admits anybody is the bug.
 */

let userRows: unknown[] = [];
let secretRows: { tokenHash: string }[] = [];
let insertConflicts = false;
const inserted: { tokenHash: string }[] = [];

vi.mock("@specboards/db", () => ({
  bootstrapSecret: { singleton: "singleton", id: "id", tokenHash: "token_hash" },
  users: {},
  repositories: {},
  eq: () => ({}),
  sql: Object.assign(
    (strings: TemplateStringsArray) => ({ strings }),
    { raw: () => ({}) },
  ),
}));

const db = {
  select: () => ({
    from: (table: unknown) => ({
      limit: async () => (table === "secret" ? secretRows : userRows),
      where: () => ({ limit: async () => userRows }),
    }),
  }),
  insert: () => ({
    values: (v: { tokenHash: string }) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          if (insertConflicts) return [];
          inserted.push(v);
          return [{ id: "row" }];
        },
      }),
    }),
  }),
};

const ENV = ["SPECBOARDS_BOOTSTRAP_TOKEN", "SPECBOARDS_SIGNUP_CODE"] as const;
const saved: Record<string, string | undefined> = {};

describe("the first-run gate", () => {
  beforeEach(async () => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    userRows = [];
    secretRows = [];
    insertConflicts = false;
    inserted.length = 0;
    vi.resetModules();
    const { resetFirstRunCache } = await import("@/lib/first-run");
    resetFirstRunCache();
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function mod() {
    return import("@/lib/bootstrap");
  }

  /** The select-from-secret shape the module uses. */
  function withSecret(hash: string) {
    secretRows = [{ tokenHash: hash }];
    return {
      ...db,
      select: () => ({
        from: () => ({ limit: async () => secretRows }),
      }),
    };
  }

  describe("when it applies", () => {
    it("applies while the deployment has no accounts", async () => {
      const { bootstrapRequired } = await mod();
      expect(await bootstrapRequired(db as never)).toBe(true);
    });

    it("stops applying once anybody has signed up", async () => {
      userRows = [{ one: 1 }];
      const { bootstrapRequired } = await mod();
      // This is what keeps the hosted deployments out of it entirely: they
      // have accounts, so the gate is inert without anybody setting a flag.
      expect(await bootstrapRequired(db as never)).toBe(false);
    });
  });

  describe("matching", () => {
    it("admits the configured token", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "operator-chose-this";
      const { bootstrapSecretMatches } = await mod();
      expect(
        await bootstrapSecretMatches(db as never, "operator-chose-this"),
      ).toBe(true);
    });

    it("falls back to the sign-up code when no dedicated token is set", async () => {
      // A deployment that has already chosen a secret for this purpose should
      // not have to choose a second one to get through the first screen.
      process.env.SPECBOARDS_SIGNUP_CODE = "SPECBUILDER2026";
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(db as never, "SPECBUILDER2026")).toBe(
        true,
      );
    });

    it("prefers the dedicated token when both are set", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "dedicated";
      process.env.SPECBOARDS_SIGNUP_CODE = "signup";
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(db as never, "dedicated")).toBe(true);
      expect(await bootstrapSecretMatches(db as never, "signup")).toBe(false);
    });

    it("refuses a wrong token", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "right";
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(db as never, "wrong")).toBe(false);
    });

    it("refuses an empty submission", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "right";
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(db as never, "")).toBe(false);
      expect(await bootstrapSecretMatches(db as never, "   ")).toBe(false);
    });

    it("admits a generated token by its stored hash", async () => {
      const token = "generated-value";
      const hash = createHash("sha256").update(token, "utf8").digest("hex");
      const { bootstrapSecretMatches } = await mod();
      expect(
        await bootstrapSecretMatches(withSecret(hash) as never, token),
      ).toBe(true);
    });

    it("admits nobody when there is no secret anywhere", async () => {
      // The fail-closed case. With nothing to match, nothing passes: an
      // instance whose token row is missing is unclaimable rather than open.
      const empty = {
        ...db,
        select: () => ({ from: () => ({ limit: async () => [] }) }),
      };
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(empty as never, "anything")).toBe(
        false,
      );
      expect(await bootstrapSecretMatches(empty as never, "")).toBe(false);
    });

    it("is not fooled by a token that only shares a prefix", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "abcdef123456";
      const { bootstrapSecretMatches } = await mod();
      expect(await bootstrapSecretMatches(db as never, "abcdef")).toBe(false);
      expect(await bootstrapSecretMatches(db as never, "abcdef1234567")).toBe(
        false,
      );
    });
  });

  describe("generating one", () => {
    it("does nothing when the deployment already has accounts", async () => {
      userRows = [{ one: 1 }];
      const { ensureBootstrapSecret } = await mod();
      expect(await ensureBootstrapSecret(db as never)).toEqual({
        state: "not-needed",
      });
      expect(inserted).toHaveLength(0);
    });

    it("does nothing when the operator configured one", async () => {
      process.env.SPECBOARDS_BOOTSTRAP_TOKEN = "mine";
      const { ensureBootstrapSecret } = await mod();
      expect(await ensureBootstrapSecret(db as never)).toEqual({
        state: "configured",
        source: "env",
      });
      expect(inserted).toHaveLength(0);
    });

    it("generates and stores only a hash", async () => {
      const { ensureBootstrapSecret } = await mod();
      const result = await ensureBootstrapSecret(db as never);
      expect(result.state).toBe("generated");
      const token = (result as { token: string }).token;
      expect(token.length).toBeGreaterThan(20);
      // The token is shown once and never recoverable, so a database dump does
      // not hand somebody an unclaimed instance.
      expect(inserted[0]!.tokenHash).toBe(
        createHash("sha256").update(token, "utf8").digest("hex"),
      );
      expect(inserted[0]!.tokenHash).not.toContain(token);
    });

    it("does not print a token it failed to store", async () => {
      // Two instances booting against one fresh database: the singleton column
      // makes one insert win, and the loser must say so rather than hand the
      // operator a secret the database has never seen.
      insertConflicts = true;
      const { ensureBootstrapSecret } = await mod();
      expect(await ensureBootstrapSecret(db as never)).toEqual({
        state: "already-generated",
      });
    });
  });
});
