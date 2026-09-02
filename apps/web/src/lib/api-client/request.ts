"use client";

/**
 * The active org slug, read from the `/[org]/...` route. Every UI page renders
 * under an org segment, so the first path segment is the workspace the user is
 * looking at. The server validates this hint against a real membership.
 */
function activeOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  const slug = window.location.pathname.split("/")[1];
  return slug ? decodeURIComponent(slug) : null;
}

/** Thrown when a request is rejected for lack of a session (HTTP 401). */
export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthRequiredError";
  }
}

/**
 * `fetch` for the versioned API that tags each request with the active org and
 * turns an expired session into the one error every caller already handles.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const slug = activeOrgSlug();
  const headers = new Headers(init.headers);
  if (slug) headers.set("x-org-slug", slug);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) throw new AuthRequiredError();
  return response;
}
