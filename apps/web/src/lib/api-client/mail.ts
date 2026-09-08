"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  MailSettingsInput,
  MailSettingsView,
} from "@/lib/mail-settings-service";

/** Read a JSON body, or throw whatever the server said went wrong. */
async function unwrap<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok || !body) {
    throw new Error(body?.error ?? `${what} failed (${res.status}).`);
  }
  return body;
}

/** Save the deployment's mail transport. A credential left out of `input` keeps
 * the stored one, which is what lets an admin change a port without re-typing
 * a password they cannot read back. */
export async function saveMailSettings(
  input: MailSettingsInput,
): Promise<MailSettingsView> {
  const res = await apiFetch("/api/v1/mail-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrap<MailSettingsView>(res, "Saving mail settings");
}

/** Forget the stored transport and fall back to whatever env provides. */
export async function clearMailSettings(): Promise<MailSettingsView> {
  const res = await apiFetch("/api/v1/mail-settings", { method: "DELETE" });
  return unwrap<MailSettingsView>(res, "Clearing mail settings");
}

/** Send a test to the signed-in admin's own address, through `input` when given
 * (so settings can be tried before they are saved) or the saved ones when not. */
export async function sendTestEmail(
  input?: MailSettingsInput,
): Promise<{ to: string }> {
  const res = await apiFetch("/api/v1/mail-settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  return unwrap<{ ok: true; to: string }>(res, "Sending the test email");
}
