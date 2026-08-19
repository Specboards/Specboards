import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The model connection against a real database: what gets stored, what comes
 * back, and what happens to the old key when one is rotated.
 *
 * The cases worth pinning down are all about the credential. It is the first
 * secret in this product that spends the customer's money at a vendor we have
 * no relationship with, and the ways it can go wrong are quiet ones: a key
 * echoed back to the browser, a rotation that leaves the old one readable, or a
 * disconnect that drops the provider row and orphans the secret it pointed at.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
// Single-tenant with the escape hatch on, so a loopback endpoint is a legal
// target here. This is the on-prem configuration, and it is the only way the
// self-hosted path can be exercised at all: both of our own deployments are
// multi-tenant, where the policy refuses a private address by design.
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `model-${suffix}` };
const ownerId = randomUUID();

/**
 * Whose spend a call is recorded against. Required on every inference entry
 * point, so these tests carry one too; what it does with it is
 * `usage.int.test.ts`'s subject, not this file's.
 */
const ATTRIBUTION = { userId: ownerId, feature: "connection_test" } as const;

describe.skipIf(!DB_URL)("model provider connection", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./model-provider-service");
  let decryptSecret: (blob: string) => string;

  /** Credential rows for this workspace, straight from the table. */
  async function credentialRows(): Promise<{ id: string; secret: string; hint: string }[]> {
    return sql<{ id: string; secret: string; hint: string }[]>`
      select id, secret, hint from model_provider_credentials
      where workspace_id = ${workspace.id} order by created_at`;
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./model-provider-service");
    ({ decryptSecret } = await import("./crypto"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Model', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${ownerId}, 'Owner', ${`owner-${suffix}@model.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${ownerId}, 'owner')`;
  });

  beforeEach(async () => {
    await sql`delete from model_providers where workspace_id = ${workspace.id}`;
    await sql`delete from model_provider_credentials where workspace_id = ${workspace.id}`;
  });

  afterAll(async () => {
    await sql`delete from model_providers where workspace_id = ${workspace.id}`;
    await sql`delete from model_provider_credentials where workspace_id = ${workspace.id}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${ownerId}`;
    await sql.end({ timeout: 5 });
    delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
  });

  it("stores the key encrypted and returns only a hint", async () => {
    const view = await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-secret-value-a91c",
    });

    expect(view.credentialHint).toBe("a91c");
    // The view is what routes serialize, so this is the assertion that keeps
    // the key out of the browser.
    expect(JSON.stringify(view)).not.toContain("sk-secret-value");

    const [row] = await credentialRows();
    expect(row!.secret).not.toContain("sk-secret-value");
    expect(decryptSecret(row!.secret)).toBe("sk-secret-value-a91c");
  });

  it("keeps the stored key when a save omits it", async () => {
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-original-key-1111",
    });
    // Editing just the model name must not silently disconnect the workspace.
    const view = await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    expect(view.model).toBe("gpt-4o");
    expect(view.credentialHint).toBe("1111");
    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
  });

  it("rotates a key without ever leaving the workspace without one", async () => {
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-original-key-1111",
    });
    const view = await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-rotated-key-2222",
    });

    expect(view.credentialHint).toBe("2222");
    // Exactly one row survives: the old secret is gone, not merely unreferenced.
    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.secret)).toBe("sk-rotated-key-2222");
  });

  it("removes the key when asked, without removing the connection", async () => {
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.1",
      apiKey: "sk-not-needed-3333",
    });
    const view = await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.1",
      apiKey: null,
    });

    // A keyless local endpoint is a real configuration, not an error state.
    expect(view.credentialHint).toBeNull();
    expect(await credentialRows()).toHaveLength(0);
    expect((await svc.getModelProvider(db, workspace.id))?.model).toBe("llama3.1");
  });

  it("destroys the credential when the connection is removed", async () => {
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-doomed-key-4444",
    });

    expect(await svc.deleteModelProvider(db, workspace.id)).toBe(true);
    expect(await svc.getModelProvider(db, workspace.id)).toBeNull();
    // The FK is ON DELETE SET NULL, so a cascade would NOT have collected this.
    // Leaving it behind would keep a live key in the database with nothing
    // pointing at it and nothing in the UI able to show or revoke it.
    expect(await credentialRows()).toHaveLength(0);
  });

  it("reports a second delete as nothing to do", async () => {
    expect(await svc.deleteModelProvider(db, workspace.id)).toBe(false);
  });

  it("keeps one connection per workspace, replacing rather than adding", async () => {
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    await svc.saveModelProvider(db, workspace.id, {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
    });

    const rows = await sql`select id from model_providers
      where workspace_id = ${workspace.id}`;
    expect(rows).toHaveLength(1);
    expect((await svc.getModelProvider(db, workspace.id))?.baseUrl).toBe(
      "https://api.groq.com/openai/v1",
    );
  });

  it("refuses a URL the egress policy rejects, at save time", async () => {
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    try {
      // Rejected before anything is written, so the user finds out while they
      // are still on the form rather than at the first assistant turn.
      await expect(
        svc.saveModelProvider(db, workspace.id, {
          baseUrl: "http://169.254.169.254/v1",
          model: "gpt-4o-mini",
        }),
      ).rejects.toThrow(svc.ModelProviderInputError);
    } finally {
      delete process.env.SPECBOARDS_MULTI_TENANT;
    }
    expect(await svc.getModelProvider(db, workspace.id)).toBeNull();
  });

  it("requires a base URL and a model", async () => {
    await expect(
      svc.saveModelProvider(db, workspace.id, { baseUrl: "", model: "gpt-4o-mini" }),
    ).rejects.toThrow(/base URL is required/);
    await expect(
      svc.saveModelProvider(db, workspace.id, {
        baseUrl: "https://api.openai.com/v1",
        model: "  ",
      }),
    ).rejects.toThrow(/model name is required/);
  });

  it("says 'not configured' rather than failing when nothing is connected", async () => {
    const out = await svc.completeWithWorkspaceModel(db, workspace.id, {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 0,
    }, ATTRIBUTION);
    // A setup prompt, not an error to report: the distinction is what lets the
    // assistant offer to connect a model instead of showing a stack trace.
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.kind).toBe("not_configured");
  });

  /**
   * The tracer bullet itself: configuration in the database, through credential
   * decryption and the egress policy, out to a real endpoint over a real
   * socket, and back.
   *
   * The point is not the completion. It is that all five layers connect, since
   * the assistant epic is about to be built on the assumption that they do. The
   * endpoint here is a loopback HTTP server standing in for a self-hosted
   * runtime, which is the deployment the spec calls out as likeliest to reveal
   * a wrong assumption, and it is the half we can prove without a vendor key.
   */
  describe("end to end against a live endpoint", () => {
    let endpoint: Server | undefined;
    let endpointUrl = "";
    let seen: { auth: string | undefined; body: string; url: string } | null = null;

    beforeEach(async () => {
      seen = null;
      endpoint = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen = {
            auth: req.headers.authorization,
            body: Buffer.concat(chunks).toString("utf8"),
            url: req.url ?? "",
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          // Answers a model listing on any path ending in /models, so a probe
          // of a *different* base URL on this same server is still a working
          // endpoint. That is what makes the credential rule testable.
          res.end(
            (req.url ?? "").endsWith("/models")
              ? JSON.stringify({
                  object: "list",
                  data: [{ id: "local-llama" }, { id: "local-mistral" }],
                })
              : JSON.stringify({
                  model: "local-llama",
                  choices: [{ message: { role: "assistant", content: "ready" } }],
                  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
                }),
          );
        });
      });
      await new Promise<void>((r) => endpoint!.listen(0, "127.0.0.1", r));
      const { port } = endpoint!.address() as AddressInfo;
      endpointUrl = `http://127.0.0.1:${port}/v1`;
    });

    afterAll(() => {
      endpoint?.close();
    });

    it("completes a call using the stored, encrypted credential", async () => {
      await svc.saveModelProvider(db, workspace.id, {
        baseUrl: endpointUrl,
        model: "local-llama",
        apiKey: "sk-stored-key-9999",
      });

      const out = await svc.completeWithWorkspaceModel(db, workspace.id, {
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        maxTokens: 16,
      }, ATTRIBUTION);

      expect(out.ok).toBe(true);
      expect(out.ok && out.text).toBe("ready");
      expect(out.ok && out.usage.totalTokens).toBe(6);

      // The credential made the round trip: written encrypted, read back,
      // decrypted, and presented to the endpoint. This is the assertion that
      // proves storage and use actually agree.
      expect(seen!.auth).toBe("Bearer sk-stored-key-9999");
      expect(JSON.parse(seen!.body).model).toBe("local-llama");
    });

    it("records last-used so a live connection is distinguishable", async () => {
      await svc.saveModelProvider(db, workspace.id, {
        baseUrl: endpointUrl,
        model: "local-llama",
      });
      expect((await svc.getModelProvider(db, workspace.id))?.lastUsedAt).toBeNull();

      await svc.completeWithWorkspaceModel(db, workspace.id, {
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 0,
      }, ATTRIBUTION);

      expect((await svc.getModelProvider(db, workspace.id))?.lastUsedAt).not.toBeNull();
      // Keyless endpoint: no header at all rather than an empty bearer.
      expect(seen!.auth).toBeUndefined();
    });

    it("lists the models the stored connection serves", async () => {
      await svc.saveModelProvider(db, workspace.id, {
        baseUrl: endpointUrl,
        model: "local-llama",
        apiKey: "sk-stored-key-9999",
      });

      const out = await svc.listWorkspaceModels(db, workspace.id);

      expect(out.ok).toBe(true);
      expect(out.ok && out.models).toEqual(["local-llama", "local-mistral"]);
      expect(seen!.url).toBe("/v1/models");
      // The stored key was decrypted and used, exactly as a completion would.
      expect(seen!.auth).toBe("Bearer sk-stored-key-9999");
    });

    it("never sends the stored key to an endpoint it was not stored for", async () => {
      await svc.saveModelProvider(db, workspace.id, {
        baseUrl: endpointUrl,
        model: "local-llama",
        apiKey: "sk-stored-key-9999",
      });

      // Same host, different API root: what an admin editing the form has
      // typed, and not the endpoint the key was entrusted to. Sending it here
      // would turn a write-only credential into a readable one, since whoever
      // controls the probed address reads the Authorization header.
      const out = await svc.listWorkspaceModels(db, workspace.id, {
        baseUrl: `${endpointUrl}/elsewhere`,
      });

      expect(out.ok).toBe(true);
      expect(seen!.auth).toBeUndefined();
    });

    it("uses a key supplied with the probe, so setup works before saving", async () => {
      // Nothing is saved at all here: this is the first-run path, where the
      // picker has to work from what is still sitting in the form.
      const out = await svc.listWorkspaceModels(db, workspace.id, {
        baseUrl: endpointUrl,
        apiKey: "sk-typed-in-the-form-7777",
      });

      expect(out.ok).toBe(true);
      expect(seen!.auth).toBe("Bearer sk-typed-in-the-form-7777");
    });

    it("says 'not configured' when there is no URL saved or supplied", async () => {
      const out = await svc.listWorkspaceModels(db, workspace.id);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error.kind).toBe("not_configured");
      expect(seen).toBeNull();
    });

    it("refuses the same live endpoint once the deployment is hosted", async () => {
      await svc.saveModelProvider(db, workspace.id, {
        baseUrl: endpointUrl,
        model: "local-llama",
      });

      process.env.SPECBOARDS_MULTI_TENANT = "true";
      try {
        const out = await svc.completeWithWorkspaceModel(db, workspace.id, {
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 0,
        }, ATTRIBUTION);
        // The row was written while private targets were allowed. Re-checking
        // per call is what stops it outliving the policy that permitted it.
        expect(out.ok).toBe(false);
        expect(!out.ok && out.error.kind).toBe("blocked");
        expect(seen).toBeNull();
      } finally {
        delete process.env.SPECBOARDS_MULTI_TENANT;
      }
    });
  });

  /**
   * The same path against a real inference runtime rather than a stub.
   *
   * The block above proves the layers connect, using a server written by the
   * same person as the assertions. What it cannot prove is that a runtime we
   * did not write agrees with us about the protocol, and "OpenAI-compatible"
   * is a claim each one makes about itself. This is the on-prem deployment
   * end to end: a key encrypted into Postgres, read back, decrypted, and
   * spent against a model on a private address.
   *
   * Opt in with a runtime (see `ai/self-hosted.int.test.ts` for the Docker
   * one-liner):
   *
   *   SPECBOARDS_TEST_MODEL_URL=http://127.0.0.1:11434/v1 \
   *   SPECBOARDS_TEST_MODEL=qwen2.5:0.5b pnpm test:int
   */
  describe.skipIf(!process.env.SPECBOARDS_TEST_MODEL_URL)(
    "end to end against a self-hosted runtime",
    () => {
      const RUNTIME_URL = process.env.SPECBOARDS_TEST_MODEL_URL!;
      const RUNTIME_MODEL = process.env.SPECBOARDS_TEST_MODEL ?? "qwen2.5:0.5b";
      // A small model on CPU, and the first call also loads the weights.
      const TIMEOUT_MS = 120_000;

      it(
        "spends a stored, encrypted key against a model on a private address",
        async () => {
          // The runtime takes no key; storing one anyway is the point. It
          // proves the credential survives the round trip through Postgres
          // independently of whether the endpoint checks it.
          await svc.saveModelProvider(db, workspace.id, {
            baseUrl: RUNTIME_URL,
            model: RUNTIME_MODEL,
            apiKey: "sk-onprem-gateway-token",
          });

          const [stored] = await credentialRows();
          expect(stored!.secret).not.toContain("sk-onprem");
          expect(decryptSecret(stored!.secret)).toBe("sk-onprem-gateway-token");

          const out = await svc.completeWithWorkspaceModel(db, workspace.id, {
            messages: [{ role: "user", content: "Say ready." }],
            maxTokens: 16,
            timeoutMs: TIMEOUT_MS,
          }, ATTRIBUTION);

          expect(out.ok).toBe(true);
          expect(out.ok && out.text.length).toBeGreaterThan(0);
          expect(out.ok && out.model).toBe(RUNTIME_MODEL);
        },
        TIMEOUT_MS,
      );

      it(
        "records the call, so a live connection is distinguishable from a stale one",
        async () => {
          await svc.saveModelProvider(db, workspace.id, {
            baseUrl: RUNTIME_URL,
            model: RUNTIME_MODEL,
          });
          expect((await svc.getModelProvider(db, workspace.id))!.lastUsedAt).toBeNull();

          await svc.completeWithWorkspaceModel(db, workspace.id, {
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 8,
            timeoutMs: TIMEOUT_MS,
          }, ATTRIBUTION);

          expect((await svc.getModelProvider(db, workspace.id))!.lastUsedAt).not.toBeNull();
        },
        TIMEOUT_MS,
      );

      it(
        "fills the model picker from what the runtime actually serves",
        async () => {
          await svc.saveModelProvider(db, workspace.id, {
            baseUrl: RUNTIME_URL,
            model: RUNTIME_MODEL,
          });

          const out = await svc.listWorkspaceModels(db, workspace.id);
          expect(out.ok).toBe(true);
          expect(out.ok && out.models).toContain(RUNTIME_MODEL);
        },
        TIMEOUT_MS,
      );

      it(
        "refuses the same runtime once the deployment is multi-tenant",
        async () => {
          // The one conflict the two features have with each other, resolved
          // by deployment. On the hosted product this exact configuration is
          // a request-forgery primitive, and it has to stay refused there.
          await svc.saveModelProvider(db, workspace.id, {
            baseUrl: RUNTIME_URL,
            model: RUNTIME_MODEL,
          });

          process.env.SPECBOARDS_MULTI_TENANT = "true";
          try {
            const out = await svc.completeWithWorkspaceModel(db, workspace.id, {
              messages: [{ role: "user", content: "hi" }],
              maxTokens: 0,
              timeoutMs: TIMEOUT_MS,
            }, ATTRIBUTION);
            expect(out.ok).toBe(false);
            expect(!out.ok && out.error.kind).toBe("blocked");
          } finally {
            delete process.env.SPECBOARDS_MULTI_TENANT;
          }
        },
        TIMEOUT_MS,
      );
    },
  );
});
