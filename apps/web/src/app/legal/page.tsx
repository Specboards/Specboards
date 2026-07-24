import type { Metadata } from "next";
import Link from "next/link";

import {
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  LICENSE_NAME,
  LICENSE_URL,
  SOURCE_REPO_URL,
  sourceUrl,
  versionLabel,
} from "@/lib/source-info";

export const metadata: Metadata = {
  title: "About & license — Specboards",
  description:
    "Specboards copyright, AGPLv3 license, and source-code availability.",
};

const AGPL_DOC_URL = `${SOURCE_REPO_URL}/blob/main/docs/AGPL-source-availability.md`;

/**
 * Public "About & license" page. Carries the AGPLv3 Appropriate Legal Notices
 * (copyright, license, no-warranty) and the source-availability offer required
 * by AGPL section 13. Deliberately outside the `[org]` shell so it is reachable
 * without a workspace or sign-in, and it ships in every build (hosted and
 * docker-compose self-host) because it is part of the app.
 */
export default function LegalPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link
        href="/"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        ← Back to Specboards
      </Link>

      <h1 className="mt-6 text-2xl font-semibold">About Specboards</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Version{" "}
        <a
          href={sourceUrl()}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono underline underline-offset-2"
        >
          {versionLabel()}
        </a>
      </p>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">License &amp; source</h2>
        <p>
          Copyright © {COPYRIGHT_YEAR} {COPYRIGHT_HOLDER}.
        </p>
        <p>
          Specboards is free software: you can redistribute it and/or modify it
          under the terms of the {LICENSE_NAME} (AGPLv3) as published by the Free
          Software Foundation.
        </p>
        <p>
          Specboards is distributed in the hope that it will be useful, but{" "}
          <strong>without any warranty</strong>; without even the implied
          warranty of merchantability or fitness for a particular purpose. See
          the {LICENSE_NAME} for more details.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <a
              href={sourceUrl()}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-2"
            >
              Source code
            </a>{" "}
            for the version running here.
          </li>
          <li>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-2"
            >
              View the full license
            </a>{" "}
            (or at{" "}
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              gnu.org
            </a>
            ).
          </li>
        </ul>
      </section>

      <section className="mt-8 space-y-3 text-sm leading-relaxed">
        <h2 className="text-base font-medium">Modifying &amp; self-hosting</h2>
        <p>
          If you run a modified version of Specboards and let others interact
          with it over a network, the AGPL requires you to offer those users the
          Corresponding Source of your modified version. Keeping this notice and
          the source link above pointed at your modified source satisfies that
          obligation.
        </p>
        <p>
          See{" "}
          <a
            href={AGPL_DOC_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline underline-offset-2"
          >
            the source-availability guide
          </a>{" "}
          for what to publish and how to point this notice at it.
        </p>
      </section>
    </main>
  );
}
