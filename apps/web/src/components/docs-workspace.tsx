"use client";

import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthRequiredError,
  createDocPage,
  deleteDocPage,
  patchDocPage,
} from "@/lib/api-client";
import type { DocArea, DocPageRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";

/**
 * Folder-and-page workspace for a Specboard-held doc area (Strategy, and
 * Research / Architecture in `local` mode): a page tree on the left, a
 * rich-text Markdown editor on the right. Content autosaves with the same
 * debounce pattern as the item Details editor. The component owns its page
 * list after mount; mutations update it from API responses.
 */
export function DocsWorkspace({
  productId,
  area,
  initialPages,
  canEdit,
  starterTitles = [],
  emptyHint,
}: {
  productId: string;
  area: DocArea;
  initialPages: DocPageRecord[];
  canEdit: boolean;
  /** Offered as one-click starter pages when the area is empty. */
  starterTitles?: string[];
  /** One-line empty-state description of what belongs here. */
  emptyHint?: string;
}) {
  const [pages, setPages] = useState<DocPageRecord[]>(initialPages);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialPages.find((p) => p.kind === "page")?.id ?? null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{
    kind: "page" | "folder";
    parentId: string | null;
    title: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = pages.find((p) => p.id === selectedId) ?? null;

  function fail(err: unknown, fallback: string) {
    if (err instanceof AuthRequiredError) {
      window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  async function submitDraft() {
    if (!draft || !draft.title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const page = await createDocPage({
        productId,
        area,
        parentId: draft.parentId,
        kind: draft.kind,
        title: draft.title,
      });
      setPages((prev) => [...prev, page]);
      if (page.kind === "page") setSelectedId(page.id);
      setDraft(null);
    } catch (err) {
      fail(err, "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createStarters() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created: DocPageRecord[] = [];
      for (const title of starterTitles) {
        created.push(await createDocPage({ productId, area, title }));
      }
      setPages((prev) => [...prev, ...created]);
      if (created[0]) setSelectedId(created[0].id);
    } catch (err) {
      fail(err, "Create failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rename(page: DocPageRecord, title: string) {
    if (!title.trim() || title.trim() === page.title) return;
    try {
      const updated = await patchDocPage(page.id, { title });
      setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, ...updated } : p)));
    } catch (err) {
      fail(err, "Rename failed.");
    }
  }

  async function remove(page: DocPageRecord) {
    const label = page.kind === "folder" ? "folder and everything in it" : "page";
    if (!window.confirm(`Delete "${page.title}"? This removes the ${label}.`)) return;
    try {
      await deleteDocPage(page.id);
      setPages((prev) => {
        const doomed = new Set([page.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const p of prev) {
            if (p.parentId && doomed.has(p.parentId) && !doomed.has(p.id)) {
              doomed.add(p.id);
              grew = true;
            }
          }
        }
        const next = prev.filter((p) => !doomed.has(p.id));
        if (selectedId && doomed.has(selectedId)) {
          setSelectedId(next.find((p) => p.kind === "page")?.id ?? null);
        }
        return next;
      });
    } catch (err) {
      fail(err, "Delete failed.");
    }
  }

  function childrenOf(parentId: string | null): DocPageRecord[] {
    return pages
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  }

  function renderTree(parentId: string | null, depth: number) {
    return childrenOf(parentId).map((node) => (
      <TreeRow
        key={node.id}
        node={node}
        depth={depth}
        selected={selectedId === node.id}
        isCollapsed={collapsed.has(node.id)}
        canEdit={canEdit}
        onSelect={() => {
          if (node.kind === "folder") {
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            });
          } else {
            setSelectedId(node.id);
          }
        }}
        onNewPageInside={() => setDraft({ kind: "page", parentId: node.id, title: "" })}
        onRename={(title) => void rename(node, title)}
        onDelete={() => void remove(node)}
      >
        {node.kind === "folder" && !collapsed.has(node.id)
          ? renderTree(node.id, depth + 1)
          : null}
      </TreeRow>
    ));
  }

  if (pages.length === 0 && !draft) {
    return (
      <div className="mx-auto max-w-md space-y-3 py-16 text-center">
        <p className="text-sm font-medium">No pages yet</p>
        {emptyHint ? <p className="text-sm text-muted-foreground">{emptyHint}</p> : null}
        {canEdit ? (
          <div className="flex justify-center gap-2 pt-1">
            {starterTitles.length > 0 ? (
              <Button onClick={() => void createStarters()} disabled={busy}>
                {busy ? "Creating…" : "Create starter pages"}
              </Button>
            ) : null}
            <Button
              variant={starterTitles.length > 0 ? "secondary" : "default"}
              onClick={() => setDraft({ kind: "page", parentId: null, title: "" })}
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden />
              New page
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <div className="w-64 shrink-0 space-y-2">
        {canEdit ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ kind: "page", parentId: null, title: "" })}
            >
              <FilePlus className="mr-1 h-4 w-4" aria-hidden />
              Page
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ kind: "folder", parentId: null, title: "" })}
            >
              <FolderPlus className="mr-1 h-4 w-4" aria-hidden />
              Folder
            </Button>
          </div>
        ) : null}
        <div className="space-y-0.5">{renderTree(null, 0)}</div>
        {draft ? (
          <form
            className="flex items-center gap-1 pl-1"
            onSubmit={(e) => {
              e.preventDefault();
              void submitDraft();
            }}
          >
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
              placeholder={draft.kind === "folder" ? "Folder name" : "Page title"}
              className="h-7 text-sm"
              aria-label={draft.kind === "folder" ? "New folder name" : "New page title"}
            />
          </form>
        ) : null}
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
      </div>

      <div className="min-w-0 flex-1">
        {selected ? (
          <PageEditor key={selected.id} page={selected} canEdit={canEdit} />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Select a page, or create one.
          </p>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  isCollapsed,
  canEdit,
  onSelect,
  onNewPageInside,
  onRename,
  onDelete,
  children,
}: {
  node: DocPageRecord;
  depth: number;
  selected: boolean;
  isCollapsed: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onNewPageInside: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const isFolder = node.kind === "folder";
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md py-1 pr-1 text-sm",
          selected
            ? "bg-secondary font-medium text-secondary-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {editing ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(title);
              setEditing(false);
            }}
          >
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                onRename(title);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTitle(node.title);
                  setEditing(false);
                }
              }}
              className="h-6 text-sm"
              aria-label="Rename"
            />
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={onSelect}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {isFolder ? (
                <>
                  <Chevron className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <Folder className="h-4 w-4 shrink-0" aria-hidden />
                </>
              ) : (
                <FileText className="ml-[18px] h-4 w-4 shrink-0" aria-hidden />
              )}
              <span className="truncate">{node.title}</span>
            </button>
            {canEdit ? (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {isFolder ? (
                  <button
                    type="button"
                    onClick={onNewPageInside}
                    className="rounded p-0.5 hover:bg-background"
                    aria-label={`New page in ${node.title}`}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded p-0.5 hover:bg-background"
                  aria-label={`Rename ${node.title}`}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="rounded p-0.5 hover:bg-background"
                  aria-label={`Delete ${node.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ) : null}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The editor pane for one page. Keyed by page id in the parent, so switching
 * pages remounts with fresh seed content; within a page's lifetime the editor
 * is never remounted (see feature-details-editor for the race this avoids).
 */
function PageEditor({ page, canEdit }: { page: DocPageRecord; canEdit: boolean }) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const savedRef = useRef(page.content);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(value: string) {
    if (value === savedRef.current) return;
    if (inFlightRef.current) {
      pendingRef.current = value;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    setError(null);
    try {
      await patchDocPage(page.id, { content: value });
      savedRef.current = value;
      setStatus("saved");
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current !== null) {
        const next = pendingRef.current;
        pendingRef.current = null;
        void save(next);
      }
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">{page.title}</h2>
      {canEdit ? (
        <>
          <MarkdownEditor
            name="content"
            defaultValue={page.content}
            placeholder="Start writing…"
            minHeightClass="min-h-[24rem]"
            onChange={(markdown) => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              debounceRef.current = setTimeout(() => void save(markdown), 700);
            }}
          />
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <p
              className="h-4 text-[11px] text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
            </p>
          )}
        </>
      ) : (
        <MarkdownEditor
          name="content"
          defaultValue={page.content}
          disabled
          minHeightClass="min-h-[24rem]"
        />
      )}
    </div>
  );
}
