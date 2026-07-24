# AGPL source availability (self-hosters)

Specboards is licensed under the [GNU Affero General Public License v3.0](../LICENSE)
(AGPLv3). Section 13 of that license adds one obligation beyond the ordinary
GPL: **if you run a modified version and let others interact with it over a
network, you must offer those users the Corresponding Source of your modified
version.** Simply running an unmodified copy, or modifying a copy only you use,
does not trigger it.

## What Specboards does out of the box

Every build (the hosted SaaS and the `infra/docker-compose.yml` self-host stack
use the same image) ships an in-app notice at **`/legal`**, linked from the
sidebar footer on every page. It states the copyright, the AGPLv3 license, the
no-warranty disclaimer, and a **"Source code"** link. That link resolves to the
exact running commit when the build is stamped with it (see below), otherwise to
the repository root.

So an **unmodified** self-host is compliant with no extra work.

## If you modify Specboards

If you change the code and expose it to users over a network, do two things:

1. **Publish your modified Corresponding Source** somewhere your users can reach
   it, e.g. a public fork on GitHub/GitLab, or a source tarball you host.
2. **Point the in-app notice at your source** so the offer is accurate. Set
   these when building/deploying the web image:

   - `NEXT_PUBLIC_SOURCE_REPO_URL` — the URL of your published modified source
     (repository root). The `/legal` "Source code" and license links use it.
   - `GIT_SHA` (Docker build arg) — the commit you built from, so the link pins
     to the exact source:

     ```sh
     docker build -f infra/web.Dockerfile \
       --build-arg GIT_SHA="$(git rev-parse --short HEAD)" \
       -t specboards-web .
     ```

     The build arg is baked in as `NEXT_PUBLIC_GIT_SHA`. Left unset, the notice
     falls back to the repository root, which is still a valid offer for an
     unmodified copy.

## Not covered by AGPL

The `@specboards/cli` package is Apache-2.0 licensed and carries no section 13
obligation. See [LICENSING.md](../LICENSING.md) for the full dual-licensing
picture (AGPLv3 or a commercial license from Studio Palouse).
