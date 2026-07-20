"use client";

import { useRef, useState } from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A member that can be @mentioned. */
export interface MentionCandidate {
  userId: string;
  name: string;
}

/** The active "@query" immediately before the caret, or null. */
function queryBeforeCaret(text: string, caret: number): string | null {
  const upto = text.slice(0, caret);
  // "@" at start or after whitespace, then non-space/non-@ chars up to caret.
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  return m ? m[1]! : null;
}

/** Which selected members are still referenced by an "@Name" token in `body`. */
function resolveMentioned(
  body: string,
  selected: Map<string, string>,
): string[] {
  const ids: string[] = [];
  for (const [userId, name] of selected) {
    if (body.includes(`@${name}`)) ids.push(userId);
  }
  return ids;
}

/**
 * A comment composer with lightweight @mention autocomplete: typing `@` filters
 * workspace members, and selecting one inserts `@Name` while recording the
 * member's id. The body stays plain text; mentions are reported structurally
 * (the picked members still referenced by an `@Name` token) via `onChange`, so
 * the server never has to guess who was meant from free text.
 */
export function MentionInput({
  members,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  rows = 3,
}: {
  members: MentionCandidate[];
  value: string;
  /** Reports the current text and the ids of members mentioned in it. */
  onChange: (value: string, mentionedUserIds: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Members the user explicitly picked (id -> name), used to resolve mentions
  // structurally rather than by matching arbitrary "@text".
  const selected = useRef(new Map<string, string>());
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const suggestions =
    query === null
      ? []
      : members
          .filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6);
  const open = suggestions.length > 0;

  function emit(next: string) {
    onChange(next, resolveMentioned(next, selected.current));
  }

  function refreshQuery(el: HTMLTextAreaElement) {
    const q = queryBeforeCaret(el.value, el.selectionStart ?? el.value.length);
    setQuery(q);
    setActive(0);
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    emit(e.target.value);
    refreshQuery(e.target);
  }

  function pick(member: MentionCandidate) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    // Replace the trailing "@query" with "@Name " (keep any preceding char).
    const replaced = before.replace(/@([^\s@]*)$/, `@${member.name} `);
    const next = replaced + after;
    selected.current.set(member.userId, member.name);
    setQuery(null);
    emit(next);
    // Restore focus + caret just after the inserted mention.
    requestAnimationFrame(() => {
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(suggestions[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery(null);
    }
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
        onClick={(e) => refreshQuery(e.currentTarget)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={rows}
      />
      {open ? (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {suggestions.map((m, i) => (
            <li key={m.userId}>
              <button
                type="button"
                // Keep focus in the textarea so the caret stays put.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  i === active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span
                  aria-hidden
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
                >
                  {m.name.trim()[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="truncate">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Render a plain-text comment body with `@Name` mentions highlighted, matching
 * against known member names (longest first, so "@Ann Lee" wins over "@Ann").
 */
export function renderCommentBody(
  body: string,
  memberNames: string[],
): React.ReactNode {
  const names = [...memberNames].sort((a, b) => b.length - a.length);
  const nodes: React.ReactNode[] = [];
  let rest = body;
  let key = 0;
  outer: while (rest.length > 0) {
    for (const name of names) {
      const token = `@${name}`;
      const idx = rest.indexOf(token);
      // Only treat it as a mention at a word boundary (start or after space).
      if (idx !== -1 && (idx === 0 || /\s/.test(rest[idx - 1]!))) {
        if (idx > 0) nodes.push(<span key={key++}>{rest.slice(0, idx)}</span>);
        nodes.push(
          <span
            key={key++}
            className="rounded bg-accent px-1 font-medium text-accent-foreground"
          >
            {token}
          </span>,
        );
        rest = rest.slice(idx + token.length);
        continue outer;
      }
    }
    nodes.push(<span key={key++}>{rest}</span>);
    break;
  }
  return nodes;
}
