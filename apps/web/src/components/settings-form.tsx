"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { updateWorkspace } from "@/lib/api-client/organization";
import { changeEmail, updateUser } from "@/lib/auth-client";
import { useOrgPath } from "@/lib/use-org";
import { AvatarPicker } from "@/components/avatar-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SettingRow } from "@/components/ui/setting-row";

/** The set of IANA time zones for the picker, with a sensible fallback. */
function useTimeZones(): string[] {
  return useMemo(() => {
    try {
      // Available in modern runtimes; guard for older ones.
      const supported = (
        Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf;
      if (supported) return supported("timeZone");
    } catch {
      /* fall through */
    }
    return ["UTC"];
  }, []);
}

/**
 * Everything about *you*: picture, name, sign-in email, time zone.
 *
 * The email used to sit in a card of its own further down the page, below the
 * GitHub connection, which put a fact about your identity behind a fact about
 * an integration. It is here now.
 *
 * Every value shows itself before it offers a field, per the Settings
 * convention in CLAUDE.md, so arriving on this page is reading rather than a
 * form waiting to be filled in. `SettingRow` owns that behaviour; see its notes
 * for why work items get the opposite treatment.
 */
export function ProfileCard({
  name,
  email,
  image,
  timezone,
}: {
  name: string;
  email: string;
  image: string | null;
  timezone: string | null;
}) {
  const router = useRouter();
  const orgHref = useOrgPath();
  const zones = useTimeZones();
  const browserZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";
  const effectiveZone = timezone ?? browserZone;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How you appear across Specboards, and the address you sign in with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AvatarPicker name={name} image={image} />

        <Separator />

        <SettingRow
          label="Name"
          value={name}
          successMessage="Name saved."
          onSave={async (data) => {
            const next = String(data.get("name") ?? "").trim();
            if (!next) throw new Error("Name is required.");
            const { error } = await updateUser({ name: next });
            if (error) throw new Error(error.message ?? "Couldn't save your name.");
            router.refresh();
          }}
        >
          <FormField label="Name">
            <Input name="name" defaultValue={name} autoComplete="name" required />
          </FormField>
        </SettingRow>

        <SettingRow
          label="Email"
          value={email}
          editLabel="Change"
          submitLabel="Send confirmation"
          hint="You sign in with this address."
          onSave={async (data) => {
            const newEmail = String(data.get("email") ?? "").trim();
            if (!newEmail || newEmail === email) {
              throw new Error("Enter a different email address.");
            }
            const { error } = await changeEmail({
              newEmail,
              callbackURL: orgHref("/settings/profile"),
            });
            if (error) {
              throw new Error(error.message ?? "Couldn't change your email.");
            }
            // Better Auth reports success even when the new address already
            // belongs to another account (it sends nothing, so as not to leak
            // that the address exists). Worded so somebody who never receives
            // the email understands why, without us confirming either way.
            //
            // Both steps are described up front. Somebody who confirms from
            // their old inbox and then sees no change has not hit a bug, they
            // are halfway through, and finding that out from the first email
            // is worse than reading it here.
            return `We've sent a confirmation link to ${email}. Open it and we'll send a second link to ${newEmail}; the change takes effect once you open that one too. If neither arrives, the new address may already be in use by another account.`;
          }}
        >
          <FormField
            label="New email"
            hint={`Changing this sends a confirmation link to ${email}, then a second one to the new address. The change takes effect once you have opened both.`}
          >
            <Input name="email" type="email" autoComplete="email" required />
          </FormField>
        </SettingRow>

        <SettingRow
          label="Time zone"
          value={effectiveZone}
          hint={
            timezone
              ? undefined
              : "Not set yet, so dates follow this browser's time zone."
          }
          successMessage="Time zone saved."
          onSave={async (data) => {
            const next = String(data.get("timezone") ?? "").trim();
            const { error } = await updateUser({ timezone: next });
            if (error) {
              throw new Error(error.message ?? "Couldn't save your time zone.");
            }
            router.refresh();
          }}
        >
          <FormField label="Time zone">
            <Select name="timezone" defaultValue={effectiveZone}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </FormField>
        </SettingRow>
      </CardContent>
    </Card>
  );
}

export function AppearanceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Choose a light or dark theme, or follow your system setting. Saved on
          this device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ThemeToggle />
      </CardContent>
    </Card>
  );
}

export function CompanyCard({
  name,
  canEdit,
}: {
  name: string;
  canEdit: boolean;
}) {
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company</CardTitle>
        <CardDescription>
          {canEdit
            ? "Your organization's name across Specboards."
            : "Your organization. Only the owner can change these details."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRow
          label="Company name"
          value={name || <span className="text-muted-foreground">Not set</span>}
          canEdit={canEdit}
          successMessage="Company saved."
          onSave={async (data) => {
            const next = String(data.get("name") ?? "").trim();
            if (!next) throw new Error("Company name is required.");
            await updateWorkspace(next);
            router.refresh();
          }}
        >
          <FormField label="Company name">
            <Input name="name" defaultValue={name} required />
          </FormField>
        </SettingRow>
      </CardContent>
    </Card>
  );
}
