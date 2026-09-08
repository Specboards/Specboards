/**
 * Which Settings sections a person is offered.
 *
 * The navigation used to list all thirteen to everybody, varying only Email.
 * Every page behind it already resolves its own `canEdit` and renders itself
 * read-only, so the access control was right; what was wrong was the offer. A
 * member browsing Settings was invited into Branding, Hierarchy, Tags, Ideas
 * and Assistant, and found screens they could look at and not touch. Branding
 * was the worst of them: a placeholder with nothing to configure by anybody,
 * so a member was sent to a dead end twice over.
 *
 * ── This hides, it does not block ───────────────────────────────────────────
 * Nothing here is authorization. The pages keep their own gates, the routes
 * keep theirs, and the database keeps its policies; a member who types a
 * hidden URL still lands on that section's read-only page rather than a 404.
 * Navigation is a claim about what is worth your time, and this makes the
 * claim true. Treating it as a permission boundary would put the third copy of
 * a rule in a place nothing enforces.
 *
 * ── Why a viewer shape rather than a role ───────────────────────────────────
 * Two sections are not owner-or-nothing. Products and Cards are editable by
 * the admin of a single product, which is a per-product grant rather than a
 * workspace role, and hiding them from a product admin would take away the
 * screens they are specifically there to manage. So the question each section
 * answers is "can this person act here", and the caller resolves the facts.
 */

export interface SettingsSection {
  href: string;
  label: string;
}

/**
 * What the caller knows about the viewer. Deliberately facts rather than a
 * role: see above, and so a future role sits in the resolver rather than in
 * thirteen conditions.
 */
export interface SettingsViewer {
  /** Workspace owner. Can act everywhere. */
  isOwner: boolean;
  /**
   * Admin of at least one product, which is what makes Products and Cards
   * worth opening for somebody who does not own the workspace.
   */
  managesAnyProduct: boolean;
  /**
   * Whether this deployment's mail transport is the viewer's to configure. A
   * hosted tenant cannot change it and has no reason to read it.
   */
  canConfigureMail: boolean;
}

/** Every section, in the order they are shown, with who they are for. */
const SECTIONS: (SettingsSection & {
  visibleTo: (viewer: SettingsViewer) => boolean;
})[] = [
  // Personal, and fully editable by anybody: your own name, your own inbox.
  { href: "/settings/profile", label: "Profile", visibleTo: () => true },
  {
    href: "/settings/notifications",
    label: "Notifications",
    visibleTo: () => true,
  },
  // Deployment configuration rather than workspace configuration, and
  // owner-only even where it is offered at all.
  {
    href: "/settings/email",
    label: "Email",
    visibleTo: (v) => v.canConfigureMail && v.isOwner,
  },
  // Everyone: the roster is the only place in the app that answers "who are my
  // colleagues, and which address is which". The company name above it is
  // owner-only to edit and shown as text otherwise, which is a read worth
  // having rather than a screen worth hiding.
  { href: "/settings/company", label: "Company & Team", visibleTo: () => true },
  {
    href: "/settings/products",
    label: "Products",
    visibleTo: (v) => v.isOwner || v.managesAnyProduct,
  },
  {
    href: "/settings/work-cards",
    label: "Cards",
    visibleTo: (v) => v.isOwner || v.managesAnyProduct,
  },
  { href: "/settings/tags", label: "Tags", visibleTo: (v) => v.isOwner },
  { href: "/settings/ideas", label: "Ideas", visibleTo: (v) => v.isOwner },
  {
    href: "/settings/hierarchy",
    label: "Hierarchy",
    visibleTo: (v) => v.isOwner,
  },
  {
    href: "/settings/assistant",
    label: "Assistant",
    visibleTo: (v) => v.isOwner,
  },
  { href: "/settings/branding", label: "Branding", visibleTo: (v) => v.isOwner },
  // Everyone: the MCP endpoint and personal API keys are per-user and are the
  // reason most people open this page. Webhooks, agents, the model connection
  // and repository setup inside it are already admin-gated on the page itself.
  {
    href: "/settings/integrations",
    label: "Integrations",
    visibleTo: () => true,
  },
];

/** The sections this viewer is offered, in order. */
export function visibleSettingsSections(
  viewer: SettingsViewer,
): SettingsSection[] {
  return SECTIONS.filter((s) => s.visibleTo(viewer)).map(({ href, label }) => ({
    href,
    label,
  }));
}
