import { revalidatePath } from "next/cache";
import { eq, userAvatars, users } from "@specboards/db";

import { getBrowserSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { readBinaryBodyWithin, tooLargeResponse } from "@/lib/api/body";
import {
  avatarUrl,
  isAvatarMime,
  isUploadedAvatar,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_REQUEST_BYTES,
} from "@/lib/avatars";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's uploaded profile picture.
 *
 * Session-only, deliberately: `getBrowserSessionUser` reads the session cookie
 * and nothing else, so an API key cannot change whose face appears beside
 * someone's comments. There is no user id in the request at all, for the same
 * reason there is no `userId` parameter on the change-password route: the
 * caller can only ever act on themselves, so there is no authorization decision
 * to get wrong.
 *
 * The bytes arrive already downsampled by the browser (see `avatar-picker.tsx`),
 * which is why the limits below can be as tight as they are without rejecting a
 * photo straight off a phone. The checks are still made here rather than
 * trusted from the client, and again by CHECK constraints in 0080.
 */

/** POST /api/v1/profile/avatar - replace the picture. Body: multipart `file`. */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) {
    return Response.json(
      { error: "Profile pictures need a database; local file mode has no account." },
      { status: 501 },
    );
  }
  const user = await getBrowserSessionUser(req);
  if (!user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  // ── Bound the request before parsing it ─────────────────────────────────
  // `req.formData()` consumes and parses the whole body, so the size checks
  // further down protect storage and bound neither request memory nor
  // parsing work. That mattered here more than it looks: `lib/api/body.ts`
  // streams and aborts at a byte ceiling precisely because the deployment
  // has no outer request-size cap and runs on a 512 MB machine, and this
  // route went around it. Reading the bytes with that same policy first, and
  // handing the bounded buffer to the platform's multipart parser, keeps the
  // parser and caps the allocation.
  const raw = await readBinaryBodyWithin(
    req,
    MAX_AVATAR_REQUEST_BYTES,
    "profile/avatar",
  );
  if (raw === null) return tooLargeResponse(MAX_AVATAR_REQUEST_BYTES);

  let form: FormData;
  try {
    // The content type carries the multipart boundary, so it has to be
    // passed through for the parse to mean anything.
    form = await new Response(raw, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return Response.json(
      { error: "Send the image as multipart/form-data." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file was uploaded." }, { status: 422 });
  }
  if (!isAvatarMime(file.type)) {
    return Response.json(
      { error: "Use a PNG, JPEG, or WebP image." },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return Response.json({ error: "That file is empty." }, { status: 422 });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return Response.json(
      {
        error: `That image is too large (max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB).`,
      },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // `file.size` is what the client declared; this is what actually arrived.
  // Checking both means a lying Content-Length cannot get past the cheap check.
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
    return Response.json(
      { error: "That image is too large or empty." },
      { status: 413 },
    );
  }

  const updatedAt = new Date();
  await db
    .insert(userAvatars)
    .values({
      userId: user.id,
      mimeType: file.type,
      bytes,
      byteSize: bytes.byteLength,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: userAvatars.userId,
      set: {
        mimeType: file.type,
        bytes,
        byteSize: bytes.byteLength,
        updatedAt,
      },
    });

  // Point `users.image` at the new bytes. The `?v=` is the whole reason the
  // upload is two writes: without it a replaced picture keeps its URL and every
  // browser that has seen the old one goes on showing it.
  const image = avatarUrl(user.id, updatedAt);
  await db
    .update(users)
    .set({ image, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  revalidatePath("/[org]/settings/profile", "page");
  return Response.json({ image });
}

/**
 * DELETE /api/v1/profile/avatar - drop the uploaded picture, falling back to
 * the initial-letter placeholder.
 *
 * Only clears `users.image` when it is still pointing at the upload. Somebody
 * who uploaded a picture, then pasted an external URL over it, and then removed
 * the leftover upload should keep the URL they chose.
 */
export async function DELETE(req: Request) {
  const db = getDb();
  if (!db) {
    return Response.json(
      { error: "Profile pictures need a database; local file mode has no account." },
      { status: 501 },
    );
  }
  const user = await getBrowserSessionUser(req);
  if (!user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  await db.delete(userAvatars).where(eq(userAvatars.userId, user.id));

  const [row] = await db
    .select({ image: users.image })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (isUploadedAvatar(row?.image, user.id)) {
    await db
      .update(users)
      .set({ image: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  revalidatePath("/[org]/settings/profile", "page");
  return Response.json({ ok: true });
}
