# Specboard: Design direction (GitHub-native re-skin)

## Context

Specboard's web UI is built on shadcn/ui (Radix + Tailwind v4 + CVA). Out of the
box that gave us the stock shadcn look: chroma-zero neutral grays, soft 10-14px
radii, shadow-based elevation, near-black primary, and system-only typography.
That look is shared by thousands of open-source apps, so the product reads as
generic rather than as "part of the developer's world."

We want to shift closer to a GitHub-native feel. Specboard already lives in the
GitHub ecosystem (spec sync, GitHub App, repo pickers), so matching GitHub's
Primer language makes the product feel like an extension of the place the specs
already live.

Key insight: the generic feeling lives in the **token values, not the
components**. The shadcn/Radix/CVA architecture is good and worth keeping. We
re-point the token values and adjust a few structural habits rather than
adopting `@primer/react` or rewriting primitives.

The full visual write-up (with live color swatches and before/after) is the
published artifact "Specboard Design Direction: From generic shadcn to
GitHub-native." This doc is the durable, in-repo version.

## The landscape

The popular open-source systems, by the signature look each imprints and its fit
for a git-native, spec/PM tool:

| System | Signature look | Fit for Specboard |
| --- | --- | --- |
| **Primer** (GitHub) | Bordered "Box" containers, flat, 6px radius, blue links, green primary, system + mono type, dense | Recommended. Native git/PM feel; direct target. |
| **shadcn/ui** (Radix + Tailwind) | Neutral gray, soft radius, subtle shadows (our current look) | Keep as the engine. Great architecture, generic skin. |
| **Radix Themes** | 12-step scales, larger radius, rounded and friendly | Off-target: rounder and softer than GitHub. |
| **IBM Carbon** | Flat, dense, sharp corners, IBM Plex, strong grid | Adjacent: same flat/dense DNA, but corners too sharp and not GitHub. |
| **Ant Design** | Dense forms, #1677ff blue, heavy component set | Strong but distinctly "AntD"; not git-native. |
| **MUI (Material)** | Elevation, ripples, floating labels, bold color | Heavy elevation clashes with flat git UIs. |
| **Chakra / Mantine** | Rounded, teal/indigo accents, friendly spacing | Pleasant but soft; the opposite of dense/flat. |

Carbon is the honorable mention: it shares Primer's flat, dense, border-driven
DNA. Primer wins because the goal is specifically a GitHub-native feel and
because we already live in the GitHub ecosystem.

## Recommendation

Re-skin to Primer's token values and structural habits; keep shadcn. Do not
adopt `@primer/react` (that would mean re-writing every component, losing the
Tailwind v4 + CVA setup, and taking on a second component paradigm).

Five shifts do most of the work: the palette, the radius, borders-over-shadows,
the type system, and semantic color (blue links + green primary).

## Token map

Proposed light-mode values from Primer Primitives. Dark mode maps to GitHub's
real slate (#0d1117), which already reads cool and keeps a nod to the previous
blue-tinted identity. Variable names stay on the stock shadcn names so vendored
components drop in unchanged.

| Token | Role | Now | Proposed (Primer light / dark) |
| --- | --- | --- | --- |
| `--background` | canvas | #ffffff | #ffffff / #0d1117 |
| `--muted` / `--secondary` | subtle fills, headers | #f5f5f5 | #f6f8fa / #161b22 (muted), #21262d (secondary, dark) |
| `--foreground` | text | #252525 | #1f2328 / #e6edf3 |
| `--muted-foreground` | secondary text | #8f8f8f | #59636e / #9198a1 |
| `--border` / `--input` | 1px structure | #e3e3e3 | #d1d9e0 / #30363d |
| `--primary` | primary action | #343434 | #1f883d / #238636 (GitHub green) |
| `--link` (new) | links, focus, selection | unused | #0969da / #4493f8 |
| `--destructive` | danger | #dc2626 | #d1242f / #da3633 |
| `--radius` | corner | 10px | 6px (borderRadius.medium) |

The neutrals move from chroma-zero gray to Primer's slightly cool-biased grays:
a small change that reads as "chosen" instead of default.

## The GitHub "tells"

Beyond color, these structural habits are what make a UI read as native GitHub.
Each maps to a small, mechanical change:

- **Radius**: tighten to 6px everywhere; 3px for inline chips.
- **Elevation**: let 1px borders carry structure. Remove card and button
  shadows; reserve a faint shadow only for true overlays (menus, sheets).
- **The Box**: adopt Primer's signature container, a bordered panel with a
  #f6f8fa header row and hairline row dividers. Ideal for the Backlog list and
  detail panels.
- **Links**: a real link color (#0969da). Feature titles, refs, and breadcrumbs
  become blue links, not plain text.
- **Primary**: primary buttons go GitHub green (#1f883d); neutral and secondary
  buttons stay bordered gray.
- **Type**: an explicit GitHub system stack for body, plus a monospace role for
  IDs, counts, refs, labels, and eyebrows. This is a big part of the
  developer-native feel.
- **Counters**: replace generic badges with Primer "counter" pills, a monospace
  number in a soft neutral round-pill (like the count next to Issues / PRs).
- **Density**: buttons to 32px (h-8) as default, tighter table rows, hairline
  dividers instead of gaps. GitHub is compact.

## Migration plan (tracer-bullet)

A thin end-to-end slice first, visible in the real app, then expand. Nothing
here is a rewrite.

1. **Re-point tokens** in `globals.css`. This alone re-skins the whole app,
   because every component reads the variables. Drop the 106.25% root bump.
2. **Tighten radius and kill shadows**: `--radius: 6px`; Card from
   `rounded-xl shadow-sm` to `rounded-md` + border; remove Button shadows. Keep
   a soft shadow only on Sheet/menus.
3. **Add the type system**: wire `--font-sans` (GitHub stack) and `--font-mono`
   via `@theme`; apply mono to IDs, counters, eyebrows, and sidebar group
   labels.
4. **Semantic color + Box**: green primary variant, blue link styling, a new
   bordered Box wrapper. Apply the Box to one surface first (the Backlog list)
   to validate the pattern before rolling out.
5. **Review in the real app, then expand**: ship the Backlog slice, review in
   both themes, tune the neutrals, then roll the Box + counters across Board,
   Roadmap, and the detail sheets.

## What to keep, what to watch

**Keep**

- The shadcn/ui + Radix + CVA architecture; this is purely a re-skin.
- The Tailwind v4 `@theme` setup; it is built for exactly this token
  indirection.
- A faint blue bias in dark mode as a small nod to today's identity, which
  GitHub's slate already provides.
- The per-status accent palette; just retune the hues toward Primer labels.

**Watch**

- Contrast: verify fg/bg pairs in both themes (Primer targets WCAG AA); do not
  hand-pick off-palette grays.
- "Too GitHub": we want native-feeling, not a clone. Retaining the status colors
  and a dark-mode tint gives us our own edge.
- Green primary can read as "success" only; keep destructive red and
  neutral/outline buttons clearly distinct.
- Do not scatter monospace; reserve it for data and labels or it turns into
  noise.

## Status: what is already implemented

**Slice 1 (PR #114, live on test):** the token/component foundation.

- `apps/web/src/app/globals.css`: Primer light/dark token values, `--link`,
  system + monospace font stacks, 14px body, `--radius: 6px`, dropped the
  106.25% root bump. Also fixed the TipTap rules that referenced
  `hsl(var(--token))` (invalid against the hex tokens).
- `components/ui/button.tsx`: flat, 1px-bordered, shadows removed, green
  primary, blue link variant, 32px default height.
- `components/ui/card.tsx`: `rounded-md`, shadow removed.
- `components/ui/badge.tsx`: monospace `counter` variant.
- `components/ui/box.tsx`: new Primer Box primitive.
- Backlog list (`.../backlog/list-view.tsx`, `backlog-table.tsx`): wrapped in a
  Box with a counter header, blue feature links, monospace spec paths.
- Routed remaining `text-primary` links and selected/voted states to `--link`.

**Slice 2 (PR #115):** the read views + status palette.

- Board columns and Roadmap lanes: `counter` pills; Roadmap release names as
  blue links; column radius tightened to `rounded-md`.
- `feature-card.tsx`: flattened (dropped `rounded-lg shadow-sm`).
- `detail-section.tsx`: Box-style panel with a muted header row.
- `lib/feature-helpers.ts`: per-status dot palette retuned toward Primer hues
  (cool slate grays, `blue-500` ready, `green-500` done, `purple` defining).

**Slice 3 (this PR, bundled with slice 2):** the finish pass.

- Idea + release detail sheets wrapped in Box sections.
- Auth-form links and back/breadcrumb links routed to `text-link`.
- Surface sweep: flattened leftover shadows on non-overlays (overlays keep a
  soft shadow), count badges to `counter` pills, IDs/refs to monospace.
- Verified token contrast in both themes.

Each slice verified with `pnpm typecheck` + `pnpm build` and by rendering the
affected surfaces in both themes.

## Remaining follow-ups

- None blocking. Future polish as the app grows: keep new surfaces on the Box +
  counter + `text-link` patterns rather than raw shadcn defaults.

## References

- Primer color foundations: https://primer.style/foundations/color/overview/
- primer/primitives: https://github.com/primer/primitives
