import { expect, test } from "@playwright/test";

/**
 * The self-host GitHub setup path, which had no browser coverage at all.
 *
 * That gap is why a P0 survived seven weeks: `isMultiTenant()` short-circuits
 * the manifest route, so the hosted deployment never executes it, and the only
 * deployment that did was the one nothing tested. Both defects found in the
 * 2026-09-01 on-prem run live on this path.
 *
 * The E2E server runs on `http://localhost:3100`, which GitHub cannot reach.
 * That is not a limitation here, it is the case under test: it is exactly the
 * shape of a default `./setup.sh` install, and the shape that used to fail.
 */
test.describe("self-host GitHub setup on an unreachable origin", () => {
  /**
   * The regression guard for the dead end.
   *
   * Before the fix this route answered 200 with "Redirecting you to GitHub to
   * create the Specboards app…" and then never redirected, because the inline
   * script that submitted the form was refused by the CSP. Even with that
   * fixed, GitHub refuses a manifest whose webhook URL it cannot reach, so
   * going there at all is a dead end from this origin.
   */
  test("the manifest route refuses rather than stranding the operator", async ({
    page,
  }) => {
    const res = await page.request.get("/api/v1/github/app/create?org=acme", {
      maxRedirects: 0,
    });

    expect(res.status(), "redirects rather than rendering an interstitial").toBe(302);
    expect(res.headers()["location"] ?? "").toContain("error=origin_not_public");

    const body = await res.text();
    expect(body).not.toContain("Redirecting you to GitHub");
    expect(body).not.toContain("github.com/organizations");
  });

  test("the settings page explains why, in terms the operator can act on", async ({
    page,
  }) => {
    await page.goto(
      "/api/v1/github/app/create?org=acme",
    );
    await expect(page).toHaveURL(/error=origin_not_public/);
    await expect(
      page.getByText(/GitHub can't reach this instance/i),
    ).toBeVisible();
    await expect(page.getByText(/APP_URL/)).toBeVisible();
  });

  /**
   * The manual credential endpoint, which is the only way an instance GitHub
   * cannot reach can connect at all. Before this change `saveCredentials` had a
   * single caller, the manifest callback, so such a deployment had no path
   * whatsoever.
   *
   * Only the local validation is asserted here: everything past it calls
   * `GET /app` against real GitHub, which this hermetic suite must not do. The
   * verified-credential path is covered by the on-prem run instead.
   *
   * The *rendering* of the manual form is likewise not asserted here, because
   * `isGithubConfigured` returns true under `SPECBOARDS_E2E` (see
   * `lib/github-app.ts`), so the setup card never renders in this suite and a
   * test for it would be asserting the seam rather than the feature.
   */
  test("refuses malformed credentials, naming the field at fault", async ({ page }) => {
    const post = async (data: Record<string, string>) =>
      page.request.post("/api/v1/github/app/manual", {
        headers: { "content-type": "application/json" },
        data,
      });

    const valid = {
      appId: "123456",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
      clientSecret: "shh",
    };

    for (const [field, data] of [
      ["appId", { ...valid, appId: "not-a-number" }],
      ["privateKey", { ...valid, privateKey: "just some text" }],
      ["clientSecret", { ...valid, clientSecret: "" }],
    ] as const) {
      const res = await post(data);
      expect(res.status(), `${field} is rejected`).toBe(400);
      const body = (await res.json()) as { error?: string; field?: string };
      expect(body.field, `${field} is named as the problem`).toBe(field);
      expect(body.error, `${field} error explains itself`).toBeTruthy();
    }
  });

  test("the manual endpoint refuses a non-JSON body", async ({ page }) => {
    const res = await page.request.post("/api/v1/github/app/manual", {
      headers: { "content-type": "text/plain" },
      data: "appId=1",
    });
    expect(res.status()).toBe(415);
  });
});
