import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalTime } from "./local-time";

/**
 * What the *server* renders, which is the only thing that can break a page.
 *
 * These assertions are deliberately about the pre-hydration text and nothing
 * else. If it depends on a timezone, a locale or an ICU version, the browser
 * will produce something different, React will throw #418, and every button in
 * the surrounding client component silently stops working. That is a page
 * outage caused by a date, so it is worth pinning precisely.
 */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("before hydration", () => {
  it("renders UTC, not the machine's timezone", () => {
    const html = render(<LocalTime iso="2026-08-16T12:00:00.000Z" />);
    expect(html).toBe("2026-08-16 12:00 UTC");
  });

  it("drops the time when the format only asks for a date", () => {
    const html = render(
      <LocalTime
        iso="2026-08-16T23:30:00.000Z"
        options={{ year: "numeric", month: "short", day: "numeric" }}
      />,
    );
    // Not localized: "16 Aug 2026" and "Aug 16, 2026" are the same instant
    // formatted by two different locales, and disagreeing is the whole failure.
    expect(html).toBe("2026-08-16");
  });

  it("uses the caller's word for nothing-yet", () => {
    expect(render(<LocalTime iso={null} />)).toBe("Never");
    expect(render(<LocalTime iso={null} fallback="never" />)).toBe("never");
  });

  it("passes through anything that is not an ISO timestamp", () => {
    // Better a strange string than a crash or an "Invalid Date" in the UI.
    expect(render(<LocalTime iso="whenever" />)).toBe("whenever");
  });

  it("is identical for two renders of the same instant", () => {
    // The property that actually matters: server and client agree. Both call
    // the same pure function with the same input, so this pins that it stays
    // a pure function of the input.
    const once = render(<LocalTime iso="2026-01-01T00:00:00.000Z" />);
    const twice = render(<LocalTime iso="2026-01-01T00:00:00.000Z" />);
    expect(once).toBe(twice);
    expect(once).toBe("2026-01-01 00:00 UTC");
  });
});
