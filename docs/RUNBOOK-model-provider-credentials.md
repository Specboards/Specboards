# RUNBOOK: model provider credentials and egress

Backlog card: "Credential storage, rotation, and egress policy" (Bring your own
model epic). Bring-your-own-model asks a customer to hand us a key that spends
their money, and to name a base URL we will then make server-side requests to.
Both are handled in code and ship on by default; this runbook says how, what an
operator is expected to do, and how to verify it.

Code: `apps/web/src/lib/model-provider-service.ts` (storage and rotation),
`apps/web/src/lib/ai/egress.ts` (policy), `apps/web/src/lib/crypto.ts`
(encryption), `apps/web/src/lib/egress.ts` (classification and pinning, shared
with webhooks).

## How a key is stored

- The key is encrypted with AES-256-GCM before it reaches the database, in
  `model_provider_credentials.secret`. The encryption key is derived from
  `BETTER_AUTH_SECRET` by scrypt with a per-value salt, the same machinery that
  protects the GitHub App private key and webhook secret.
- Alongside it we store a four-character `hint` (the tail of the key) and
  nothing else. The hint is what the settings screen renders, so an admin can
  recognise which key is installed without the value being readable.
- **The key is write-only from the browser.** `ModelProviderView`, the only
  shape any route returns, has no field that could carry one. Decryption happens
  in one non-exported function, and the only ways to reach it are making a
  completion or listing an endpoint's models.
- A model list probe will only send the stored key to the endpoint it was stored
  for. Probing any other URL carries only a key supplied with the request.
  Without that rule, anyone who could reach the route could point it at a server
  they control and read the key out of the `Authorization` header.

Consequence worth knowing before you rotate `BETTER_AUTH_SECRET`: every stored
provider key becomes undecryptable, exactly like the GitHub App credentials. The
connection then fails on its next call and the admin must paste the key again.
This is already listed in `docs/SECURITY-self-host-checklist.md` section 3.

## Rotation

Rotation is "paste the new key and save", from Settings → Integrations → Model
connection → Edit.

- The new credential row is written **before** the provider row is repointed and
  the old row deleted, so there is no window in which the workspace has no
  usable key.
- The next completion picks up the new key: the config is resolved per call,
  never cached, so there is nothing to restart or invalidate.
- Editing the model or endpoint without typing a key leaves the stored key
  alone. The save request omits the field entirely, which is what "keep it"
  means on the wire.

## Revocation

Two shapes, because they answer different questions:

| You want | Do this | What happens |
| --- | --- | --- |
| The key gone, the connection kept | Edit → "Remove the stored key without disconnecting" → Save | The credential row is destroyed. The endpoint and model stay configured, which is right for a keyless self-hosted runtime. |
| The whole connection gone | "Disconnect" → confirm | The provider row and the credential row are both destroyed. |

Both are confirmed in the UI with what stops working, because neither can be
undone from inside the product: a stored key cannot be read back, so recovering
means finding the original again.

**Destroying our copy is not revocation at the provider.** The key stays valid
on the vendor account until it is revoked there. The UI says so on both paths;
say it again in any incident write-up. If a key is believed to have leaked, the
order is: revoke at the vendor first (that is what stops the spending), then
disconnect here.

What stops working when a key is pulled: every feature that needs inference
returns "no model connected" until one is connected again. Specs, boards, items,
webhooks and the GitHub integration are untouched.

## Egress policy

A customer-supplied base URL is a server-side request to an address a user
chose, which is SSRF unless it is constrained. The model path reuses the webhook
machinery in `@/lib/egress` rather than growing a second implementation:
HTTPS-only, resolve-then-classify with `ipaddr.js`, reject anything not globally
routable, and pin the connection to the pre-validated address so DNS cannot
rebind between the check and the connect.

What is model-specific is the policy, because the two features genuinely
disagree about private addresses:

- **Hosted (multi-tenant).** Private and reserved targets are never reachable.
  `SPECBOARDS_MODEL_ALLOW_PRIVATE` is ignored, and the boot guard
  `assertModelEgressPolicy()` **refuses to start** if it is set, so the
  misconfiguration surfaces at deploy time rather than silently on every
  request. Tenants supply these URLs; no configuration should let one tenant aim
  the server at the metadata endpoint or an internal service.
- **Self-hosted (single-tenant).** `SPECBOARDS_MODEL_ALLOW_PRIVATE=1` opts in,
  and logs a startup warning. The operator, the tenant and the network owner are
  the same party, so "reach my vLLM box at 10.0.0.4" is a coherent request. This
  also relaxes the HTTPS requirement, which is what makes a plain-http local
  runtime usable.

It is deliberately a **separate flag** from `SPECBOARDS_WEBHOOK_ALLOW_PRIVATE`.
Turning on a self-hosted model must not also re-point webhook deliveries at the
internal network.

The URL is checked twice: at save time, where the admin can still do something
about the refusal, and again before every completion. Re-checking is what makes
a tightened policy take effect on rows written under a looser one, and what
catches a hostname that resolved publicly at save time and resolves privately
later.

## Verification

Unit and integration coverage:

```sh
pnpm --filter @specboards/web vitest run src/lib/ai/egress.test.ts
# needs DATABASE_URL; skips itself without one
pnpm --filter @specboards/web vitest run --config vitest.int.config.ts \
  src/lib/model-provider.int.test.ts
```

The integration suite is where storage, rotation and revocation are pinned
against a real database: the key is unreadable in the column, a save that omits
the field keeps it, a rotation never leaves the workspace without a usable key,
removal keeps the connection, deletion destroys the credential, and the stored
key is never sent to an endpoint it was not stored for.

By hand, on test before prod:

1. Settings → Integrations → Model connection. Save a key, confirm only
   `••••abcd` is rendered and no request response contains the value (check the
   network tab, not just the screen).
2. In psql: `select hint, left(secret, 24) from model_provider_credentials;` -
   the secret column must be an opaque base64 blob.
3. Paste a different key, save, and send a test call. It must succeed
   immediately, with no restart.
4. "Remove the stored key without disconnecting", save, and confirm the endpoint
   and model survive with the key shown as none.
5. Disconnect and confirm the credential row is gone:
   `select count(*) from model_provider_credentials where workspace_id = '...';`
6. Try to save `http://169.254.169.254/v1` and `http://10.0.0.1/v1` as the base
   URL on a hosted deployment. Both must be refused at save time with a reason,
   not accepted and failed later.

## Deployment note

Both `specboard` and `specboard-test` run multi-tenant, so the self-hosted
private-endpoint path **cannot** be exercised on our own deployments: a private
address is refused there by design. It is covered locally and by the integration
tests. Read a refusal on test as the policy working, not as a bug.
