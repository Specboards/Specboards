"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveManualGithubApp } from "@/lib/api-client/repositories";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { githubAppCreateUrl } from "@/lib/github-app-create-url";

/**
 * Getting a deployment connected to GitHub in the first place.
 *
 * Which card an admin sees is decided by the manager, and the two cases are
 * genuinely different products. A self-hosted deployment creates its own
 * GitHub App, either through the one-click manifest flow or, when GitHub
 * cannot reach this origin to deliver webhooks, by filling the credentials in
 * by hand. A hosted tenant never creates one: the App is shared and Specboards
 * owns it, so the only useful action is to ask us.
 *
 * Everything here is pre-connection. Once an App exists, the flows that use it
 * live in `connect` and `repo-settings`.
 */

/**
 * A value to copy into GitHub, deliberately NOT shaped like an input.
 *
 * These were bordered boxes, which read as disabled text fields: the setup card
 * looked like ten form fields of which seven were broken, burying the three the
 * operator actually fills in. They are reference material, so they are styled
 * as reference material and carry a copy button, which is the only thing anyone
 * wants to do with them.
 */
function SettingRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard can be refused (permissions, insecure context). The value is
        // selectable text either way, so say nothing rather than raise an error
        // about a convenience.
      },
    );
  }

  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-40 shrink-0 text-2xs text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 break-all font-mono text-2xs text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The manual path: the operator creates the App on GitHub themselves and pastes
 * its credentials here.
 *
 * This is the only path that works for an instance GitHub cannot reach, which
 * is most on-prem deployments. GitHub validates the manifest's webhook URL for
 * public reachability and refuses to create the App when it fails, so the
 * one-click flow is unavailable there by construction, not by configuration.
 *
 * The form asks only for what cannot be derived. The App's slug and client id
 * come back from `GET /app` when the server verifies the credentials, so every
 * field here is one GitHub has no way to tell us.
 */
function ManualGitHubAppForm({
  origin,
  originIsPublic,
  onCancel,
}: {
  origin: string;
  originIsPublic: boolean;
  onCancel: (() => void) | null;
}) {
  const router = useRouter();
  const [org, setOrg] = useState("");
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // GitHub keeps App creation under a different URL per owner, and finding it
  // by hand means five clicks through two settings areas that look alike
  // (an org's "Developer settings" is not the one under your avatar). Building
  // the link from the owner the operator types removes that entirely, and the
  // query parameters carry every field and permission across with it.
  const trimmedOrg = org.trim();
  const createUrl = githubAppCreateUrl({
    org: trimmedOrg,
    origin,
    name: trimmedOrg ? `Specboards (${trimmedOrg})` : "Specboards",
    webhookActive: originIsPublic,
  });

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      setError(null);
      try {
        await saveManualGithubApp({
          appId: appId.trim(),
          privateKey,
          clientSecret: clientSecret.trim(),
          webhookSecret: webhookSecret.trim(),
        });
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't save the GitHub credentials.",
        );
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          GitHub organization <span className="font-normal">(optional)</span>
        </span>
        <Input
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          placeholder="your-org"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={pending}
        />
        <span className="block text-xs text-muted-foreground">
          Where the app should live. Leave blank for your personal account.
        </span>
      </label>

      {/* Collapsible, open by default. First time through it is the whole
          point of the card; coming back to paste a regenerated key, it is a
          wall of instructions between the operator and the three fields. */}
      <details open className="rounded-md border border-input">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
          On GitHub: create the app
        </summary>
        <ol className="space-y-3 border-t border-input p-3 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">
              1. Open the prefilled New GitHub App page.
            </span>{" "}
            <a
              href={createUrl}
              target="_blank"
              rel="noreferrer"
              className="text-link underline underline-offset-4"
            >
              Create the app on GitHub
            </a>
            <span className="mt-1 block">
              This link carries every setting below with it, including the
              permissions. GitHub may ask you to re-enter your password or 2FA
              first.
            </span>
            <span className="mt-1 block">
              Two pages in an organization&apos;s settings are both called
              &ldquo;GitHub Apps&rdquo;, and only one of them is this. The app
              you create appears under{" "}
              <strong className="text-foreground">Developer settings</strong>,
              at the very bottom of the sidebar. The{" "}
              <strong className="text-foreground">Installed GitHub Apps</strong>{" "}
              page higher up lists apps installed <em>on</em> the organization,
              and yours will not appear there until step 4.
            </span>
          </li>

          <li>
            {/* Shown to be CONFIRMED, not typed. These are GitHub's parameter
              names on our side of the link, so a rename upstream would stop
              prefilling one field without any error. Listing the values means
              that shows up as a visible mismatch here rather than as an
              install that fails later for no stated reason. */}
            <span className="font-medium text-foreground">
              2. Check the page matches this.
            </span>{" "}
            The link has already set it. Everything not listed can stay as
            GitHub sets it.
            <div className="mt-2 space-y-2">
              <SettingRow
                label="GitHub App name"
                value={trimmedOrg ? `Specboards (${trimmedOrg})` : "Specboards"}
              />
              <SettingRow label="Homepage URL" value={origin} />
              <SettingRow
                label="Callback URL"
                value={`${origin}/api/v1/github/oauth/callback`}
              />
              <SettingRow
                label="Setup URL"
                value={`${origin}/api/v1/github/setup`}
              />
              <SettingRow label="Redirect on update" value="Ticked" />
              <SettingRow
                label="Webhook: Active"
                value={
                  originIsPublic ? "Ticked" : "Unticked (see the note below)"
                }
              />
              <SettingRow
                label="Where can this app be installed?"
                value="Only on this account"
              />
              <SettingRow
                label="Repository permissions"
                value="Administration: Read and write · Contents: Read and write · Issues: Read-only · Metadata: Read-only · Pull requests: Read and write"
              />
              <SettingRow
                label="Organization permissions"
                value="Members: Read-only"
              />
            </div>
            <span className="mt-1 block">
              The name has to be unique across all of GitHub, so change it if
              GitHub says it is taken. Members is the permission most often
              missed when this is done by hand: without it Specboards cannot
              check that whoever installs the app administers the account, and
              every organization install fails at the last step.
            </span>
          </li>

          <li>
            <span className="font-medium text-foreground">
              3. Create it, then collect three things.
            </span>
            <span className="block">
              On the app&apos;s page after creating it: the{" "}
              <strong className="text-foreground">App ID</strong> is shown near
              the top. Press{" "}
              <strong className="text-foreground">
                Generate a new client secret
              </strong>{" "}
              and copy it now, because GitHub shows it once. Scroll down and
              press{" "}
              <strong className="text-foreground">
                Generate a private key
              </strong>
              , which downloads a <code>.pem</code> file. Paste all three below.
            </span>
          </li>

          <li>
            <span className="font-medium text-foreground">
              4. Install the app on your account or organization.
            </span>{" "}
            Use <em>Install App</em> in the left sidebar of the app&apos;s
            settings. GitHub requires the private key to exist before it will
            let you install.
            <span className="mt-1 block">
              Once installed, it shows up on the <em>Installed GitHub Apps</em>{" "}
              page too. Before that it exists only under Developer settings,
              which is why a newly created app looks missing if you go looking
              for it in the wrong list.
            </span>
          </li>
          <li>
            <span className="font-medium text-foreground">
              {originIsPublic ? "5. Set up the webhook." : "About the webhook."}
            </span>{" "}
            {originIsPublic ? (
              <>
                GitHub can reach this instance, so the link armed the webhook
                and set these already. The secret is the one thing it cannot
                carry: put the same value here and on GitHub.
                <div className="mt-2 space-y-1">
                  <SettingRow
                    label="Webhook URL"
                    value={`${origin}/api/webhooks/github`}
                  />
                  <SettingRow
                    label="Subscribe to events"
                    value="Push · Pull request · Issues"
                  />
                </div>
              </>
            ) : (
              <>
                This instance is at <code>{origin}</code>, which GitHub cannot
                reach, so the link left the webhook off. Specs written here
                still reach GitHub, because that is an outbound call. Changes
                pushed on GitHub will not flow back until this instance has a
                public HTTPS address.
              </>
            )}
          </li>
        </ol>
      </details>

      <div className="space-y-1">
        <h4 className="text-xs font-medium text-foreground">
          Back here: paste {originIsPublic ? "four things" : "three things"}{" "}
          from the app
        </h4>
        <p className="text-2xs text-muted-foreground">
          Specboards signs in as the app to check these before saving, so a
          wrong value is refused now rather than at your first sync.
        </p>
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          App ID
        </span>
        <Input
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="123456"
          inputMode="numeric"
          disabled={pending}
          required
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Private key
        </span>
        <textarea
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…"}
          rows={5}
          disabled={pending}
          required
          spellCheck={false}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
        />
        <span className="block text-xs text-muted-foreground">
          Generate one on the App&apos;s page and paste the whole .pem file. It
          is encrypted before it is stored and never sent back to the browser.
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Client secret
        </span>
        <Input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={pending}
          required
          autoComplete="off"
        />
        <span className="block text-xs text-muted-foreground">
          Used to check that whoever installs the App administers the account
          they install it on.
        </span>
      </label>

      {/* Only shown when a webhook could actually be delivered. On an
          unreachable origin this field is not merely optional, it is inert:
          nothing will ever arrive to verify against it. Offering it there is
          asking for a value that cannot matter, which is how an operator ends
          up wondering what they got wrong. */}
      {originIsPublic ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Webhook secret
          </span>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            disabled={pending}
            autoComplete="off"
          />
          <span className="block text-xs text-muted-foreground">
            The same secret you set on the app&apos;s webhook. Without it pushes
            on GitHub will not reconcile back onto the board.
          </span>
        </label>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Save credentials"}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Shown to an admin before any GitHub App exists.
 *
 * When GitHub can reach this deployment, the one-click manifest flow leads and
 * the manual path sits behind a disclosure. When it cannot, the manual path is
 * the whole card: offering one-click there would send the operator to a GitHub
 * error page, which is exactly what used to happen.
 */
export function SetupGitHubCard({
  origin,
  originIsPublic,
}: {
  origin: string;
  originIsPublic: boolean;
}) {
  const [manualOpen, setManualOpen] = useState(false);

  if (!originIsPublic) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect Specboards to GitHub</CardTitle>
          <CardDescription>
            This instance is at <code>{origin}</code>, which GitHub cannot
            reach, so GitHub will not create an app for it automatically. Create
            the app yourself and paste its credentials here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ManualGitHubAppForm
            origin={origin}
            originIsPublic={originIsPublic}
            onCancel={null}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Specboards to GitHub</CardTitle>
        <CardDescription>
          We&apos;ll create a GitHub App on your account or organization in one
          click, and you confirm on GitHub. After that you can install it on
          repositories and sync specs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action="/api/v1/github/app/create"
          method="get"
          className="space-y-4"
        >
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              GitHub organization{" "}
              <span className="font-normal">(optional)</span>
            </span>
            <Input
              name="org"
              placeholder="your-org"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="block text-xs text-muted-foreground">
              Leave blank to create it on your personal GitHub account.
            </span>
          </label>
          <Button type="submit">Set up GitHub App</Button>
        </form>

        {manualOpen ? (
          <div className="border-t border-input pt-4">
            <ManualGitHubAppForm
              origin={origin}
              originIsPublic={originIsPublic}
              onCancel={() => setManualOpen(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="text-xs text-muted-foreground underline"
          >
            Or set the app up manually
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Hosted (multi-tenant) deployment with no GitHub App credentials configured.
 * Tenants don't create their own App here — it's a shared App Specboards owns —
 * so the right action is to reach support, not run the manifest flow.
 */
export function HostedNotConfiguredCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub isn&apos;t available yet</CardTitle>
        <CardDescription>
          GitHub is managed by Specboards on the hosted plan. If you don&apos;t
          see the option to install it, please contact support and we&apos;ll
          get you connected.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
