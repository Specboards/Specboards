"use client";

// `__webpack_nonce__` is a webpack "free variable": reads compile to
// `__webpack_require__.nc` and writes set it. Declaring it here is type-only
// (erased at build) so the assignment below typechecks.
declare let __webpack_nonce__: string;

/**
 * Seed webpack's runtime nonce with our per-request CSP nonce.
 *
 * Radix Dialog's scroll-lock (react-remove-scroll → react-style-singleton →
 * get-nonce) injects a `<style>` element for scrollbar-gap compensation and
 * reads its nonce from `__webpack_nonce__`. Without it that `<style>` is
 * un-nonced, so our `style-src 'self' 'nonce-…'` CSP blocks it — which breaks
 * any dialog/sheet, e.g. the release editor (and its date fields).
 *
 * Assigning inside this webpack-compiled client module sets
 * `__webpack_require__.nc`, so every later `<style>`/chunk the runtime injects
 * carries the nonce. Rendered at the top of the root layout so it runs before
 * any dialog can mount. Renders nothing.
 *
 * This is why BOTH `dev` and `build` pass `--webpack` in package.json. Under
 * Turbopack (the Next 16 default for `next dev`) the free variable does not
 * exist, so the assignment below throws a ReferenceError, and because this
 * renders in the root layout that means every route 500s. Dropping the flag
 * from `dev` breaks the whole app locally, not just dialogs.
 */
export function WebpackNonce({ nonce }: { nonce?: string }) {
  if (nonce) {
    __webpack_nonce__ = nonce;
  }
  return null;
}
