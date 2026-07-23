# Accessibility Conformance Statement

Specboards is committed to making its web application usable by everyone,
including people who rely on assistive technology. This statement records the
current conformance of the application at https://app.specboards.ai against the
Web Content Accessibility Guidelines (WCAG) 2.2 Level AA.

- **Standard:** WCAG 2.2, Level AA (which includes all Level A criteria).
- **Scope:** The authenticated web application (backlog board and list, roadmap,
  ideas, item detail, settings, and the sign-in / sign-up / onboarding flows).
  The public MCP and REST APIs, the command-line client, and any third-party
  content embedded in a rich-text field are out of scope.
- **Conformance claim:** Partially conforms. "Partially conforms" means that
  most of the content meets the standard and the known exceptions are listed
  below, each with the affected criteria and a plan.
- **Last reviewed:** 2026-07-23.

## How we evaluate

We combine automated and manual testing, and treat accessibility as a
release gate rather than a one-time audit.

- **Automated, in CI:** `eslint-plugin-jsx-a11y` runs on every build, and an
  `@axe-core/playwright` sweep asserts zero WCAG A/AA violations across the
  sign-in, sign-up, backlog board, backlog list, roadmap, ideas, and settings
  pages, including a dark-mode pass. A build fails on any violation, so
  regressions cannot merge.
- **Contrast:** Color pairs are computed against the WCAG contrast formula
  (4.5:1 for body text, 3:1 for large text and non-text UI boundaries) rather
  than eyeballed. The token values live in `apps/web/src/app/globals.css` and
  are mirrored in `packages/ui/src/index.ts`.
- **Manual keyboard passes:** Every interactive flow is exercised with the
  keyboard only, including the skip link, the mobile navigation drawer's focus
  trap, and the card "Move" menus that stand in for drag-and-drop.
- **Manual screen-reader passes:** Spot-checked with VoiceOver (Safari) and
  NVDA (Firefox), focusing on form errors, live-region announcements, and the
  move menus.
- **Responsive and motion:** Verified with browser device emulation at 375,
  390, 768, and 1024 px wide, and with `prefers-reduced-motion` emulated.

## Assistive technology and browsers tested

- VoiceOver on macOS with Safari.
- NVDA on Windows with Firefox.
- Keyboard-only navigation in Chrome, Safari, and Firefox.
- Chrome, Safari, and Firefox at the four viewport widths above, plus iOS Safari
  and Android Chrome for touch behavior.

Older browsers and other screen-reader combinations are likely to work but are
not part of the regular test matrix.

## Conformance by guideline

The following summarizes support for the criteria most relevant to this
application. "Supports" means we have verified the criterion; "Partially
supports" means there is a known, listed exception.

### Perceivable

| Criterion | Level | Status | Notes |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | Supports | Icon-only controls carry text alternatives; decorative icons are `aria-hidden`. |
| 1.3.1 Info and Relationships | A | Supports | Form fields are labelled and associated with their errors and hints via a shared FormField; nav landmarks are labelled. |
| 1.3.2 Meaningful Sequence | A | Supports | DOM order matches reading order; the mobile board is a scroll-snap carousel that preserves column order. |
| 1.3.5 Identify Input Purpose | AA | Supports | Auth fields use standard `autocomplete` tokens. |
| 1.4.1 Use of Color | A | Supports | Status and state are always paired with text or a shape, never color alone; inline links are underlined. |
| 1.4.3 Contrast (Minimum) | AA | Supports | Body text meets 4.5:1 in both themes; verified by the axe color-contrast gate. |
| 1.4.10 Reflow | AA | Supports | Layouts reflow to a single column by 320 px; wide tables scroll within their own region rather than the page. |
| 1.4.11 Non-text Contrast | AA | Supports | Control borders and focus rings meet 3:1; a dedicated `--input` token carries the form-control boundary. |
| 1.4.12 Text Spacing | AA | Supports | No content is clipped when user text-spacing overrides are applied. |
| 1.4.13 Content on Hover or Focus | AA | Supports | Menus and popovers are dismissable, hoverable, and persistent. |

### Operable

| Criterion | Level | Status | Notes |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | Supports | Every drag interaction (board, roadmap, product groups) has a keyboard-operable "Move" menu equivalent. |
| 2.1.2 No Keyboard Trap | A | Supports | Focus can always leave a component; dialogs trap focus only while open and restore it on close. |
| 2.4.1 Bypass Blocks | A | Supports | A skip link jumps to the main landmark. |
| 2.4.3 Focus Order | A | Supports | Focus order follows the visual layout. |
| 2.4.7 Focus Visible | AA | Supports | A visible focus ring is present on all interactive elements. |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Supports | `scroll-padding` keeps a focused element clear of the sticky top bar. |
| 2.5.7 Dragging Movements | AA | Supports | All dragging has a single-pointer alternative via the "Move" menus. |
| 2.5.8 Target Size (Minimum) | AA | Supports | Interactive targets are at least 24 by 24 px; primary touch targets on mobile are larger. |
| 2.3.3 Animation from Interactions | AAA | Supports | `prefers-reduced-motion` disables non-essential animation (beyond the AA requirement). |

### Understandable

| Criterion | Level | Status | Notes |
| --- | --- | --- | --- |
| 3.1.1 Language of Page | A | Supports | The document declares `lang="en"`. |
| 3.2.1 On Focus / 3.2.2 On Input | A | Supports | Focusing or changing a field never triggers an unexpected context change. |
| 3.3.1 Error Identification | A | Supports | Validation errors are shown in text, associated to the field, and announced. |
| 3.3.2 Labels or Instructions | A | Supports | Inputs have visible labels and, where useful, hint text. |
| 3.3.3 Error Suggestion | AA | Supports | Errors describe how to correct the input where a correction is known. |

### Robust

| Criterion | Level | Status | Notes |
| --- | --- | --- | --- |
| 4.1.2 Name, Role, Value | A | Supports | Custom controls are built on Radix primitives with correct roles and states. |
| 4.1.3 Status Messages | AA | Supports | Async outcomes (saves, card moves) are announced via polite or assertive live regions without moving focus. |

## Known limitations

- **Rich-text editor internals (SC 1.1.1, 4.1.2):** The TipTap editing surface
  is a third-party component we do not fully control. Its toolbar is labelled
  and keyboard-operable, but the contenteditable region is excluded from the
  automated axe sweep. Plain-text and Markdown remain available as the
  underlying representation.
- **Wide data tables on small screens (SC 1.4.10):** The backlog list table
  reflows by scrolling horizontally within its own region on very narrow
  screens rather than restructuring into stacked cards. The page itself never
  scrolls horizontally. A stacked-card layout is a planned enhancement.
- **Complex drag on touch:** On tablets, a card can still be lifted with a long
  press; on phones, drag is disabled entirely and the "Move" menu is the
  supported path. This is by design, not a defect.

## Feedback

If you encounter an accessibility barrier, or need content in a different
format, please contact us at accessibility@specboards.ai. We aim to acknowledge
reports within five business days. Please include the page URL, the assistive
technology and browser you were using, and a short description of the problem.

This statement will be updated as the application changes and as we complete the
enhancements listed above.
