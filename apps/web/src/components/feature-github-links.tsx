"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { addGithubLink, removeGithubLink } from "@/lib/api-client/work-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { GithubLink, GithubLinkKind } from "@/lib/store/types";

const KIND_LABEL: Record<GithubLinkKind, string> = {
  pull_request: "Pull request",
  issue: "Issue",
  branch: "Branch",
};

/** Short label for a link, e.g. "PR #412", "Issue #12", "branch feat/x". */
function linkLabel(l: GithubLink): string {
  if (l.kind === "branch") return `branch ${l.branch}`;
  if (l.kind === "pull_request") return `PR #${l.number}`;
  return `Issue #${l.number}`;
}

/** Badge variant for a cached state. */
function stateVariant(
  state: string | null,
): "default" | "secondary" | "outline" {
  if (state === "merged") return "default";
  if (state === "open") return "secondary";
  return "outline";
}

/**
 * GitHub links editor for the feature detail sidebar / edit drawer. Shows the
 * item's own (direct) links plus links inherited from descendant specs (which
 * can only be edited on the spec that owns them).
 */
export function FeatureGithubLinks({
  specId,
  links,
  canEdit = true,
  repos = [],
}: {
  specId: string;
  links: GithubLink[];
  canEdit?: boolean;
  /** Connected repos to choose between; only offered when there's more than
   * one, since otherwise the repo is inferred from the item. */
  repos?: { owner: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<GithubLinkKind>("pull_request");
  const [error, setError] = useState<string | null>(null);
  // A DB-native card has no repo of its own, so in a multi-repo workspace the
  // server can't infer one; let the user say which. Single-repo workspaces
  // never see this control.
  const showRepoPicker = repos.length > 1;

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const repo = showRepoPicker
      ? String(data.get("repo") ?? "").trim() || undefined
      : undefined;
    const input =
      kind === "branch"
        ? { kind, branch: String(data.get("branch") ?? "").trim(), repo }
        : { kind, number: Number(data.get("number")), repo };
    if (kind === "branch" ? !input.branch : !input.number) {
      setError(kind === "branch" ? "Enter a branch name." : "Enter a number.");
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        await addGithubLink(specId, input);
        form.reset();
        toast.success("Linked");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setError(err instanceof Error ? err.message : "Could not add link.");
      }
    });
  }

  function onRemove(linkId: string) {
    startTransition(async () => {
      setError(null);
      try {
        await removeGithubLink(specId, linkId);
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setError(err instanceof Error ? err.message : "Could not remove link.");
      }
    });
  }

  const direct = links.filter((l) => !l.inherited);
  const inherited = links.filter((l) => l.inherited);

  return (
    <div className="space-y-3">
      <span className="text-xs font-medium text-muted-foreground">GitHub</span>

      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground">No GitHub links yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {direct.map((l) => (
            <li key={l.id} className="flex items-center gap-1.5 text-sm">
              <LinkRow link={l} />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => onRemove(l.id)}
                  disabled={pending}
                  aria-label={`Remove link ${linkLabel(l)}`}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
          {inherited.map((l) => (
            <li key={l.id} className="flex items-center gap-1.5 text-sm">
              <LinkRow link={l} />
              <span
                className="text-2xs text-muted-foreground"
                title={`Inherited from ${l.sourceTitle}`}
              >
                ↳ {l.sourceTitle}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <form onSubmit={onAdd} className="space-y-2">
          <Select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as GithubLinkKind)}
            className="h-8"
          >
            {(Object.keys(KIND_LABEL) as GithubLinkKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
          {showRepoPicker ? (
            <Select
              name="repo"
              aria-label="Repository"
              className="h-8"
              defaultValue=""
            >
              <option value="">Infer repository</option>
              {repos.map((r) => (
                <option
                  key={`${r.owner}/${r.name}`}
                  value={`${r.owner}/${r.name}`}
                >
                  {r.owner}/{r.name}
                </option>
              ))}
            </Select>
          ) : null}
          {kind === "branch" ? (
            <Input name="branch" placeholder="branch name" className="h-8" />
          ) : (
            <Input
              name="number"
              type="number"
              min={1}
              placeholder="number"
              className="h-8"
            />
          )}
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Add link"}
          </Button>
        </form>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function LinkRow({ link }: { link: GithubLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="flex flex-1 items-center gap-1.5 truncate hover:underline"
      title={link.title ?? link.url}
    >
      <span className="font-mono text-xs">{linkLabel(link)}</span>
      {link.state ? (
        <Badge variant={stateVariant(link.state)} size="sm">
          {link.state}
        </Badge>
      ) : null}
      {link.title ? (
        <span className="truncate text-muted-foreground">{link.title}</span>
      ) : null}
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}
