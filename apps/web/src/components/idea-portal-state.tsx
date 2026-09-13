import { Badge } from "@/components/ui/badge";
import type { IdeaRecord, PortalVisibility } from "@/lib/store/types";

/**
 * How an idea's portal state and its provenance are said, in one place.
 *
 * Both the board row and the detail drawer show these, and they were the kind
 * of thing that drifts into two vocabularies: "Awaiting review" in one and
 * "Pending" in the other, for the same column. A moderator reading a queue
 * needs the two screens to agree about what a word means.
 */

/** What the admin sees for each state. Not the same words as the column. */
const VISIBILITY_LABEL: Record<PortalVisibility, string> = {
  // Not "published", because on a workspace with no portal, or one whose
  // product or stage is unpublished, this idea is not on any public page and
  // saying "Published" would be a plain lie. This column grants permission; the
  // visibility model decides the rest.
  published: "Public if published",
  pending: "Awaiting review",
  hidden: "Hidden from portal",
};

/**
 * Whether an idea's portal state is worth showing at all.
 *
 * `published` is the default every idea already has, so badging it would put a
 * chip on every row in the product and mean nothing. Only a deliberate
 * departure from the default is information.
 */
export function hasNotablePortalState(idea: IdeaRecord): boolean {
  return idea.portalVisibility !== "published" || idea.isExternalSubmission;
}

/** The portal state chip, or null when there is nothing worth saying. */
export function PortalStateBadge({
  visibility,
  size = "sm",
}: {
  visibility: PortalVisibility;
  size?: "default" | "sm";
}) {
  if (visibility === "published") return null;
  return (
    <Badge
      // `pending` is work to do, `hidden` is a decision already taken. Neither
      // is an error, so neither is destructive: a rejected submission is the
      // system working, and colouring it like a failure would make a moderator
      // clearing spam feel like they were reading a problem report.
      variant={visibility === "pending" ? "default" : "secondary"}
      size={size}
    >
      {VISIBILITY_LABEL[visibility]}
    </Badge>
  );
}

/** "From the portal" provenance chip, for an external submission. */
export function ProvenanceBadge({
  idea,
  size = "sm",
}: {
  idea: IdeaRecord;
  size?: "default" | "sm";
}) {
  if (!idea.isExternalSubmission) return null;
  return (
    <Badge variant="outline" size={size}>
      From the portal
    </Badge>
  );
}

/**
 * One line saying where an idea came from and who from.
 *
 * The distinction matters to a moderator in a way it does not to anyone else:
 * an internal capture is a colleague's note and an external submission is a
 * stranger's, and the second is the one to read sceptically before publishing
 * it under the company's own branding.
 *
 * An external submission with no name says so rather than falling back to the
 * author. `authorId` is null on these rows, so the old
 * `submitterName ?? authorName` would have rendered nothing at all and made an
 * anonymous submission look like an idea with no provenance instead of one with
 * provenance and no name.
 */
export function provenanceLine(idea: IdeaRecord): string | null {
  if (idea.isExternalSubmission) {
    return idea.submitterName
      ? `Submitted via the portal by ${idea.submitterName}`
      : "Submitted via the portal";
  }
  return idea.authorName ? `Captured by ${idea.authorName}` : null;
}
