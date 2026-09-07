"use client";

/**
 * The current request's CSP nonce, for client code that injects a `<style>` at
 * runtime and has to label it.
 *
 * Most of the app never needs this: our stylesheets are bundled and served from
 * 'self', and webpack's own runtime injections are covered by seeding
 * `__webpack_nonce__` (see components/webpack-nonce). The exception is a library
 * that appends its own `<style>` through plain DOM calls, which webpack knows
 * nothing about. TipTap is one: ProseMirror's base rules go in through
 * `createStyleTag`, and without a nonce `style-src 'self' 'nonce-…'` refuses
 * them, so the editor loses `white-space: pre-wrap` and the rest of the
 * ProseMirror baseline.
 *
 * A module-level value rather than a context, because it is set once per
 * document by the same component in the root layout that seeds webpack's, and
 * every reader is a client component rendered underneath it. Reading it during
 * render is fine; it is written before anything else mounts.
 */
let current: string | undefined;

/** Seeded once, from the root layout. See components/webpack-nonce. */
export function setCspNonce(nonce: string | undefined): void {
  current = nonce;
}

/** The nonce a runtime-injected `<style>` must carry, if there is one. */
export function cspNonce(): string | undefined {
  return current;
}
