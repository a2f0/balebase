import { describe, expect, it } from "bun:test";
import { libraryFixture } from "../testing/libraryFixture";

type Fixture = ReturnType<typeof libraryFixture>;

interface Page {
  events: Array<{
    action: string;
    actor: { id: string };
    details: Record<string, unknown>;
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  }>;
  nextCursor: string | null;
}

async function createFolder(fixture: Fixture, name: string) {
  const created = await fixture.as("member-user")<{
    folder: { id: string };
  }>("POST", "/api/library/folders", { name });
  expect(created.status).toBe(201);
  return created.body.folder.id;
}

async function upload(
  fixture: Fixture,
  filename: string,
  folderId?: string,
  userId = "member-user",
) {
  const form = new FormData();
  form.set("file", new File(["contents"], filename, { type: "text/plain" }));
  if (folderId) form.set("folderId", folderId);
  const uploaded = await fixture.as(userId)<{ object: { id: string } }>(
    "POST",
    "/api/objects",
    form,
  );
  expect(uploaded.status).toBe(201);
  return uploaded.body.object.id;
}

const summary = (page: Page) =>
  page.events.map(({ action, details, root }) => [
    action,
    root.label,
    Reflect.get(details, "via") ?? null,
  ]);

describe("library record history", () => {
  it("lists the files filed into, moved out of, and deleted from a folder", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const leases = await createFolder(fixture, "Leases");
    const taxes = await createFolder(fixture, "Taxes");
    const lease = await upload(fixture, "lease.pdf", leases);
    const w2 = await upload(fixture, "w2.pdf", taxes);
    const loose = await upload(fixture, "loose.pdf");
    await member("PATCH", `/api/objects/${loose}`, { folderId: leases });
    await member("PATCH", `/api/objects/${lease}`, { folderId: null });
    await member("PATCH", `/api/objects/${w2}`, { folderId: leases });
    await member("DELETE", `/api/objects/${w2}`);
    // Another organization's file events never appear, even if they name
    // the folder's id.
    fixture.database
      .query(
        `INSERT INTO activity_events
           (organization_id, root_type, root_id, root_label, subject_type,
            subject_id, action, actor_user_id, actor_name, actor_email,
            occurred_at, details)
         VALUES ('org-2', 'library_file', 'x', 'x.pdf', 'library_file', 'x',
                 'library.file_uploaded', 'other-user', 'o', 'o@example.com',
                 '2026-10-01T00:00:00.000Z', json_object('folderId', ?))`,
      )
      .run(leases);

    const history = await member<Page>(
      "GET",
      `/api/library/folders/${leases}/activity`,
    );
    expect(summary(history.body)).toEqual([
      ["library.file_deleted", "w2.pdf", null],
      ["library.file_moved", "w2.pdf", null],
      ["library.file_moved", "lease.pdf", null],
      ["library.file_moved", "loose.pdf", null],
      ["library.file_uploaded", "lease.pdf", null],
      ["library.folder_created", "Leases", null],
    ]);
    const taxHistory = await member<Page>(
      "GET",
      `/api/library/folders/${taxes}/activity`,
    );
    expect(summary(taxHistory.body)).toEqual([
      ["library.file_moved", "w2.pdf", null],
      ["library.file_uploaded", "w2.pdf", null],
      ["library.folder_created", "Taxes", null],
    ]);
  });

  it("keeps a file's own history, readable after the file is deleted", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const folder = await createFolder(fixture, "Leases");
    const file = await upload(fixture, "lease.pdf", folder);
    const other = await upload(fixture, "other.pdf");
    await member("PATCH", `/api/objects/${file}`, { folderId: null });
    await member("DELETE", `/api/objects/${file}`);

    const history = await member<Page>("GET", `/api/objects/${file}/activity`);
    expect(history.status).toBe(200);
    expect(
      history.body.events.map(({ action, actor, root }) => [
        action,
        actor.id,
        root.id,
      ]),
    ).toEqual([
      ["library.file_deleted", "member-user", file],
      ["library.file_moved", "member-user", file],
      ["library.file_uploaded", "member-user", file],
    ]);
    expect(
      (await member<Page>("GET", `/api/objects/${other}/activity`)).body.events,
    ).toHaveLength(1);
    // Outsiders, unknown files, and bad cursors are refused.
    expect(
      (await fixture.as("other-user")("GET", `/api/objects/${file}/activity`))
        .status,
    ).toBe(404);
    expect((await member("GET", "/api/objects/missing/activity")).status).toBe(
      404,
    );
    expect(
      (await member("GET", `/api/objects/${other}/activity?cursor=x`)).status,
    ).toBe(400);
  });

  it("records each file a folder's deletion returns, and each email link it ends", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const folder = await createFolder(fixture, "Leases");
    const file = await upload(fixture, "lease.pdf", folder);
    await upload(fixture, "elsewhere.pdf");
    for (const email of ["email-1", "email-2"])
      await member("POST", `/api/inbox/${email}/links`, {
        targetId: folder,
        targetType: "library_folder",
      });
    await member("POST", "/api/inbox/email-1/links", {
      targetId: "equipment-1",
      targetType: "equipment",
    });

    expect(
      (
        await fixture.as("owner-user")(
          "DELETE",
          `/api/library/folders/${folder}`,
        )
      ).status,
    ).toBe(204);
    expect(
      fixture
        .events(
          "id > (SELECT MAX(id) FROM activity_events WHERE action = 'inbox.email_linked')",
        )
        .map(({ action, actor_user_id, details, root_type, subject_id }) => [
          action,
          root_type,
          subject_id,
          actor_user_id,
          Reflect.get(details, "via") ?? null,
        ]),
    ).toEqual([
      [
        "library.file_moved",
        "library_file",
        file,
        "owner-user",
        "folder_deleted",
      ],
      [
        "inbox.email_unlinked",
        "library_folder",
        "email-1",
        "owner-user",
        "target_deleted",
      ],
      [
        "inbox.email_unlinked",
        "library_folder",
        "email-2",
        "owner-user",
        "target_deleted",
      ],
      ["library.folder_deleted", "library_folder", folder, "owner-user", null],
    ]);

    // The email's own history now shows the link ending, with the folder's
    // name, and the other link stays.
    const emailHistory = await member<Page>(
      "GET",
      "/api/inbox/email-1/activity",
    );
    expect(summary(emailHistory.body).slice(0, 3)).toEqual([
      ["inbox.email_unlinked", "Leases", "target_deleted"],
      ["inbox.email_linked", "Dell XPS 13", null],
      ["inbox.email_linked", "Leases", null],
    ]);
    expect(emailHistory.body.events[0]).toMatchObject({
      actor: { id: "owner-user" },
      details: { from: expect.any(String), subject: "Lease renewal" },
      subject: { id: "email-1", type: "inbound_email" },
    });
    // The file's history shows it leaving the deleted folder.
    expect(
      summary(
        (await member<Page>("GET", `/api/objects/${file}/activity`)).body,
      ),
    ).toEqual([
      ["library.file_moved", "lease.pdf", "folder_deleted"],
      ["library.file_uploaded", "lease.pdf", null],
    ]);
    expect(
      fixture.database
        .query("SELECT target_type FROM inbound_email_links")
        .all(),
    ).toEqual([{ target_type: "equipment" }]);
  });

  it("records nothing extra for an empty folder, and nothing at all on failure", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const empty = await createFolder(fixture, "Empty");
    await member("DELETE", `/api/library/folders/${empty}`);
    expect(
      fixture
        .events("action <> 'library.folder_created'")
        .map(({ action }) => action),
    ).toEqual(["library.folder_deleted"]);

    const folder = await createFolder(fixture, "Leases");
    const file = await upload(fixture, "lease.pdf", folder);
    await member("POST", "/api/inbox/email-1/links", {
      targetId: folder,
      targetType: "library_folder",
    });
    const before = fixture.events().length;
    fixture.failActivity();
    expect(
      (await member("DELETE", `/api/library/folders/${folder}`)).status,
    ).toBe(500);
    expect(fixture.events()).toHaveLength(before);
    expect(
      fixture.database
        .query("SELECT folder_id FROM objects WHERE id = ?")
        .get(file),
    ).toEqual({ folder_id: folder });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM inbound_email_links")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM library_folders WHERE id = ?")
        .get(folder),
    ).toEqual({ count: 1 });
  });
});
