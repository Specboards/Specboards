"use client";

import { useState, useTransition } from "react";

import {
  clearMailSettings,
  saveMailSettings,
  sendTestEmail,
} from "@/lib/api-client/mail";
import type {
  MailSettingsInput,
  MailSettingsView,
} from "@/lib/mail-settings-service";
import type { SmtpSecurity } from "@/lib/mail/types";
import { Button } from "@/components/ui/button";
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
import { StatusLine, type SettingStatus } from "@/components/ui/setting-row";

/**
 * How this deployment sends mail.
 *
 * ── Why this is a form and not the usual display-then-edit ──────────────────
 * The Settings convention in CLAUDE.md says a configured value is shown as
 * text with an Edit control beside it. This is the case that convention makes
 * an exception for by its own test ("would a typical user change this more
 * than once in a session, and did they come here to change it"): somebody on
 * this screen is configuring mail, almost certainly for the first time, and
 * almost certainly iterating on a host, a port and a TLS mode until a test
 * send works. Collapsing it back to text between attempts would fight them.
 *
 * The values that *are* configured still display before they offer a field,
 * which is the part of the convention that matters here: a saved credential is
 * shown as "a token is saved" and never as its value, because it cannot be
 * read back at all.
 */
export function MailSettingsCard({ initial }: { initial: MailSettingsView }) {
  const [view, setView] = useState(initial);
  const [status, setStatus] = useState<SettingStatus>(null);
  const [pending, startTransition] = useTransition();

  const saved = view.saved;
  const [transport, setTransport] = useState<MailSettingsInput["transport"]>(
    saved?.transport ?? "smtp",
  );
  const [from, setFrom] = useState(saved?.fromAddress ?? "");
  const [host, setHost] = useState(saved?.smtpHost ?? "");
  const [port, setPort] = useState(String(saved?.smtpPort ?? 587));
  const [security, setSecurity] = useState<SmtpSecurity>(
    saved?.smtpSecurity ?? "starttls",
  );
  const [username, setUsername] = useState(saved?.smtpUsername ?? "");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");

  if (!view.editable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transport</CardTitle>
          <CardDescription>
            Managed by the deployment on a multi-tenant install, so it is not
            editable here. This is what it is set to.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MailStatusLine view={view} />
        </CardContent>
      </Card>
    );
  }

  /** Build the body. A credential field left blank is omitted, which the
   * server reads as "keep the stored one". */
  function input(): MailSettingsInput {
    const base: MailSettingsInput = { transport, fromAddress: from };
    if (transport === "postmark") {
      if (token) base.postmarkToken = token;
      return base;
    }
    base.smtpHost = host;
    base.smtpPort = Number(port);
    base.smtpSecurity = security;
    base.smtpUsername = username;
    if (password) base.smtpPassword = password;
    return base;
  }

  function run(
    action: () => Promise<MailSettingsView | { to: string }>,
    done: (result: MailSettingsView | { to: string }) => string,
  ) {
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await action();
        if ("status" in result) setView(result);
        setStatus({ kind: "ok", message: done(result) });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "That did not work.",
        });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        {/* The page heading already says what this screen is for, so the card
            says the one thing it does not: which transport to pick. */}
        <CardTitle>Transport</CardTitle>
        <CardDescription>
          SMTP works anywhere, including an air-gapped network. Postmark is what
          the hosted deployments use.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MailStatusLine view={view} />

        <FormField label="Transport">
          <Select
            value={transport}
            onChange={(e) =>
              setTransport(e.target.value as MailSettingsInput["transport"])
            }
          >
            <option value="smtp">SMTP relay</option>
            <option value="postmark">Postmark</option>
          </Select>
        </FormField>

        <FormField
          label="From address"
          hint="The envelope sender, for example Specboards &lt;no-reply@example.com&gt;. Your relay has to be willing to send as it."
        >
          <Input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="Specboards <no-reply@example.com>"
          />
        </FormField>

        {transport === "smtp" ? (
          <>
            <FormField label="Host">
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.example.com"
              />
            </FormField>
            <div className="flex gap-3">
              <FormField label="Port" className="w-28">
                <Input
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </FormField>
              <FormField
                label="Security"
                className="flex-1"
                hint="STARTTLS is the usual choice on 587; implicit TLS on 465."
              >
                <Select
                  value={security}
                  onChange={(e) => setSecurity(e.target.value as SmtpSecurity)}
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">Implicit TLS</option>
                  <option value="none">None</option>
                </Select>
              </FormField>
            </div>
            <FormField
              label="Username"
              hint="Leave blank for a relay that does not authenticate."
            >
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </FormField>
            <FormField
              label="Password"
              hint={
                saved?.hasSmtpPassword
                  ? "A password is saved. Leave this blank to keep it."
                  : undefined
              }
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={saved?.hasSmtpPassword ? "••••••••" : ""}
              />
            </FormField>
          </>
        ) : (
          <FormField
            label="Server token"
            hint={
              saved?.hasPostmarkToken
                ? "A token is saved. Leave this blank to keep it."
                : "The Postmark server API token."
            }
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={saved?.hasPostmarkToken ? "••••••••" : ""}
            />
          </FormField>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => saveMailSettings(input()),
                () => "Saved.",
              )
            }
          >
            Save
          </Button>
          {/* Deliberately usable before saving. An admin who has to save a
              wrong password to find out it is wrong has already replaced a
              working configuration with a broken one. */}
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                () => sendTestEmail(input()),
                (r) => `Sent a test to ${"to" in r ? r.to : "you"}.`,
              )
            }
          >
            Send a test email
          </Button>
          {saved ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                run(
                  () => clearMailSettings(),
                  () => "Cleared. Mail falls back to the environment.",
                )
              }
            >
              Clear
            </Button>
          ) : null}
        </div>

        <StatusLine status={status} />

        {/* The one interaction worth warning about up front rather than
            leaving somebody to discover. See isEmailConfigured in email.ts. */}
        {!view.status.configured ? (
          <p className="text-xs text-muted-foreground">
            While no transport is configured, new sign-ups on a self-hosted
            instance skip email verification, because the link could not be
            delivered. Configuring mail here restores that requirement the next
            time the app restarts.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** What is actually in force, and where it came from. */
function MailStatusLine({ view }: { view: MailSettingsView }) {
  const { configured, transport, from, source } = view.status;
  if (!configured) {
    return (
      <p role="status" className="text-sm text-destructive">
        No mail transport is configured. Verification links, invitations and
        notifications are being dropped.
      </p>
    );
  }
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Sending through <strong>{transport === "smtp" ? "SMTP" : "Postmark"}</strong>{" "}
      as <strong>{from}</strong>
      {source === "env"
        ? ", configured by the environment rather than here."
        : "."}
    </p>
  );
}
