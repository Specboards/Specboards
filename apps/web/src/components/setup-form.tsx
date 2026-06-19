"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AuthRequiredError, createWorkspace } from "@/lib/api-client";
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

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const seedSampleData = data.get("start") === "sample";

    startTransition(async () => {
      setError(null);
      try {
        await createWorkspace(name, seedSampleData);
        // Root resolves the just-created org and forwards to /{org}/all/backlog.
        router.push("/");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in?from=/setup");
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
            <Input name="name" placeholder="Acme Inc." maxLength={80} required />
          </label>
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
