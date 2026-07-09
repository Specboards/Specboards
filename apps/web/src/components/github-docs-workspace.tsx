"use client";

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthRequiredError,
  deleteGithubDocFile,
  renameGithubDocFile,
  saveGithubDocFile,
} from "@/lib/api-client";
import type { DocArea } from "@/lib/store/types";
import { cn } from "@/lib/utils";

export interface GithubDocFileView {
  path: string;
  content: string;
  /** Sha at load/last save; sent with writes as the concurrent-edit guard. */
  blobSha: string;
}

/**
 * File workspace for a GitHub-backed doc area: the repo's Markdown files on
 * the left (folders derived from paths), the rich-text editor on the right.
 * Saving is explicit (a Save button) because each save is one commit to the
 * repo's default branch; autosave would spam the git history. New pages
 * commit an initial file the same way; rename and delete are commits too.
 * Every write carries the file's loaded sha, so two people editing the same
 * page get a conflict error instead of silently losing the earlier save.
 */
export function GithubDocsWorkspace({
  productId,
  area,
  repoFullName,
  repoUrl,
  initialFiles,
  canEdit,
}: {
  productId: string;
  area: DocArea;
  repoFullName: string;
  repoUrl: string;
  initialFiles: GithubDocFileView[];
  canEdit: boolean;
}) {
  const [files, setFiles] = useState<GithubDocFileView[]>(initialFiles);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialFiles[0]?.path ?? null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ folder: string; title: string } | null>(null);
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "create" | "rename" | "delete" | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const selectedDirty = selected ? dirty[selected.path] !== undefined : false;

  function fail(err: unknown, fallback: string) {
    if (err instanceof AuthRequiredError) {
      window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  function select(path: string) {
    if (
      selected &&
      dirty[selected.path] !== undefined &&
      path !== selected.path &&
      !window.confirm("Discard unsaved changes to this page?")
    ) {
      return;
    }
    if (selected && dirty[selected.path] !== undefined) {
      setDirty((prev) => {
        const next = { ...prev };
        delete next[selected.path];
        return next;
      });
    }
    setSelectedPath(path);
    setSavedPath(null);
    setRenameTo(null);
    setError(null);
  }

  async function save() {
    if (!selected || busy) return;
    const content = dirty[selected.path];
    if (content === undefined) return;
    setBusy("save");
    setError(null);
    try {
      const { blobSha } = await saveGithubDocFile({
        productId,
        area,
        path: selected.path,
        content,
        blobSha: selected.blobSha,
      });
      setFiles((prev) =>
        prev.map((f) => (f.path === selected.path ? { ...f, content, blobSha } : f)),
      );
      setDirty((prev) => {
        const next = { ...prev };
        delete next[selected.path];
        return next;
      });
      setSavedPath(selected.path);
    } catch (err) {
      fail(err, "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  async function rename() {
    if (!selected || renameTo === null || busy) return;
    const toPath = renameTo.trim();
    if (!toPath || toPath === selected.path) {
      setRenameTo(null);
      return;
    }
    setBusy("rename");
    setError(null);
    try {
      const renamed = await renameGithubDocFile({
        productId,
        area,
        path: selected.path,
        toPath,
      });
      setFiles((prev) =>
        prev
          .filter((f) => f.path !== selected.path && f.path !== renamed.path)
          .concat({ path: renamed.path, content: renamed.content, blobSha: renamed.blobSha })
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
      setSelectedPath(renamed.path);
      setSavedPath(null);
      setRenameTo(null);
    } catch (err) {
      fail(err, "Rename failed.");
    } finally {
      setBusy(null);
    }
  }

  async function deletePage() {
    if (!selected || busy) return;
    if (!window.confirm(`Delete "${selected.path}" from the repository?`)) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteGithubDocFile({
        productId,
        area,
        path: selected.path,
        blobSha: selected.blobSha,
      });
      const remaining = files.filter((f) => f.path !== selected.path);
      setFiles(remaining);
      setDirty((prev) => {
        const next = { ...prev };
        delete next[selected.path];
        return next;
      });
      setSelectedPath(remaining[0]?.path ?? null);
      setSavedPath(null);
    } catch (err) {
      fail(err, "Delete failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createPage() {
    if (!draft || !draft.title.trim() || busy) return;
    const slug = draft.title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      setError("That title has no usable characters.");
      return;
    }
    const path = draft.folder ? `${draft.folder}/${slug}.md` : `${slug}.md`;
    if (files.some((f) => f.path === path)) {
      setError(`"${path}" already exists.`);
      return;
    }
    const content = `# ${draft.title.trim()}\n`;
    setBusy("create");
    setError(null);
    try {
      // blobSha null = "must not exist yet": creating a page never overwrites
      // a file someone pushed to the repo since this view loaded.
      const { blobSha } = await saveGithubDocFile({
        productId,
        area,
        path,
        content,
        blobSha: null,
      });
      setFiles((prev) =>
        [...prev, { path, content, blobSha }].sort((a, b) => a.path.localeCompare(b.path)),
      );
      setSelectedPath(path);
      setSavedPath(null);
      setDraft(null);
    } catch (err) {
      fail(err, "Create failed.");
    } finally {
      setBusy(null);
    }
  }

  // Folder tree derived from the flat path list.
  const root = buildTree(files.map((f) => f.path));

  function renderNodes(node: TreeNode, prefix: string, depth: number): React.ReactNode {
    const folders = [...node.folders.keys()].sort();
    return (
      <>
        {folders.map((name) => {
          const full = prefix ? `${prefix}/${name}` : name;
          const isCollapsed = collapsed.has(full);
          const Chevron = isCollapsed ? ChevronRight : ChevronDown;
          return (
            <div key={full}>
              <div
                className="group flex items-center gap-1 rounded-md py-1 pr-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                style={{ paddingLeft: `${depth * 14 + 4}px` }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(full)) next.delete(full);
                      else next.add(full);
                      return next;
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <Chevron className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <Folder className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{name}</span>
                </button>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setDraft({ folder: full, title: "" })}
                    className="hidden rounded p-0.5 group-hover:block hover:bg-background"
                    aria-label={`New page in ${name}`}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
              {isCollapsed
                ? null
                : renderNodes(node.folders.get(name)!, full, depth + 1)}
            </div>
          );
        })}
        {node.files.sort().map((name) => {
          const full = prefix ? `${prefix}/${name}` : name;
          const active = selectedPath === full;
          return (
            <button
              key={full}
              type="button"
              onClick={() => select(full)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md py-1 pr-1 text-left text-sm",
                active
                  ? "bg-secondary font-medium text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              style={{ paddingLeft: `${depth * 14 + 22}px` }}
            >
              <FileText className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{name.replace(/\.md$/i, "")}</span>
            </button>
          );
        })}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-link hover:underline"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          {repoFullName}
        </a>
      </div>
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="w-64 shrink-0 space-y-2">
          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ folder: "", title: "" })}
            >
              <FilePlus className="mr-1 h-4 w-4" aria-hidden />
              New page
            </Button>
          ) : null}
          <div className="space-y-0.5">{renderNodes(root, "", 0)}</div>
          {draft ? (
            <form
              className="space-y-1 pl-1"
              onSubmit={(e) => {
                e.preventDefault();
                void createPage();
              }}
            >
              {draft.folder ? (
                <p className="text-[11px] text-muted-foreground">in {draft.folder}/</p>
              ) : null}
              <Input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDraft(null);
                }}
                onBlur={() => {
                  if (!draft.title.trim()) setDraft(null);
                }}
                placeholder="Page title"
                className="h-7 text-sm"
                aria-label="New page title"
              />
            </form>
          ) : null}
          {files.length === 0 && !draft ? (
            <p className="px-1 text-xs text-muted-foreground">
              No Markdown files yet.{canEdit ? " Create the first page." : ""}
            </p>
          ) : null}
          {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
        </div>

        <div className="min-w-0 flex-1">
          {selected ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                {renameTo !== null ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename();
                    }}
                  >
                    <Input
                      autoFocus
                      value={renameTo}
                      onChange={(e) => setRenameTo(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenameTo(null);
                      }}
                      className="h-8 max-w-md text-sm"
                      aria-label="New file path"
                    />
                    <Button type="submit" size="sm" variant="secondary" disabled={busy !== null}>
                      {busy === "rename" ? "Renaming…" : "Rename"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRenameTo(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <h2 className="truncate text-lg font-semibold">
                    {selected.path.split("/").pop()?.replace(/\.md$/i, "")}
                  </h2>
                )}
                {canEdit ? (
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[11px] text-muted-foreground"
                      role="status"
                      aria-live="polite"
                    >
                      {busy === "save"
                        ? "Saving…"
                        : savedPath === selected.path && !selectedDirty
                          ? "Saved"
                          : selectedDirty
                            ? "Unsaved changes"
                            : ""}
                    </span>
                    {renameTo === null ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setRenameTo(selected.path)}
                          // Renames commit the saved content, so unsaved edits
                          // would be left behind; save first.
                          disabled={busy !== null || selectedDirty}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          title={selectedDirty ? "Save changes before renaming" : "Rename page"}
                          aria-label="Rename page"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deletePage()}
                          disabled={busy !== null}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
                          title="Delete page"
                          aria-label="Delete page"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      onClick={() => void save()}
                      disabled={busy !== null || !selectedDirty}
                    >
                      Save
                    </Button>
                  </div>
                ) : null}
              </div>
              <MarkdownEditor
                key={selected.path}
                name="content"
                defaultValue={selected.content}
                placeholder="Start writing…"
                disabled={!canEdit}
                minHeightClass="min-h-[24rem]"
                onChange={(markdown) => {
                  if (markdown === selected.content) {
                    // The editor's initial normalization pass (or an undo back
                    // to the saved state) is not an edit.
                    setDirty((prev) => {
                      const next = { ...prev };
                      delete next[selected.path];
                      return next;
                    });
                    return;
                  }
                  setDirty((prev) => ({ ...prev, [selected.path]: markdown }));
                  setSavedPath(null);
                }}
              />
            </div>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Select a page, or create one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface TreeNode {
  folders: Map<string, TreeNode>;
  files: string[];
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { folders: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { folders: new Map(), files: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    const file = segments[segments.length - 1];
    if (file) node.files.push(file);
  }
  return root;
}
