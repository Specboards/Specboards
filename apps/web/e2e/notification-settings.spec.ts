import { expect, test, type Page } from "@playwright/test";

import { getWorkspace, resetNotificationSettings } from "./helpers/db";

/**
 * Notification settings, end to end.
 *
 * The claim worth checking through a browser is the one the storage shape
 * exists for and that no unit test can see: a row nobody has touched follows
 * the workspace default and moves when an admin changes it, and a row somebody
 * has set stays where they put it. Everything else here (the toggle sticking,
 * the reset returning a row to inheriting) is the visible half of the same
 * behaviour.
 *
 * The e2e account is the workspace admin, so both grids render on one page,
 * which is what makes the inheritance assertion possible in a single session.
 */

/** The first grid is the reader's own; the second is the workspace defaults. */
function grids(page: Page) {
  return {
    mine: page.getByRole("region", { name: "Your notifications" }),
    workspace: page.getByRole("region", { name: "Workspace defaults" }),
  };
}

const CHANNEL_LABELS = { in_app: "In app", email: "Email" } as const;

/** One cell: its toggle, and the line saying where the value came from. */
function cell(
  scope: ReturnType<typeof grids>["mine"],
  row: string,
  channel: keyof typeof CHANNEL_LABELS,
) {
  const rowEl = scope.getByRole("row", { name: new RegExp(row) });
  return {
    toggle: rowEl.getByRole("switch", {
      name: `${row}, ${CHANNEL_LABELS[channel]}`,
    }),
    source: rowEl.getByTestId(`source-${channel}`),
    reset: rowEl.getByRole("button", { name: new RegExp(`Reset ${row}`) }),
  };
}

const ROW = "An item is assigned to you";

test.describe("notification settings", () => {
  test("a row inherits until you set it, and then stops", async ({ page }) => {
    const ws = await getWorkspace();
    await resetNotificationSettings(ws.id);
    await page.goto(`/${ws.slug}/settings/notifications`);

    const { mine, workspace } = grids(page);
    await expect(mine).toBeVisible();
    await expect(workspace).toBeVisible();

    // Nothing stored anywhere: the built-in value, marked as inherited.
    const own = cell(mine, ROW, "in_app");
    await expect(own.source).toHaveText("Workspace default");
    await expect(own.toggle).toHaveAttribute("aria-checked", "true");

    // An admin turns the default off. The reader has not touched this row, so
    // it moves with the default. This is the whole feature.
    const admin = cell(workspace, ROW, "in_app");
    await admin.toggle.click();
    // The admin grid names its own layer for what it is. A workspace default
    // somebody set is not that reader's personal choice, and saying so here
    // would blur the one distinction this page exists to draw.
    await expect(admin.source).toHaveText("Set here");
    await page.reload();
    await expect(cell(mine, ROW, "in_app").source).toHaveText(
      "Workspace default",
    );
    await expect(cell(mine, ROW, "in_app").toggle).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // The reader turns it back on for themselves. Now it is theirs, and the
    // workspace default underneath it is no longer the thing being read.
    await cell(mine, ROW, "in_app").toggle.click();
    await expect(cell(mine, ROW, "in_app").source).toHaveText("Your choice");
    await page.reload();
    await expect(cell(mine, ROW, "in_app").toggle).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(cell(mine, ROW, "in_app").source).toHaveText("Your choice");

    // Reset gives the row back to the workspace, which still says off. If a
    // reset wrote the current value into a row instead of deleting it, this
    // would still read "Your choice" and the reader would be quietly pinned.
    await cell(mine, ROW, "in_app").reset.click();
    await expect(cell(mine, ROW, "in_app").source).toHaveText(
      "Workspace default",
    );
    await expect(cell(mine, ROW, "in_app").toggle).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("shows the admin how many people have left a default behind", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetNotificationSettings(ws.id);
    await page.goto(`/${ws.slug}/settings/notifications`);

    const { mine, workspace } = grids(page);
    await expect(cell(workspace, ROW, "in_app").source).toBeVisible();
    await expect(workspace.getByText("1 override")).toHaveCount(0);

    await cell(mine, ROW, "in_app").toggle.click();
    await expect(cell(mine, ROW, "in_app").source).toHaveText("Your choice");
    await page.reload();
    await expect(workspace.getByText("1 override")).toBeVisible();
  });

  test("shows the email column without letting anyone arm it yet", async ({
    page,
  }) => {
    // Visible so the grid does not change shape the day email ships, and
    // refused so nobody ticks a box that produces nothing.
    const ws = await getWorkspace();
    await resetNotificationSettings(ws.id);
    await page.goto(`/${ws.slug}/settings/notifications`);

    const { mine } = grids(page);
    await expect(cell(mine, ROW, "email").toggle).toBeDisabled();
    // The warning is on the column header, once, rather than under every cell.
    await expect(
      mine.getByRole("columnheader", { name: /Email/ }),
    ).toContainText("Not sending yet");
  });
});
