"use client";

import { ExternalLink, FileText, GitBranch } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthRequiredError, setDocSpace } from "@/lib/api-client";
import type { DocArea } from "@/lib/store/types";

/**
 * First-run chooser for where an area's docs live: link out to an external
 * repository (SharePoint, Box, ...), keep pages in Specboard, or back them
 * with a GitHub repo (a later slice; shown but not yet enabled). Rendered
 * until the team picks, and again when they choose "Change source".
 */
export function DocSpaceSetup({
  productId,
  area,
  areaLabel,
  onSaved,
  onCancel,
}: {
  productId: string;
  area: DocArea;
  areaLabel: string;
  /** Called with no args after the choice persists (parent refreshes). */
  onSaved: () => void;
  /** Present when a source already exists and this is a change, not setup. */
  onCancel?: () => void;
}) {
  const [externalUrl, setExternalUrl] = useState("");
  const [busy, setBusy] = useState<"external" | "local" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(mode: "external" | "local") {
    setBusy(mode);
    setError(null);
    try {
      await setDocSpace({
        productId,
        area,
        mode,
        externalUrl: mode === "external" ? externalUrl : null,
      });
      onSaved();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      setError(err instanceof Error ? err.message : "Save failed.");
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Where does your {areaLabel.toLowerCase()} live?</h2>
        <p className="text-sm text-muted-foreground">
          Choose once per product. You can change this later.
        </p>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <ExternalLink className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">Connect an external repository</p>
                <p className="text-sm text-muted-foreground">
                  Your team already keeps {areaLabel.toLowerCase()} in SharePoint, Box,
                  Confluence, or similar. Specboard links out to it.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="External repository URL"
                />
                <Button
                  onClick={() => void choose("external")}
                  disabled={busy !== null || !externalUrl.trim()}
                >
                  {busy === "external" ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">Keep it in Specboard</p>
                <p className="text-sm text-muted-foreground">
                  Write and organize pages right here, with folders and rich text
                  editing.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => void choose("local")}
                disabled={busy !== null}
              >
                {busy === "local" ? "Setting up…" : "Use Specboard"}
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-dashed p-4 opacity-70">
          <div className="flex items-start gap-3">
            <GitBranch className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium">
                Create a GitHub repository
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  Soon
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                Store docs as Markdown files in a repo your team owns. Edit them here;
                saves commit back to the repo.
              </p>
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
