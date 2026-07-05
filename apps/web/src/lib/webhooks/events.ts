import { drainSoon } from "@/lib/webhooks/drainer";

/**
 * Kick the outbox relay + delivery drainer after a domain write has recorded an
 * `outbox_events` row (in its transaction), so healthy deliveries go out in ~a
 * tick instead of waiting for the next periodic sweep. Safe to call always: it's
 * a no-op in local file mode (the drainer finds no database).
 *
 * The event itself is durable the moment the domain transaction commits, so this
 * is only a latency optimization - losing the nudge just delays delivery to the
 * next interval, it never drops the event.
 */
export function notifyOutbox(): void {
  drainSoon();
}
