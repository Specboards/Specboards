/**
 * Opt-in cursor pagination for `/api/v1` list endpoints. Pagination is OFF
 * unless the caller passes `?limit`, so existing consumers (the web board, the
 * CLI) that expect the full list are unaffected. When `?limit` is present the
 * route returns a stable-ordered page plus an opaque `nextCursor` (null on the
 * last page).
 *
 * The cursor is the base64url of the last item's stable key, so a client pages
 * by echoing `nextCursor` back as `?cursor`. Paging PRESERVES the endpoint's
 * own ordering (e.g. releases dated-first, ideas most-voted-first): the cursor
 * simply locates the last-returned item within the current ordering and resumes
 * after it. Over a mutable ordering that can skip or repeat an item between
 * pages, which is the normal, accepted trade-off for cursor pagination.
 */

export const MAX_PAGE_LIMIT = 200;

export interface PageRequest {
  /** Page size (1..MAX_PAGE_LIMIT), or null when the caller wants everything. */
  limit: number | null;
  /** The decoded key to resume after, or null to start from the beginning. */
  after: string | null;
}

/** Raised for a malformed `?limit` or `?cursor`. */
export class InvalidPageError extends Error {}

/** Parse `?limit` / `?cursor` from a request URL. Absent `limit` => no paging. */
export function parsePageRequest(url: URL): PageRequest {
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");

  let limit: number | null = null;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) {
      throw new InvalidPageError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    limit = n;
  }

  let after: string | null = null;
  if (rawCursor !== null && rawCursor !== "") {
    try {
      after = Buffer.from(rawCursor, "base64url").toString("utf8");
    } catch {
      throw new InvalidPageError("cursor is malformed.");
    }
    if (after === "") throw new InvalidPageError("cursor is malformed.");
  }

  return { limit, after };
}

/** Encode a stable key into an opaque cursor. */
export function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Apply a {@link PageRequest} to an in-memory list, preserving the list's
 * existing order. When `page.limit` is null the whole list is returned with a
 * null cursor. Otherwise the list is advanced past the `after` key (matched by
 * `keyOf`) and sliced to `limit`; `nextCursor` is set only when more items
 * remain. An unknown `after` key yields an empty final page.
 */
export function paginate<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  page: PageRequest,
): Page<T> {
  if (page.limit === null) {
    return { items: [...items], nextCursor: null };
  }
  let from = 0;
  if (page.after !== null) {
    const idx = items.findIndex((item) => keyOf(item) === page.after);
    from = idx < 0 ? items.length : idx + 1;
  }
  const slice = items.slice(from, from + page.limit);
  const hasMore = from + page.limit < items.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}
