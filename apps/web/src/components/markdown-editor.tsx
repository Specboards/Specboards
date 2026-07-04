"use client";

import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useState } from "react";
import { Markdown } from "tiptap-markdown";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Read the serialized Markdown from the tiptap-markdown storage (untyped). */
function getMarkdown(editor: Editor): string {
  const storage = editor.storage as {
    markdown?: { getMarkdown: () => string };
  };
  return storage.markdown?.getMarkdown() ?? "";
}

/**
 * Rich-text editor that stores Markdown behind the scenes. Most users edit in
 * the visual (WYSIWYG) surface; a "raw" toggle swaps to a plain textarea of the
 * underlying Markdown for anyone who wants it. The current Markdown is mirrored
 * into a hidden field named `name` so the editor drops into existing
 * FormData-based forms without extra wiring.
 */
export function MarkdownEditor({
  name,
  defaultValue = "",
  placeholder,
  disabled = false,
  onChange,
  minHeightClass = "min-h-32",
}: {
  /** Hidden form field name carrying the current Markdown value. */
  name: string;
  /** Initial Markdown content. */
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Called with the current Markdown on every edit (for autosave). */
  onChange?: (markdown: string) => void;
  /** Min-height utility for both editor surfaces (default ~4 rows). */
  minHeightClass?: string;
}) {
  const [markdown, setMarkdown] = useState(defaultValue);
  const [raw, setRaw] = useState(false);

  /** Update local state and notify the parent (autosave) in one place. */
  function emit(next: string) {
    setMarkdown(next);
    onChange?.(next);
  }

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: defaultValue,
    editable: !disabled,
    // Next.js renders client components on the server first; deferring the
    // first paint avoids a hydration mismatch (TipTap SSR guidance).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "tiptap rounded-b-md border border-t-0 border-input bg-transparent px-3 py-2 text-sm focus:outline-none",
          minHeightClass,
          disabled && "cursor-not-allowed opacity-50",
        ),
      },
    },
    onUpdate: ({ editor }) => {
      emit(getMarkdown(editor));
    },
  });

  /** Switch surfaces, syncing content across the two representations. */
  function toggleRaw() {
    if (raw) {
      // Leaving raw: re-parse the edited Markdown back into the visual editor.
      editor?.commands.setContent(markdown);
    }
    setRaw((v) => !v);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 rounded-t-md border border-input bg-muted/40 px-1.5 py-1">
        {!raw && editor ? (
          <>
            <ToolbarButton
              label="Bold"
              active={editor.isActive("bold")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              B
            </ToolbarButton>
            <ToolbarButton
              label="Italic"
              active={editor.isActive("italic")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <span className="italic">I</span>
            </ToolbarButton>
            <ToolbarButton
              label="Heading"
              active={editor.isActive("heading", { level: 2 })}
              disabled={disabled}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run()
              }
            >
              H
            </ToolbarButton>
            <ToolbarButton
              label="Bullet list"
              active={editor.isActive("bulletList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              •
            </ToolbarButton>
            <ToolbarButton
              label="Numbered list"
              active={editor.isActive("orderedList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              1.
            </ToolbarButton>
            <ToolbarButton
              label="Code block"
              active={editor.isActive("codeBlock")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              {"</>"}
            </ToolbarButton>
          </>
        ) : (
          <span className="px-1 text-xs text-muted-foreground">
            Markdown source
          </span>
        )}
        <button
          type="button"
          onClick={toggleRaw}
          disabled={disabled}
          className="ml-auto rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        >
          {raw ? "Rich text" : "Raw"}
        </button>
      </div>
      {raw ? (
        <Textarea
          value={markdown}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => emit(e.target.value)}
          className={cn("rounded-t-none font-mono text-xs", minHeightClass)}
        />
      ) : (
        <EditorContent editor={editor} />
      )}
      {/* Mirror the Markdown into the enclosing form. */}
      <input type="hidden" name={name} value={markdown} />
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-6 min-w-6 rounded px-1.5 text-xs font-medium hover:bg-muted",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}
