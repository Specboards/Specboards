"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import {
  AuthRequiredError,
  createWorkspace,
  WorkspaceSlugTakenError,
} from "@/lib/api-client";
import { slugifyOrg } from "@/lib/org-path";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** First-user onboarding: name the organization. Creates it via /api/v1. */
export function SetupForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  // `null` = slug is auto-derived from the name; a string = an explicit override
  // the user chose (revealed after a collision warning, or via "Customize URL").
  const [slug, setSlug] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const slugInputRef = useRef<HTMLInputElement>(null);

  const previewSlug = slug ?? slugifyOrg(name);
  const showSlugField = slug !== null;

  function customizeSlug() {
    setSlug(previewSlug);
    queueMicrotask(() => slugInputRef.current?.focus());
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const seedSampleData = data.get("start") === "sample";
    const submittedName = name.trim();

    startTransition(async () => {
      setError(null);
      setWarning(null);
      try {
        await createWorkspace(submittedName, seedSampleData, slug ?? undefined);
        // Root resolves the just-created org and forwards to /{org}/all/backlog.
        router.push("/");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in?from=/setup");
          return;
        }
        if (err instanceof WorkspaceSlugTakenError) {
          // Surface the conflict and let the user pick a different URL — prefill
          // the slug field with the server's free suggestion when offered.
          setSlug(err.suggestion ?? previewSlug);
          setWarning(err.message);
          queueMicrotask(() => slugInputRef.current?.focus());
          return;
        }
        setError(err instanceof Error ? err.message : "Setup failed.");
      }
    });
  }

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle>Set up your organization</CardTitle>
        <CardDescription>
          You're the first member, so you'll be the admin. Name your
          organization to get started.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Organization name
            </span>
            <Input
              name="name"
              placeholder="Acme Inc."
              maxLength={80}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {previewSlug && !showSlugField ? (
              <span className="block text-xs text-muted-foreground">
                Your URL: <code>/{previewSlug}</code>{" "}
                <button
                  type="button"
                  onClick={customizeSlug}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Customize
                </button>
              </span>
            ) : null}
          </label>

          {showSlugField ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Organization URL
              </span>
              <Input
                ref={slugInputRef}
                name="slug"
                placeholder="acme"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={slug ?? ""}
                onChange={(e) => setSlug(slugifyOrg(e.target.value))}
              />
              <span className="block text-xs text-muted-foreground">
                This is your space at <code>/{slug || "…"}</code>.
              </span>
            </label>
          ) : null}

          {warning ? (
            <p className="rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-600 dark:text-amber-500">
              {warning}
            </p>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              How should we start?
            </legend>
            <label className="flex items-start gap-2 rounded-md border p-2.5 text-sm has-[:checked]:border-foreground">
              <input
                type="radio"
                name="start"
                value="sample"
                defaultChecked
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Explore with sample data</span>
                <span className="block text-xs text-muted-foreground">
                  A starter board so you can try it out right away.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border p-2.5 text-sm has-[:checked]:border-foreground">
              <input type="radio" name="start" value="empty" className="mt-0.5" />
              <span>
                <span className="font-medium">Start empty</span>
                <span className="block text-xs text-muted-foreground">
                  A clean slate — connect a GitHub repo to import your specs.
                </span>
              </span>
            </label>
          </fieldset>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "…" : "Create organization"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
