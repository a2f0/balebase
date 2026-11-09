import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { activity } from "../activity/activity";
import { inbox } from "../inbox/inbox";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedMember, seedOrganization, seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import { equipment } from "./equipment";

const timestamp = "2026-09-20T12:00:00.000Z";
const rawEmail = [
  "From: Store <orders@store.example>",
  "To: upload@inbox.balebase.com",
  "Subject: Your laptop receipt",
  "Content-Type: text/plain",
  "",
  "Thanks for your order.",
  "",
].join("\r\n");

interface Equipment {
  assignee: { email: string; id: string; name: string } | null;
  emailCount: number;
  id: string;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: string;
}

interface ActivityEvent {
  action: string;
  actor: { id: string };
  details: Record<string, unknown>;
  root: { label: string; type: string };
  subject: { type: string };
}

const laptop = {
  assigneeId: "member-user",
  make: " Apple ",
  model: "MacBook Pro",
  purchaseDate: "2026-03-01",
  serialNumber: "C02XYZ",
  type: "computer",
};

describe("equipment", () => {
  it("lets managers add, edit, assign, and remove equipment", async () => {
    const { as } = createFixture();
    const owner = as("owner-user", "owner");

    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    expect(created.status).toBe(201);
    expect(created.body.equipment).toMatchObject({
      assignee: { id: "member-user", name: "member-user" },
      emailCount: 0,
      make: "Apple",
      model: "MacBook Pro",
      purchaseDate: "2026-03-01",
      serialNumber: "C02XYZ",
      type: "computer",
    });
    const id = created.body.equipment.id;

    const listing = await owner.json<{
      canManage: boolean;
      equipment: Equipment[];
      members: Array<{ id: string }>;
      types: string[];
    }>("GET", "/api/equipment");
    expect(listing.body.canManage).toBe(true);
    expect(listing.body.types).toEqual(["computer", "cell_phone", "monitor"]);
    expect(listing.body.members.map(({ id }) => id)).toEqual([
      "member-user",
      "owner-user",
    ]);
    expect(listing.body.equipment.map((item) => item.id)).toEqual([id]);

    const unassigned = await owner.json<{ equipment: Equipment }>(
      "PATCH",
      `/api/equipment/${id}`,
      { assigneeId: null },
    );
    expect(unassigned.body.equipment).toMatchObject({
      assignee: null,
      model: "MacBook Pro",
      serialNumber: "C02XYZ",
    });
    const edited = await owner.json<{ equipment: Equipment }>(
      "PATCH",
      `/api/equipment/${id}`,
      { model: "MacBook Air", serialNumber: "", type: "computer" },
    );
    expect(edited.body.equipment).toMatchObject({
      model: "MacBook Air",
      purchaseDate: "2026-03-01",
      serialNumber: null,
    });

    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      204,
    );
    expect((await owner.json("GET", `/api/equipment/${id}`)).status).toBe(404);
  });

  it("rejects invalid details and assignees outside the organization", async () => {
    const { as } = createFixture();
    const owner = as("owner-user", "owner");
    for (const change of [
      { type: "tablet" },
      { make: "  " },
      { model: undefined },
      { purchaseDate: "2026-02-30" },
      { serialNumber: "x".repeat(101) },
    ]) {
      const rejected = await owner.json("POST", "/api/equipment", {
        ...laptop,
        ...change,
      });
      expect(rejected).toMatchObject({
        body: {
          error:
            "Equipment details are invalid. Choose a type and enter a make, model, and, optionally, a serial number and valid purchase date.",
        },
        status: 400,
      });
    }
    const outsider = await owner.json<{ error: string }>(
      "POST",
      "/api/equipment",
      { ...laptop, assigneeId: "other-user" },
    );
    expect(outsider.status).toBe(400);
    expect(outsider.body.error).toContain("members");

    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      { ...laptop, assigneeId: null, purchaseDate: "", serialNumber: null },
    );
    expect(created.body.equipment).toMatchObject({
      assignee: null,
      purchaseDate: null,
      serialNumber: null,
    });
    const id = created.body.equipment.id;
    expect(
      (
        await owner.json("PATCH", `/api/equipment/${id}`, {
          assigneeId: "other-user",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.json<{ equipment: Equipment }>(
          "GET",
          `/api/equipment/${id}`,
        )
      ).body.equipment.assignee,
    ).toBeNull();
  });

  it("updates only the fields sent, and keeps a type no longer offered", async () => {
    const { as, database } = createFixture();
    const owner = as("owner-user", "owner");
    // A pager assigned to someone who has since left, as if removed mid-edit.
    database
      .query(
        `INSERT INTO equipment
         (id, organization_id, type, make, model, assigned_user_id,
          created_at, updated_at)
         VALUES ('pager-1', 'org-1', 'pager', 'Motorola', 'Bravo',
                 'other-user', ?, ?)`,
      )
      .run(timestamp, timestamp);

    const renamed = await owner.json<{ equipment: Equipment }>(
      "PATCH",
      "/api/equipment/pager-1",
      { model: "Bravo Plus" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.equipment).toMatchObject({
      assignee: { id: "other-user" },
      model: "Bravo Plus",
      type: "pager",
    });
    expect(
      (
        await owner.json("PATCH", "/api/equipment/pager-1", {
          assigneeId: "member-user",
          type: "pager",
        })
      ).status,
    ).toBe(200);
    for (const change of [
      { type: "tablet" },
      { make: "" },
      { purchaseDate: "03/01/2026" },
      { serialNumber: 42 },
      { assigneeId: "other-user" },
    ]) {
      expect(
        (await owner.json("PATCH", "/api/equipment/pager-1", change)).status,
      ).toBe(400);
    }
    expect(
      (await owner.json("POST", "/api/equipment", { ...laptop, type: "pager" }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.json<{ equipment: Equipment }>(
          "GET",
          "/api/equipment/pager-1",
        )
      ).body.equipment,
    ).toMatchObject({
      assignee: { id: "member-user" },
      make: "Motorola",
      model: "Bravo Plus",
    });
  });

  it("lets members view but not change equipment, within their organization", async () => {
    const { as } = createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;

    const listing = await member.json<{
      canManage: boolean;
      equipment: Equipment[];
    }>("GET", "/api/equipment");
    expect(listing.body.canManage).toBe(false);
    expect(listing.body.equipment).toHaveLength(1);
    expect((await member.json("GET", `/api/equipment/${id}`)).status).toBe(200);
    expect((await member.json("POST", "/api/equipment", laptop)).status).toBe(
      403,
    );
    expect(
      (await member.json("PATCH", `/api/equipment/${id}`, { make: "Dell" }))
        .status,
    ).toBe(403);
    expect((await member.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      403,
    );

    for (const method of ["GET", "PATCH", "DELETE"]) {
      expect(
        (await owner.json(method, "/api/equipment/equipment-other", {})).status,
      ).toBe(404);
    }
  });

  it("unassigns equipment when its assignee leaves the organization", async () => {
    const { as, database } = createFixture();
    const owner = as("owner-user", "owner");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    database.query("DELETE FROM member WHERE userId = 'member-user'").run();
    const detail = await owner.json<{ equipment: Equipment }>(
      "GET",
      `/api/equipment/${created.body.equipment.id}`,
    );
    expect(detail.body.equipment.assignee).toBeNull();
  });

  it("records who added, changed, assigned, and deleted equipment", async () => {
    const { as, database } = createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;
    const history = async () =>
      (
        await member.json<{ events: ActivityEvent[] }>(
          "GET",
          `/api/equipment/${id}/activity`,
        )
      ).body.events.map(({ action, actor, details, root }) => ({
        action,
        actor: actor.id,
        details,
        label: root.label,
      }));

    // Saves that change nothing, or are rejected, record nothing.
    await owner.json("PATCH", `/api/equipment/${id}`, {
      assigneeId: "member-user",
      make: "Apple",
    });
    await owner.json("PATCH", `/api/equipment/${id}`, {
      assigneeId: "other-user",
      model: "Rejected",
    });
    await member.json("PATCH", `/api/equipment/${id}`, { model: "Denied" });
    await owner.json("PATCH", `/api/equipment/${id}`, {
      model: "MacBook Air",
      serialNumber: "",
      type: "computer",
    });
    // A raw membership delete (no request, as in a purge) unassigns without
    // an actor. Removal and leaving through Better Auth record it
    // (organizations/membershipActivity.test.ts).
    database.query("DELETE FROM member WHERE userId = 'member-user'").run();
    await owner.json("PATCH", `/api/equipment/${id}`, {
      assigneeId: "owner-user",
      purchaseDate: "2026-04-01",
    });
    expect(
      database
        .query("SELECT activity_actor_id FROM equipment WHERE id = ?")
        .get(id),
    ).toEqual({ activity_actor_id: null });

    const recorded = [
      {
        action: "equipment.assigned",
        actor: "owner-user",
        details: {
          after: "owner-user",
          afterEmail: "owner-user@example.com",
          afterName: "owner-user",
          before: null,
          beforeEmail: null,
          beforeName: null,
        },
        label: "Apple MacBook Air",
      },
      {
        action: "equipment.updated",
        actor: "owner-user",
        details: {
          changes: [
            {
              after: "2026-04-01",
              before: "2026-03-01",
              field: "purchaseDate",
            },
          ],
        },
        label: "Apple MacBook Air",
      },
      {
        action: "equipment.updated",
        actor: "owner-user",
        details: {
          changes: [
            { after: "MacBook Air", before: "MacBook Pro", field: "model" },
            { after: null, before: "C02XYZ", field: "serialNumber" },
          ],
        },
        label: "Apple MacBook Air",
      },
      {
        action: "equipment.created",
        actor: "owner-user",
        details: {
          assignedTo: "member-user",
          assigneeEmail: "member-user@example.com",
          assigneeName: "member-user",
          make: "Apple",
          model: "MacBook Pro",
          purchaseDate: "2026-03-01",
          serialNumber: "C02XYZ",
          type: "computer",
        },
        label: "Apple MacBook Pro",
      },
    ];
    expect(await history()).toEqual(recorded);
    expect(
      (await owner.json("GET", "/api/equipment/equipment-other/activity"))
        .status,
    ).toBe(404);

    // Deletion is recorded once, and the history outlives the listing.
    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      204,
    );
    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      404,
    );
    expect(
      (await owner.json("GET", `/api/equipment/${id}/activity`)).status,
    ).toBe(404);
    const feed = await owner.json<{ events: ActivityEvent[] }>(
      "GET",
      "/api/activity",
    );
    expect(
      feed.body.events.map(({ action, details, root, subject }) => ({
        action,
        details,
        root: root.type,
        subject: subject.type,
      }))[0],
    ).toEqual({
      action: "equipment.deleted",
      details: {
        assignedTo: "owner-user",
        assigneeEmail: "owner-user@example.com",
        assigneeName: "owner-user",
        make: "Apple",
        model: "MacBook Air",
        purchaseDate: "2026-04-01",
        serialNumber: null,
        type: "computer",
      },
      root: "equipment",
      subject: "equipment",
    });
    expect(feed.body.events.map(({ action }) => action)).toEqual([
      "equipment.deleted",
      ...recorded.map(({ action }) => action),
    ]);
  });

  it("attaches emails and receipts to equipment", async () => {
    const { as, database } = createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;

    const linked = await member.json<{
      link: { equipment: { make: string; model: string; type: string } };
    }>("POST", "/api/inbox/email-1/links", {
      targetId: id,
      targetType: "equipment",
    });
    expect(linked.status).toBe(201);
    expect(linked.body.link.equipment).toMatchObject({
      make: "Apple",
      model: "MacBook Pro",
      type: "computer",
    });
    expect(
      (
        await member.json("POST", "/api/inbox/email-1/links", {
          targetId: "equipment-other",
          targetType: "equipment",
        })
      ).status,
    ).toBe(404);

    const detail = await member.json<{
      emails: Array<{ id: string; subject: string }>;
      equipment: Equipment;
    }>("GET", `/api/equipment/${id}`);
    expect(detail.body.equipment.emailCount).toBe(1);
    expect(detail.body.emails).toEqual([
      expect.objectContaining({
        id: "email-1",
        subject: "Your laptop receipt",
      }),
    ]);

    expect((await member.json("DELETE", "/api/inbox/email-1")).status).toBe(
      409,
    );
    expect(
      (await member.json("POST", "/api/inbox/email-1/archive")).status,
    ).toBe(200);
    expect(
      (await member.json<{ equipment: Equipment[] }>("GET", "/api/equipment"))
        .body.equipment[0]?.emailCount,
    ).toBe(1);

    // Deleting the item hides its link: the email lists no link, can move to
    // Trash, and cannot link to the item again until it is restored.
    await owner.json("DELETE", `/api/equipment/${id}`);
    const hidden = await member.json<{
      email: { linkCount: number; links: unknown[] };
    }>("GET", "/api/inbox/email-1?folder=archived");
    expect(hidden.body.email).toMatchObject({ linkCount: 0, links: [] });
    expect(
      (
        await member.json("POST", "/api/inbox/email-1/links", {
          targetId: id,
          targetType: "equipment",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner.json<{ equipment: Equipment }>(
          "POST",
          `/api/equipment/${id}/restore`,
        )
      ).body.equipment.emailCount,
    ).toBe(1);
    expect(
      (
        await member.json<{ email: { linkCount: number } }>(
          "GET",
          "/api/inbox/email-1?folder=archived",
        )
      ).body.email.linkCount,
    ).toBe(1);
    // While the item is deleted its email can move to Trash, and the link
    // stays for the restore.
    await owner.json("DELETE", `/api/equipment/${id}`);
    expect((await member.json("DELETE", "/api/inbox/email-1")).status).toBe(
      200,
    );

    // Deletes that bypass the API, such as organization cascades, rely on the
    // trigger alone.
    database
      .query(
        `INSERT INTO inbound_email_links
         (id, organization_id, email_id, target_type, target_id, created_at)
         VALUES ('link-other', 'org-2', 'email-1', 'equipment',
                 'equipment-other', ?)`,
      )
      .run(timestamp);
    database.query("DELETE FROM equipment WHERE id = 'equipment-other'").run();
    expect(
      database.query("SELECT target_id FROM inbound_email_links").all(),
    ).toEqual([{ target_id: id }]);
  });
});

describe("equipment deletion and restore", () => {
  it("hides the item until a manager restores it as it was", async () => {
    const { as } = createFixture();
    const owner = as("owner-user", "owner");
    const member = as("member-user", "member");
    const created = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const id = created.body.equipment.id;
    await member.json("POST", "/api/inbox/email-1/links", {
      targetId: id,
      targetType: "equipment",
    });

    expect((await member.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      403,
    );
    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      204,
    );
    // A second delete finds nothing and records nothing.
    expect((await owner.json("DELETE", `/api/equipment/${id}`)).status).toBe(
      404,
    );
    expect(
      (await member.json<{ equipment: Equipment[] }>("GET", "/api/equipment"))
        .body.equipment,
    ).toEqual([]);
    for (const [method, path] of [
      ["GET", `/api/equipment/${id}`],
      ["GET", `/api/equipment/${id}/activity`],
      ["PATCH", `/api/equipment/${id}`],
    ] as const) {
      expect((await owner.json(method, path, { model: "Hidden" })).status).toBe(
        404,
      );
    }

    const deleted = await member.json<{
      canManage: boolean;
      equipment: Array<
        Equipment & { deletedAt: string; deletedBy: { id: string } | null }
      >;
    }>("GET", "/api/equipment/deleted");
    expect(deleted.body).toMatchObject({
      canManage: false,
      equipment: [
        {
          assignee: { id: "member-user" },
          deletedAt: expect.any(String),
          deletedBy: { id: "owner-user", name: "owner-user" },
          emailCount: 1,
          id,
          model: "MacBook Pro",
        },
      ],
    });

    for (const [requester, path, status] of [
      [member, `/api/equipment/${id}/restore`, 403],
      // Restoring an item that is not deleted, or another organization's.
      [owner, "/api/equipment/equipment-other/restore", 404],
    ] as const) {
      expect((await requester.json("POST", path)).status).toBe(status);
    }
    const restored = await owner.json<{ equipment: Equipment }>(
      "POST",
      `/api/equipment/${id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(restored.body.equipment).toMatchObject({
      assignee: { id: "member-user" },
      emailCount: 1,
      id,
    });
    expect(
      (await owner.json("POST", `/api/equipment/${id}/restore`)).status,
    ).toBe(404);
    expect(
      (
        await member.json<{ equipment: unknown[] }>(
          "GET",
          "/api/equipment/deleted",
        )
      ).body.equipment,
    ).toEqual([]);

    const snapshot = {
      assignedTo: "member-user",
      assigneeEmail: "member-user@example.com",
      assigneeName: "member-user",
      make: "Apple",
      model: "MacBook Pro",
      purchaseDate: "2026-03-01",
      serialNumber: "C02XYZ",
      type: "computer",
    };
    const history = await member.json<{ events: ActivityEvent[] }>(
      "GET",
      `/api/equipment/${id}/activity`,
    );
    expect(
      history.body.events.map(({ action, actor, details, subject }) => ({
        action,
        actor: actor.id,
        details,
        subject: subject.type,
      })),
    ).toEqual([
      {
        action: "equipment.restored",
        actor: "owner-user",
        details: snapshot,
        subject: "equipment",
      },
      {
        action: "equipment.deleted",
        actor: "owner-user",
        details: snapshot,
        subject: "equipment",
      },
      {
        action: "inbox.email_linked",
        actor: "member-user",
        details: {
          from: "orders@store.example",
          subject: "Your laptop receipt",
        },
        subject: "inbound_email",
      },
      {
        action: "equipment.created",
        actor: "owner-user",
        details: snapshot,
        subject: "equipment",
      },
    ]);
    // The link never ended, so the email's history shows only its start.
    const emailHistory = await member.json<{ events: ActivityEvent[] }>(
      "GET",
      "/api/inbox/email-1/activity",
    );
    expect(
      emailHistory.body.events.map(({ action, root }) => [action, root.label]),
    ).toEqual([["inbox.email_linked", "Apple MacBook Pro"]]);
  });

  it("records an unassigned item's empty holder, and rolls back on failure", async () => {
    const { as, database } = createFixture();
    const owner = as("owner-user", "owner");
    const unassigned = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      { ...laptop, assigneeId: null },
    );
    await owner.json(
      "DELETE",
      `/api/equipment/${unassigned.body.equipment.id}`,
    );
    expect(
      database
        .query(
          "SELECT details FROM activity_events WHERE action = 'equipment.deleted'",
        )
        .all()
        .map((row) => JSON.parse((row as { details: string }).details)),
    ).toEqual([
      expect.objectContaining({
        assignedTo: null,
        assigneeEmail: null,
        assigneeName: null,
      }),
    ]);

    const kept = await owner.json<{ equipment: Equipment }>(
      "POST",
      "/api/equipment",
      laptop,
    );
    const events = () =>
      database.query("SELECT COUNT(*) AS count FROM activity_events").get();
    const before = events();
    database
      .query(
        `CREATE TRIGGER fail_activity BEFORE INSERT ON activity_events
         BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`,
      )
      .run();
    for (const [method, path] of [
      ["DELETE", `/api/equipment/${kept.body.equipment.id}`],
      ["POST", `/api/equipment/${unassigned.body.equipment.id}/restore`],
    ] as const) {
      expect((await owner.json(method, path)).status).toBe(500);
    }
    expect(events()).toEqual(before);
    expect(
      database
        .query("SELECT id, deleted_at FROM equipment ORDER BY created_at, id")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { deleted_at: null, id: kept.body.equipment.id },
        { deleted_at: expect.any(String), id: unassigned.body.equipment.id },
      ]),
    );
  });
});

function createFixture() {
  const database = createTestDatabase();
  seed(database);
  const raw = new TextEncoder().encode(rawEmail);
  const bindings = testBindings({
    DB: toD1(database),
    STORAGE: {
      get: async () => ({ arrayBuffer: async () => raw.slice().buffer }),
    } as unknown as R2Bucket,
  });
  const routes = {
    "/api/activity": activity,
    "/api/equipment": equipment,
    "/api/inbox": inbox,
  };
  const as = (userId: string, role: string) => ({
    json: requester(
      testApp(routes, {
        organizationId: "org-1",
        organizationRole: role,
        userId,
      }),
      bindings,
    ),
  });
  return { as, database };
}

function seed(database: Database) {
  const run = (query: string, ...values: SQLQueryBindings[]) =>
    database.query(query).run(...values);
  for (const id of ["owner-user", "member-user", "other-user"])
    seedUser(database, { createdAt: timestamp, id });
  for (const id of ["org-1", "org-2"])
    seedOrganization(database, { createdAt: timestamp, id });
  for (const [id, organizationId, userId, role] of [
    ["member-owner", "org-1", "owner-user", "owner"],
    ["member-member", "org-1", "member-user", "member"],
    ["member-other", "org-2", "other-user", "owner"],
  ] as const)
    seedMember(database, {
      createdAt: timestamp,
      id,
      organizationId,
      role,
      userId,
    });
  run(
    `INSERT INTO inbound_emails
     (id, organization_id, envelope_from, envelope_to, subject,
      raw_object_key, raw_size, received_at)
     VALUES ('email-1', 'org-1', 'orders@store.example',
             'upload@inbox.balebase.com', 'Your laptop receipt',
             'raw/email-1', 1, ?)`,
    timestamp,
  );
  run(
    `INSERT INTO library_folders
     (id, organization_id, name, created_at, updated_at)
     VALUES ('folder-1', 'org-1', 'Receipts', ?, ?)`,
    timestamp,
    timestamp,
  );
  run(
    `INSERT INTO equipment
     (id, organization_id, type, make, model, created_at, updated_at)
     VALUES ('equipment-other', 'org-2', 'monitor', 'Dell', 'U2723QE', ?, ?)`,
    timestamp,
    timestamp,
  );
}
