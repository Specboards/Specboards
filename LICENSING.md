# Licensing

SpecBoard is **open-core**. The core product is free and open source under the
Apache License 2.0; a small set of commercial features are licensed separately.
This document explains where the line is.

## Open core: Apache-2.0

Everything in this repository is licensed under [Apache-2.0](./LICENSE) unless a
file or directory carries a different, explicit notice. That includes:

- The web app (`apps/web`).
- The shared packages (`packages/**`): core domain logic, the database layer,
  and the MCP server.
- Self-hosting via `infra/docker-compose.yml`, with a single organization
  (`N=1`) and your own GitHub App.
- All specs, docs, and migrations.

You may run, modify, and self-host the open core for any purpose, including
commercially, subject to the terms of the Apache-2.0 license.

## Commercial features: separately licensed

The following SaaS-oriented capabilities are **not** covered by the Apache-2.0
grant and require a commercial agreement with Studio Palouse. Where their code lives
in this repository it is marked with a `LICENSE` notice in the relevant
directory; otherwise it ships only in the hosted product.

- **Multi-tenant hosting**: serving more than one organization from a single
  deployment (`N>1`), including self-service org provisioning.
- **SSO / SAML / SCIM**: enterprise identity, directory sync, and automated
  provisioning.
- **Advanced analytics**: cross-product reporting, cycle-time, and roadmap
  insight dashboards.
- **Premium integrations**: managed connectors beyond the open GitHub sync.
- **Audit logs**: tamper-evident, exportable activity history.

These features power the hosted service at
[specboard.ai](https://specboard.ai). For a commercial or self-managed
enterprise license, contact **contact@palouse.io**.

## Contributing

Contributions are accepted under the Apache-2.0 license, per section 5 of the
[LICENSE](./LICENSE). By submitting a contribution you agree it may be
distributed under those terms. If a contribution touches a commercially licensed
area, note that in your pull request so we can route it correctly.

## Brand and trademarks: all rights reserved

The SpecBoard **software** is open source. The SpecBoard **brand** is not.

"SpecBoard", the SpecBoard logos, the visual identity (colors, typography,
look and feel), and the marketing content are proprietary to Studio Palouse and
are **not** covered by the Apache-2.0 grant. The Apache-2.0 license explicitly
does not grant trademark rights; see section 6 of the [LICENSE](./LICENSE).

The public marketing site (`www.specboard.ai`) and the brand assets live in a
separate repository ([Specboards/Website](https://github.com/Specboards/Website))
under a proprietary license, not in this repository.

What this means in practice:

- You may run, modify, and self-host the open core, including commercially.
- You may make nominative, factual references to SpecBoard (for example,
  "integrates with SpecBoard") without implying endorsement or affiliation.
- You may **not** use the SpecBoard name or logos to brand your own
  distribution, fork, or service, or in a way that suggests it is the official
  SpecBoard product, without written permission.

To use the SpecBoard name or brand assets, email **contact@palouse.io**.

## Questions

Anything unclear about how a particular use is licensed? Email
**contact@palouse.io** before you build on it, and we're happy to clarify.
