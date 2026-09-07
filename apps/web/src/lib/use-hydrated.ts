"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the component has hydrated on the client.
 *
 * False on the server and during the first client render, true from the next
 * render on. That is the same answer the `mounted` flag gave, without the
 * `useState` + `useEffect(() => setMounted(true), [])` pair that produced it.
 *
 * The pair is idiomatic and correct on React 19, which is why it was
 * everywhere, but it is a cascading render by construction: the component
 * renders once knowing nothing, then an effect immediately sets state to say so
 * and it renders again. `react-hooks/set-state-in-effect` objects to exactly
 * that, and it is the rule the React Compiler cares most about.
 *
 * `useSyncExternalStore` answers the same question in one render, because it is
 * the hook designed for it: `getServerSnapshot` is the value the server
 * rendered and hydration must match, and `getSnapshot` is the client's. The
 * store never changes, so `subscribe` returns an unsubscribe and does nothing.
 *
 * Use this only for the hydration boundary: "am I allowed to look at the
 * browser yet". A component that wants to know whether an effect has run for
 * some other reason wants a different answer.
 */

/** Never notifies: the answer changes once, at hydration, and React knows. */
const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer);
}
