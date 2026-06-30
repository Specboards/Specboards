import matter from "gray-matter";
import { z } from "zod";

/**
 * Frontmatter that SpecBoard expects at the top of a `spec.md`. `id` is the
 * stable link between the git-native spec content and the DB metadata row — it
 * survives file renames/moves, so metadata is never orphaned. `title` is the
 * human-facing name shown on boards.
 */
export const specFrontmatterSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  /** Optional author-declared kind, e.g. "feature" | "epic" | "spike". */
  kind: z.string().optional(),
  /**
   * Optional grouping key: the Feature this spec's work item belongs under.
   * When present it overrides the folder-based mapping during sync (ADR 0002);
   * specs sharing a `feature` value land under the same Feature grouping.
   */
  feature: z.string().optional(),
});

export type SpecFrontmatter = z.infer<typeof specFrontmatterSchema>;

/** A `## Heading` block and the markdown body beneath it. */
export interface SpecSection {
  heading: string;
  level: number;
  body: string;
}

/** Result of parsing a single spec markdown file. */
export interface ParsedSpec {
  frontmatter: SpecFrontmatter;
  /** Markdown with the frontmatter block stripped. */
  content: string;
  sections: SpecSection[];
}

/** Raised when a spec file is missing or has invalid frontmatter. */
export class SpecParseError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "SpecParseError";
  }
}

/**
 * Parse a spec markdown file (frontmatter + body) into a structured object.
 * Throws {@link SpecParseError} if required frontmatter (`id`, `title`) is
 * missing or malformed.
 */
export function parseSpec(raw: string, path?: string): ParsedSpec {
  const { data, content } = matter(raw);
  const result = specFrontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new SpecParseError(
      `Invalid spec frontmatter${path ? ` in ${path}` : ""}: ${result.error.message}`,
      path,
    );
  }
  return {
    frontmatter: result.data,
    content: content.trim(),
    sections: extractSections(content),
  };
}

/** Split markdown into top-level (## and deeper) heading sections. */
export function extractSections(markdown: string): SpecSection[] {
  const lines = markdown.split("\n");
  const sections: SpecSection[] = [];
  let current: SpecSection | null = null;

  for (const line of lines) {
    const match = /^(#{2,6})\s+(.*)$/.exec(line);
    if (match) {
      if (current) sections.push({ ...current, body: current.body.trim() });
      current = { heading: match[2]!.trim(), level: match[1]!.length, body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push({ ...current, body: current.body.trim() });
  return sections;
}

/**
 * Returns true if the raw file already carries a SpecBoard `id`. Used by the
 * git integration to decide whether it must inject one on first import.
 */
export function hasSpecId(raw: string): boolean {
  const { data } = matter(raw);
  return typeof data.id === "string" && data.id.length > 0;
}

/** A best-effort, non-throwing read of a spec file for previews. */
export interface SpecPreview {
  /** Frontmatter `title`, else the first markdown heading, else null. */
  title: string | null;
  /** Whether the file already has a stable `id` (false means import injects one). */
  hasId: boolean;
}

/**
 * Read a spec file for a preview (e.g. the onboarding import scan) without
 * mutating it. Unlike {@link parseSpec} this never throws on missing or invalid
 * frontmatter, so it can describe specs that have not been imported yet (and so
 * carry no `id`/`title`). Returns the best title we can find and whether the
 * file already has a stable id.
 */
export function previewSpec(raw: string): SpecPreview {
  let data: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Malformed frontmatter: fall back to scanning the whole file for a heading.
  }
  const fmTitle =
    typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
  return {
    title: fmTitle ?? firstHeading(body),
    hasId: typeof data.id === "string" && data.id.length > 0,
  };
}

/** The text of the first markdown heading (`#`..`######`) in `markdown`, or null. */
function firstHeading(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (match && match[1]!.trim()) return match[1]!.trim();
  }
  return null;
}
