import { revalidatePath } from "next/cache";

/**
 * Revalidate the pages that render item fields after a card-config change
 * (custom properties, releases): boards, item detail, roadmap, and the Cards
 * settings page.
 */
export function revalidateCardPages(): void {
  for (const path of [
    "/[org]/[product]/backlog",
    "/[org]/[product]/roadmap",
    "/[org]/settings/work-cards",
  ])
    revalidatePath(path, "page");
  revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
}

/**
 * Revalidate the Ideas pages after an idea change (capture, status, vote,
 * promote). Promotion also creates a feature, so refresh the boards/roadmap too.
 *
 * The PUBLIC portal routes (`/[org]/ideas` and `/[org]/ideas/[ideaId]`) are
 * deliberately not in this list, and it is worth saying why so nobody adds them
 * as an obvious omission. They hold no cache entry to invalidate: the root
 * layout awaits `headers()` for the CSP nonce, which opts every route in this
 * app out of the full route cache, so both portal pages are rendered per
 * request and are never stale. Naming them here would be a line that reads as
 * load-bearing and does nothing.
 *
 * If the portal is ever given a nonce-free layout so it CAN cache, this is one
 * of the two places that has to change; the other is the idea-settings PATCH,
 * which changes what is published without touching a row in `ideas`.
 */
export function revalidateIdeaPages(): void {
  for (const path of [
    "/[org]/[product]/ideas",
    "/[org]/[product]/backlog",
    "/[org]/[product]/roadmap",
    "/[org]/settings/ideas",
  ])
    revalidatePath(path, "page");
}
