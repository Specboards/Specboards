import type { MetadataRoute } from "next";

/**
 * What crawlers may index.
 *
 * There was no `robots.txt` before the public portal, and until now that was
 * defensible: every page worth crawling was behind a sign-in, so a crawler got
 * a redirect and indexed nothing of substance. The portal changes that. It is
 * the first surface meant to be found, and adding it without saying anything
 * about the rest would invite crawlers into the whole app for the first time.
 *
 * So: allow the portal, refuse everything that is an account, an API, or a
 * mistake to have indexed.
 *
 * ── Why the disallow list is not just "everything but /*​/ideas" ────────────
 * Because a portal lives at `/{org}/ideas`, and `{org}` is a wildcard. A rule
 * shaped "allow only the portal" cannot be expressed without also allowing
 * `/{org}/` generally, which is the authenticated app. The list below names the
 * authenticated areas instead, which is longer but says what it means.
 *
 * ── This is not a security control ─────────────────────────────────────────
 * `robots.txt` is a request, honoured by well-behaved crawlers and ignored by
 * everything else, and it is *public*: listing a path here advertises it. It is
 * not what keeps the app private. Authentication does that, on every route, and
 * nothing below should ever be the reason a page is not reachable.
 *
 * An unpublished portal is not mentioned here at all, deliberately. It 404s,
 * and its `generateMetadata` returns `robots: { index: false }`, so it is
 * excluded by not existing rather than by being named in a public file.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          // The API surface. Nothing here renders, and a crawler following a
          // link into it only spends rate limit.
          "/api/",
          // Account and authentication flows. Several carry single-use tokens
          // in the query string, which is reason enough on its own.
          "/sign-in",
          "/sign-up",
          "/setup",
          "/forgot-password",
          "/reset-password",
          "/invite/",
          "/oauth/",
          "/unsubscribe",
          // The authenticated app, by area. `/{org}/ideas` and `/{org}/roadmap`
          // stay crawlable because neither is listed.
          "/*/settings",
          "/*/dashboard",
          "/*/notifications",
          "/*/repositories",
          "/*/backlog",
          // TWO wildcards, and the difference matters.
          //
          // The internal roadmap is `/{org}/{product}/roadmap`, and the PUBLIC
          // one is `/{org}/roadmap`. A rule of `/*/roadmap` matches both,
          // because `*` in robots.txt spans any characters including slashes,
          // so it silently blocked the public roadmap from the moment that page
          // shipped, while the page's own metadata said `index: true`. Two
          // contradictory signals, and the crawler obeys this one.
          //
          // `/*/*/roadmap` needs two path segments ahead of it, which the
          // internal route has and the public one does not.
          "/*/*/roadmap",
          "/*/cycles",
          "/*/goals",
          "/*/strategy",
          "/*/research",
          "/*/architecture",
          "/*/activity",
        ],
      },
    ],
  };
}
