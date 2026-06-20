/**
 * Cross-host links for the marketing site. The landing page lives on
 * www/apex specboard.ai, while the app lives on a different host — so auth
 * CTAs must be ABSOLUTE URLs (the app's auth client keys off the current
 * origin; a relative `/sign-in` would never reach the app). Values are baked
 * at build time from NEXT_PUBLIC_* with production-safe defaults.
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.specboard.ai";
export const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/StudioPalouse/SpecBoard";

export const SIGN_IN_URL = `${APP_URL}/sign-in`;
export const SIGN_UP_URL = `${APP_URL}/sign-up`;

export const site = {
  name: "SpecBoard",
  tagline: "Product management that lives in your git specs.",
  description:
    "SpecBoard layers status, priority, roadmap, and ownership on top of the spec files your team and your AI agents already commit to git — no duplication into Jira or Aha.",
} as const;
