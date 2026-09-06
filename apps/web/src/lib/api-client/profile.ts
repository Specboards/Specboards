"use client";

import { apiFetch } from "@/lib/api-client/request";

/** Upload a profile picture. Returns the URL now stored on the user. */
export async function uploadAvatar(file: Blob): Promise<string> {
  const body = new FormData();
  // The name is what the route reads the part out by; the filename is only for
  // the multipart envelope, which the route ignores.
  body.append("file", file, "avatar");
  const res = await apiFetch("/api/v1/profile/avatar", { method: "POST", body });
  const parsed = (await res.json().catch(() => null)) as {
    image?: string;
    error?: string;
  } | null;
  if (!res.ok || !parsed?.image) {
    throw new Error(parsed?.error ?? `Upload failed with ${res.status}`);
  }
  return parsed.image;
}

/** Remove the uploaded picture, falling back to the initial placeholder. */
export async function removeAvatar(): Promise<void> {
  const res = await apiFetch("/api/v1/profile/avatar", { method: "DELETE" });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(parsed?.error ?? `Remove failed with ${res.status}`);
  }
}
