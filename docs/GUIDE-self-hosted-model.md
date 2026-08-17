# Running Specboards against your own model

For deployments that cannot send anything to a public API. A spec is often the
most commercially sensitive document a company has: it describes what they are
about to build and why. "Bring your own model" is meant to cover the case where
that means a model on your own network, with no outbound internet at all.

Specboards talks to one thing, the OpenAI-compatible chat-completions API, so
anything speaking that protocol works: vLLM, Ollama, llama.cpp, LM Studio,
TGI, or a gateway you already run in front of your own weights.

Related: `docs/RUNBOOK-model-provider-credentials.md` for how the key is stored
and revoked, and `docs/SECURITY-self-host-checklist.md` section 6 for the
posture checklist.

## 1. Allow the app to reach a private address

Specboards refuses to make a server-side request to a private, loopback or
reserved address by default, because the base URL comes from a user and that is
otherwise a request-forgery primitive. Your inference is on a private address by
definition, so this deployment has to opt in:

```bash
# infra/.env, or your platform's secret store
SPECBOARDS_MODEL_ALLOW_PRIVATE=1
```

This also permits plain `http`, which is what makes a local runtime usable
without giving it a certificate.

Two things to know:

- It applies to the **model endpoint only**. Webhook deliveries keep their own
  policy and their own flag (`SPECBOARDS_WEBHOOK_ALLOW_PRIVATE`). Turning on a
  local model does not re-point webhooks at your internal network.
- A **multi-tenant** deployment refuses to boot with it set, and that refusal is
  deliberate. There the base URLs come from tenants, and no configuration should
  let one tenant aim the server at your metadata endpoint. Self-hosting is
  single-tenant, so this does not affect you unless you also set
  `SPECBOARDS_MULTI_TENANT`.

## 2. Worked example: Ollama on the same host

```bash
# On the machine running the model
ollama pull qwen2.5:7b-instruct
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Compose, with both on one host:

```yaml
# infra/docker-compose.yml, on the web service
services:
  web:
    environment:
      SPECBOARDS_MODEL_ALLOW_PRIVATE: "1"
    extra_hosts:
      # Lets the container reach a runtime on the Docker host itself. On Linux
      # this is required; on Docker Desktop it already resolves.
      - "host.docker.internal:host-gateway"
```

Then in the app, Settings → Integrations → Model connection → Connect a model:

| Field | Value |
| --- | --- |
| Provider | Self-hosted or other (OpenAI-compatible) |
| Base URL | `http://host.docker.internal:11434/v1` |
| API key | leave blank; Ollama takes none |
| Model | press "Check the key and load models", then pick `qwen2.5:7b-instruct` |

Save, then "Send a test call". A reply and a timing means the whole path works.

Ollama serves `/v1/models`, so the picker fills itself in. A runtime that serves
one set of weights and has no listing route is not a problem: the form says so
and falls back to a text field for the model name.

## 3. Worked example: vLLM on another host

```bash
# On the inference box, 10.0.0.4
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --api-key "$INTERNAL_TOKEN"
```

| Field | Value |
| --- | --- |
| Provider | Self-hosted or other (OpenAI-compatible) |
| Base URL | `http://10.0.0.4:8000/v1` |
| API key | the value of `INTERNAL_TOKEN` |
| Model | `Qwen/Qwen2.5-7B-Instruct` |

The key is encrypted at rest and never returned to the browser, exactly as a
hosted provider's key would be. `--api-key` is worth setting even on an internal
network: without it anything that can reach port 8000 can spend your GPUs.

## 4. Private TLS: internal CAs and self-signed certificates

The most likely thing to break. If your endpoint is `https://` with a
certificate from your own authority, Node trusts neither it nor a self-signed
one, and the call fails.

```bash
SPECBOARDS_MODEL_CA_CERT=/etc/ssl/certs/internal-ca.pem
```

- The value is either a **path** to a PEM file or the **PEM text itself**, for
  platforms where setting a secret is easier than mounting a file.
- A **self-signed certificate is its own authority**: point the same variable at
  the certificate. There is no "skip verification" switch, and deliberately so.
  Everything this needs to do is served by adding trust, and a switch that
  removed it would be reached for far more often than it was needed.
- Your public roots stay trusted. Configuring an internal CA does not break a
  workspace pointed at a hosted provider.
- It is scoped to the model endpoint. Unlike `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  which is process-wide and would disable verification for webhooks, GitHub and
  outbound email as well, this only ever widens what the model dispatcher will
  verify against.
- A bad path fails the **boot**, not the first model call, so a typo shows up in
  your deploy logs rather than as an unreachable endpoint days later.

If you get it wrong, the error says so. A certificate problem is reported as a
certificate problem naming this variable, rather than as "could not reach the
model endpoint", which is what sends people to look at firewalls.

Mounting the certificate in compose:

```yaml
services:
  web:
    environment:
      SPECBOARDS_MODEL_CA_CERT: /run/certs/internal-ca.pem
    volumes:
      - ./internal-ca.pem:/run/certs/internal-ca.pem:ro
```

## 5. Air-gapped: what reaches the internet

With a self-hosted model configured, the inference path makes exactly one
outbound request, to the base URL you entered. There is no telemetry call, no
license check, and no model list fetched from any vendor: the picker asks
**your** endpoint what it serves.

The rest of the app's outbound integrations are all opt-in and off unless you
configure them:

| Integration | Reaches the internet only if |
| --- | --- |
| Transactional email | `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM` are set. Unset, email is a logged no-op. |
| GitHub sync | a GitHub App is configured. |
| Outbound webhooks | a workspace registers one, to the URL it registered. |

So an air-gapped install is the default rather than a mode: leave those unset
and nothing leaves your network.

Two things that do need care:

- **Model weights.** Pull them on a connected machine and move them in. Neither
  Ollama nor vLLM can fetch a model without a network.
- **Container images.** Same: `docker save` / `docker load`, or mirror to an
  internal registry.

## 6. Verifying it

1. `SPECBOARDS_MODEL_ALLOW_PRIVATE` is set, and the startup log carries the
   `[security] SPECBOARDS_MODEL_ALLOW_PRIVATE is set` warning. No warning means
   the flag did not reach the process, and every private base URL will be
   refused at save time.
2. Settings → Integrations → Model connection → "Send a test call" returns a
   reply and a timing.
3. "Last used" updates to the time of that call. If it still says Never, the
   reply came from somewhere other than a completion.
4. For an air-gapped claim, cut the host's route to the internet and repeat
   step 2. It must still pass.

## Known limits

- `SPECBOARDS_MODEL_ALLOW_PRIVATE` relaxes the whole target policy for the model
  endpoint, including connection pinning against DNS rebinding. That is a
  coherent trade when the operator, the tenant and the network owner are the
  same party, and it is why the flag cannot be set on a multi-tenant deployment.
- Streaming responses are not used yet; calls are made with `stream: false`.
- The connection is per workspace, one endpoint each.
