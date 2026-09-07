import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "@/lib/store/db";
import { NotificationSettingsError } from "@/lib/store/types";

/**
 * Notification settings against a migrated Postgres.
 *
 * The unit tests cover the fold; what needs a database is everything the fold
 * assumes. That an "inherit" really deletes a row rather than writing the
 * inherited value into it, so a later change to the level above still moves
 * this reader. That a member cannot write a workspace default, and is told so
 * rather than being handed a success that changed nothing. That one member's
 * preferences are invisible to another, including to an admin, which is why
 * the admin's override count is an aggregate.
 *
 * Runs through the non-owner app role, because most of those claims are RLS
 * claims and the owner connection bypasses RLS entirely.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const ws = randomUUID();
const user = {
  admin: randomUUID(),
  member: randomUUID(),
  other: randomUUID(),
};
const suffix = randomUUID().slice(0, 8);

const asAdmin = { userId: user.admin, workspaceId: ws };
const asMember = { userId: user.member, workspaceId: ws };
const asOther = { userId: user.other, workspaceId: ws };

/** The cell used throughout. In-app assignment starts on in the catalog. */
const TYPE = "item.assigned";

function cellOf(
  rows: { type: string; channels: Record<string, { enabled: boolean; source: string }> }[],
  type = TYPE,
  channel = "in_app",
) {
  const row = rows.find((r) => r.type === type);
  if (!row) throw new Error(`no row for ${type}`);
  return row.channels[channel]!;
}

describe.skipIf(!OWNER_URL)("notification settings", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);

    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'Prefs', ${"prefs-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.admin}, 'Ada', ${`ada-${suffix}@prefs.test`}),
      (${user.member}, 'Mo', ${`mo-${suffix}@prefs.test`}),
      (${user.other}, 'Ola', ${`ola-${suffix}@prefs.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.admin}, 'owner'),
      (${ws}, ${user.member}, 'member'),
      (${ws}, ${user.other}, 'member')`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${user.admin}, ${user.member}, ${user.other})`;
    await owner.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await owner`delete from notification_defaults where workspace_id = ${ws}`;
    await owner`delete from notification_preferences where workspace_id = ${ws}`;
  });

  it("starts everybody on the catalog, with nothing stored", async () => {
    const { rows } = await store.getNotificationPreferences(asMember);
    expect(cellOf(rows)).toEqual({ enabled: true, source: "catalog" });
    const stored = await owner`
      select count(*)::int as n from notification_preferences where workspace_id = ${ws}`;
    expect(stored[0]!.n).toBe(0);
  });

  it("stores a user's choice and reads it back as theirs", async () => {
    const { rows } = await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asMember,
    );
    expect(cellOf(rows)).toEqual({ enabled: false, source: "user" });

    const fresh = await store.getNotificationPreferences(asMember);
    expect(cellOf(fresh.rows).enabled).toBe(false);
  });

  it("keeps one member's choice out of another's settings", async () => {
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asMember,
    );
    const { rows } = await store.getNotificationPreferences(asOther);
    expect(cellOf(rows)).toEqual({ enabled: true, source: "catalog" });
  });

  it("moves a member who has not overridden a row when the admin changes it", async () => {
    await store.updateNotificationDefaults(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asAdmin,
    );
    const { rows } = await store.getNotificationPreferences(asMember);
    expect(cellOf(rows)).toEqual({ enabled: false, source: "workspace" });
  });

  it("leaves a member who has overridden a row where they put it", async () => {
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: true }],
      asMember,
    );
    await store.updateNotificationDefaults(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asAdmin,
    );
    const { rows } = await store.getNotificationPreferences(asMember);
    expect(cellOf(rows)).toEqual({ enabled: true, source: "user" });
  });

  it("deletes the row on reset, so the next default change reaches them", async () => {
    // The whole point of the storage shape, and the one thing that would look
    // identical on screen if it were implemented by writing the inherited
    // value back: the reader would be pinned, and would stop moving with the
    // default without anything visibly wrong.
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: true }],
      asMember,
    );
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: null }],
      asMember,
    );

    const stored = await owner`
      select count(*)::int as n from notification_preferences
      where workspace_id = ${ws} and user_id = ${user.member}`;
    expect(stored[0]!.n).toBe(0);

    await store.updateNotificationDefaults(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asAdmin,
    );
    const { rows } = await store.getNotificationPreferences(asMember);
    expect(cellOf(rows)).toEqual({ enabled: false, source: "workspace" });
  });

  it("returns a workspace default to the catalog on reset", async () => {
    await store.updateNotificationDefaults(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asAdmin,
    );
    const { rows } = await store.updateNotificationDefaults(
      [{ type: TYPE, channel: "in_app", enabled: null }],
      asAdmin,
    );
    expect(cellOf(rows)).toEqual({ enabled: true, source: "catalog" });
  });

  it("refuses a member who tries to change the workspace defaults", async () => {
    // RLS alone would let this succeed against no rows: DELETE and INSERT ...
    // ON CONFLICT both report success having matched nothing. A grid that says
    // "Saved." and changed nothing is worse than a refusal.
    await expect(
      store.updateNotificationDefaults(
        [{ type: TYPE, channel: "in_app", enabled: false }],
        asMember,
      ),
    ).rejects.toBeInstanceOf(NotificationSettingsError);

    const stored = await owner`
      select count(*)::int as n from notification_defaults where workspace_id = ${ws}`;
    expect(stored[0]!.n).toBe(0);
  });

  it("refuses a member reading the defaults grid, counts and all", async () => {
    await expect(
      store.getNotificationDefaults(asMember),
    ).rejects.toBeInstanceOf(NotificationSettingsError);
  });

  it("counts how many members have overridden each cell", async () => {
    await store.updateNotificationPreferences(
      [
        { type: TYPE, channel: "in_app", enabled: false },
        { type: TYPE, channel: "email", enabled: false },
      ],
      asMember,
    );
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asOther,
    );

    const { overrideCounts } = await store.getNotificationDefaults(asAdmin);
    expect(overrideCounts[TYPE]?.in_app).toBe(2);
    expect(overrideCounts[TYPE]?.email).toBe(1);
    expect(overrideCounts["comment.created"]).toBeUndefined();
  });

  it("updates an existing choice rather than duplicating it", async () => {
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: false }],
      asMember,
    );
    await store.updateNotificationPreferences(
      [{ type: TYPE, channel: "in_app", enabled: true }],
      asMember,
    );
    const stored = await owner`
      select enabled from notification_preferences
      where workspace_id = ${ws} and user_id = ${user.member}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.enabled).toBe(true);
  });

  it("refuses a type or channel the catalog does not have", async () => {
    await expect(
      store.updateNotificationPreferences(
        [{ type: "item.combusted", channel: "in_app", enabled: true }],
        asMember,
      ),
    ).rejects.toBeInstanceOf(NotificationSettingsError);
    await expect(
      store.updateNotificationPreferences(
        [{ type: TYPE, channel: "carrier_pigeon", enabled: true }],
        asMember,
      ),
    ).rejects.toBeInstanceOf(NotificationSettingsError);
  });

  it("refuses one request that names the same cell twice", async () => {
    await expect(
      store.updateNotificationPreferences(
        [
          { type: TYPE, channel: "in_app", enabled: true },
          { type: TYPE, channel: "in_app", enabled: false },
        ],
        asMember,
      ),
    ).rejects.toBeInstanceOf(NotificationSettingsError);
  });

  it("resets a whole grid in one request", async () => {
    await store.updateNotificationPreferences(
      [
        { type: TYPE, channel: "in_app", enabled: false },
        { type: "comment.created", channel: "in_app", enabled: false },
        { type: "release.shipped", channel: "in_app", enabled: false },
      ],
      asMember,
    );
    const { rows } = await store.updateNotificationPreferences(
      [
        { type: TYPE, channel: "in_app", enabled: null },
        { type: "comment.created", channel: "in_app", enabled: null },
        { type: "release.shipped", channel: "in_app", enabled: null },
      ],
      asMember,
    );
    expect(rows.every((r) => r.channels.in_app.source !== "user")).toBe(true);
    const stored = await owner`
      select count(*)::int as n from notification_preferences
      where workspace_id = ${ws} and user_id = ${user.member}`;
    expect(stored[0]!.n).toBe(0);
  });
});
