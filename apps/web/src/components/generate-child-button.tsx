"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import type { StatusWorkflow } from "@specboards/core";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AuthRequiredError,
  createWorkItem,
  suggestBreakdown,
} from "@/lib/api-client";
import { pluralLevel, statusLabel } from "@/lib/feature-helpers";
import type { WorkspaceMember } from "@/lib/workspace";

/**
 * A set of children the assistant proposed, and what the reviewer has decided
 * about each.
 *
 * The tick is per item and starts on, because the common outcome is "yes,
 * except that one": a reviewer who agrees with six of seven should uncheck one,
 * not check six. Bulk accept and reject both operate on the ticks rather than
 * being separate actions, so there is one notion of what is being created.
 */
interface Suggestion {
  prose: string;
  items: { title: string; details: string; taken: boolean }[];
}

/**
 * "Generate {child}" action on a parent item: create child items one level down
 * (Initiative → Epic, Epic → Feature, Feature → Work item) with the parent
 * pre-selected, either by typing them or by asking the assistant to propose the
 * set. The drawer stays open after each create so several can be added in a row.
 *
 * ── Why the assistant lives behind this button rather than in the panel ─────
 * The panel answers questions about an item; this creates items. Putting a
 * breakdown in the conversation would mean proposing work in one place and
 * creating it in another, and the proposal would then need its own record of
 * which children it had already produced. Here the two are the same act, and
 * the manual form underneath is the fallback for every case the model gets
 * wrong: a reviewer can take four of its six suggestions and type the fifth
 * themselves without leaving the drawer.
 *
 * ── Why accepted suggestions go through the same create as typing one ──────
 * `createWorkItem`, once per ticked item, exactly as the form below does. An
 * accepted suggestion is a card a person agreed to, so it must be
 * indistinguishable from a card they typed: same defaults, same validation,
 * same history. A bulk endpoint would be faster and would be a second create
 * path with its own edge cases.
 */
export function GenerateChildButton({
  parentSpecId,
  parentTitle,
  childLevelKey,
  childLevelLabel,
  productId,
  workflow,
  members = [],
}: {
  parentSpecId: string;
  parentTitle: string;
  childLevelKey: string;
  childLevelLabel: string;
  /** Product the children inherit from the parent. */
  productId: string | null;
  workflow: StatusWorkflow;
  members?: WorkspaceMember[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** The proposed set, once asked for. Null before, and after it is cleared. */
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [asking, setAsking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const defaultStatus = workflow.statuses[0] ?? "backlog";
  const label = childLevelLabel.toLowerCase();
  const plural = pluralLevel(label);
  const takenCount = suggestion?.items.filter((i) => i.taken).length ?? 0;

  /** Ask the model for a decomposition. Nothing is created by this. */
  async function suggest() {
    if (asking) return;
    setAsking(true);
    setError(null);
    setModelError(null);
    try {
      const outcome = await suggestBreakdown(parentSpecId);
      if (!outcome.ok) {
        setModelError(outcome.error.message);
        return;
      }
      setSuggestion({
        prose: outcome.prose,
        items: outcome.children.map((c) => ({ ...c, taken: true })),
      });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      setModelError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setAsking(false);
    }
  }

  /**
   * Create everything still ticked, one at a time through the ordinary path.
   *
   * Sequential rather than concurrent, because these land in a backlog in the
   * order the reviewer read them and firing them together would shuffle that.
   * A failure part-way through keeps what succeeded and says how far it got: an
   * all-or-nothing rollback would throw away good cards to tidy up after one
   * bad one, and there is no transaction spanning them to make it honest.
   */
  async function createTicked() {
    if (!suggestion || creating) return;
    const wanted = suggestion.items.filter((i) => i.taken);
    if (wanted.length === 0) return;
    setCreating(true);
    setError(null);
    let made = 0;
    try {
      for (const item of wanted) {
        await createWorkItem({
          title: item.title,
          level: childLevelKey,
          parentSpecId,
          productId,
          status: defaultStatus,
          ...(item.details ? { details: item.details } : {}),
        });
        made++;
      }
      setSuggestion(null);
      toast.success(
        made === 1 ? `Added one ${label}.` : `Added ${made} ${plural}.`,
      );
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      setError(
        `${err instanceof Error ? err.message : "Create failed."} ` +
          `${made} of ${wanted.length} were added before this.`,
      );
      // What was created stays created, so drop those from the list rather than
      // leaving them ticked and inviting a second attempt that duplicates them.
      // Counted against the ticked ones, in order, since untaken items were
      // skipped and must survive.
      let done = made;
      setSuggestion({
        ...suggestion,
        items: suggestion.items.filter((i) => {
          if (i.taken && done > 0) {
            done--;
            return false;
          }
          return true;
        }),
      });
    } finally {
      setAdded((n) => n + made);
      setCreating(false);
      router.refresh();
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    const status = String(data.get("status") ?? defaultStatus) || defaultStatus;
    const assigneeId = String(data.get("assigneeId") ?? "") || null;
    startTransition(async () => {
      setError(null);
      try {
        await createWorkItem({
          title,
          level: childLevelKey,
          parentSpecId,
          productId,
          status,
          assigneeId,
        });
        setAdded((n) => n + 1);
        // Clear the form back to its defaults and refocus so the next child can
        // be typed straight away.
        form.reset();
        inputRef.current?.focus();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => {
          setAdded(0);
          setError(null);
          // A suggestion from a previous visit is stale: the children it was
          // told about have changed, which is the one thing it was asked to
          // take account of.
          setSuggestion(null);
          setModelError(null);
          setOpen(true);
        }}
      >
        <Plus className="size-3.5" />
        Generate {childLevelLabel}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Generate {label}</SheetTitle>
            <SheetDescription>
              New {plural} under “{parentTitle}”.
              {added > 0
                ? ` ${added} added.`
                : ""}
            </SheetDescription>
          </SheetHeader>
          {/* Asking is an affordance, not an open panel: most visits to this
              drawer are somebody who already knows what they want to add. */}
          {suggestion === null ? (
            <div className="space-y-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={suggest}
                disabled={asking}
                className="gap-1"
              >
                <Sparkles className="size-3.5" />
                {asking ? "Thinking…" : `Suggest ${plural}`}
              </Button>
              <p className="text-2xs text-muted-foreground">
                Runs on the model this workspace connected. Nothing is created
                until you accept it.
              </p>
              {modelError ? (
                <p className="text-xs text-destructive">{modelError}</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-link/40 bg-link/5 p-3">
              {suggestion.prose ? (
                <p className="text-xs text-muted-foreground">{suggestion.prose}</p>
              ) : null}

              {suggestion.items.length === 0 ? (
                // A considered "nothing to add" is a real answer: the model is
                // told to propose nothing when the breakdown already looks
                // complete. Reporting it as a failure would be a lie.
                <p className="text-xs text-muted-foreground">
                  Nothing suggested. Add {plural} below if you disagree.
                </p>
              ) : (
                <ul className="space-y-1">
                  {suggestion.items.map((item, i) => (
                    <li key={`${item.title}-${i}`}>
                      <button
                        type="button"
                        aria-pressed={item.taken}
                        onClick={() =>
                          setSuggestion({
                            ...suggestion,
                            items: suggestion.items.map((it, j) =>
                              j === i ? { ...it, taken: !it.taken } : it,
                            ),
                          })
                        }
                        className={`flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-muted ${
                          item.taken ? "" : "opacity-50"
                        }`}
                      >
                        <span className="mt-0.5">
                          <Checkbox checked={item.taken} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-medium">
                            {item.title}
                          </span>
                          {item.details ? (
                            <span className="block text-2xs text-muted-foreground">
                              {item.details}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {suggestion.items.length > 0 ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      onClick={createTicked}
                      disabled={creating || takenCount === 0}
                    >
                      {creating
                        ? "Adding…"
                        : takenCount === suggestion.items.length
                          ? `Add all ${takenCount}`
                          : `Add ${takenCount} of ${suggestion.items.length}`}
                    </Button>
                    {/* Bulk tick, because unticking six of seven by hand to
                        keep one is the case that makes people give up. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={creating}
                      onClick={() =>
                        setSuggestion({
                          ...suggestion,
                          items: suggestion.items.map((it) => ({
                            ...it,
                            taken: takenCount !== suggestion.items.length,
                          })),
                        })
                      }
                    >
                      {takenCount === suggestion.items.length
                        ? "Untick all"
                        : "Tick all"}
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={creating}
                  onClick={() => setSuggestion(null)}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}

          <form key="generate-child" onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Title
              </span>
              <Input ref={inputRef} name="title" autoFocus className="h-8" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Status
              </span>
              <Select name="status" defaultValue={defaultStatus} className="h-8">
                {workflow.statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s, workflow)}
                  </option>
                ))}
              </Select>
            </label>
            {members.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Assigned to
                </span>
                <Select name="assigneeId" defaultValue="" className="h-8">
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Adding…" : `Add ${label}`}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
