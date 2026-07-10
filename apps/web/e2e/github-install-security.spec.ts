import { expect, test } from "@playwright/test";

import { getWorkspace, installationCount, resetBoard } from "./helpers/db";

/**
 * The GitHub install flow must fail closed: a callback that didn't originate
 * from a live install-start flow on this session binds nothing, even for a
 * signed-in workspace owner. This is the regression guard for the takeover
 * where an owner substitutes another workspace's real installation_id into
 * the callback (see docs/security-fixes.md, P0 installation binding).
 */
test.describe("github install flow: binding fails closed", () => {
  test("setup callback with a forged state binds nothing", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);

    // A real installation id of the shared App, but a state that never came
    // from install-start. The request rides the owner's signed-in session.
    const res = await page.request.get(
      "/api/v1/github/setup?installation_id=99999&setup_action=install&state=forged-nonce",
    );

    expect(res.url()).toContain("error=install");
    expect(await installationCount(ws.id)).toBe(0);
  });

  test("oauth callback with an unknown state binds nothing", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);

    const res = await page.request.get(
      "/api/v1/github/oauth/callback?code=stolen-code&state=unknown-nonce",
    );

    expect(res.url()).toContain("error=install");
    expect(await installationCount(ws.id)).toBe(0);
  });
});
