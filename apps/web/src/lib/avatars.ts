/**
 * Shared facts about uploaded profile pictures, so the browser, the upload
 * route, and the serving route agree without importing each other.
 */

/**
 * 256 KB. Comfortably more than a 512x512 WebP or JPEG needs, and small enough
 * that the bytes sitting in Postgres stay a rounding error (see 0080). The
 * picker downsamples before it uploads, so this is a backstop against a
 * hand-rolled request rather than a limit a normal user meets.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * The ceiling on the whole multipart REQUEST, as opposed to the image inside
 * it.
 *
 * Larger than {@link MAX_AVATAR_BYTES} by an envelope, because a multipart
 * body carries boundaries, per-part headers and possibly other fields around
 * the file. Small enough that a request is refused while it is arriving
 * rather than after it has been parsed: this is the bound on how much a
 * caller can make the server allocate, and the per-file checks that follow
 * are the bound on what gets stored. They are different jobs and need
 * different numbers.
 *
 * 32 KB of envelope is roughly two orders of magnitude more than a real
 * browser multipart preamble needs, so it costs nothing legitimate.
 */
export const MAX_AVATAR_REQUEST_BYTES = MAX_AVATAR_BYTES + 32 * 1024;

/** The longest edge the picker downsamples to before uploading. */
export const AVATAR_MAX_EDGE = 512;

/**
 * What may be stored and echoed back as a Content-Type. Kept to three formats
 * that every browser renders and none of which can carry script: notably no
 * SVG, which is a document and would be a stored-XSS vector served from our own
 * origin. Mirrored by a CHECK constraint in 0080.
 */
const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

type AvatarMime = (typeof AVATAR_MIME_TYPES)[number];

export function isAvatarMime(value: string): value is AvatarMime {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Where an uploaded picture is served from. With `updatedAt` it carries a
 * cache-busting `?v=`, which is what gets stored in `users.image`; without one
 * it is the stable prefix, used to recognize our own URLs.
 */
export function avatarUrl(userId: string, updatedAt?: Date): string {
  const base = `/api/avatars/${userId}`;
  return updatedAt ? `${base}?v=${updatedAt.getTime()}` : base;
}

/** Whether an image URL points at an upload of ours rather than an external host. */
export function isUploadedAvatar(
  image: string | null | undefined,
  userId: string,
): boolean {
  return Boolean(image && image.startsWith(avatarUrl(userId)));
}
