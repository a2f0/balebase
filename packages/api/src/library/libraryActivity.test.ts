import { describe, expect, it, spyOn } from "bun:test";
import { libraryFixture } from "../testing/libraryFixture";

interface Folder {
  id: string;
  name: string;
}

interface StoredObject {
  folderId: string | null;
  id: string;
  objectKey: string;
}

interface Page {
  events: Array<{
    action: string;
    actor: { apiKey: { channel: string; name: string } | null; id: string };
    details: Record<string, unknown>;
    root: { id: string; label: string; type: string };
  }>;
}

function upload(
  fixture: ReturnType<typeof libraryFixture>,
  filename: string,
  folderId?: string,
) {
  const form = new FormData();
  form.set("file", new File(["contents"], filename, { type: "text/plain" }));
  if (folderId) form.set("folderId", folderId);
  return fixture.as("member-user")<{ object: StoredObject }>(
    "POST",
    "/api/objects",
    form,
  );
}

async function createFolder(
  fixture: ReturnType<typeof libraryFixture>,
  name: string,
) {
  const created = await fixture.as("member-user")<{ folder: Folder }>(
    "POST",
    "/api/library/folders",
    {
      name,
    },
  );
  expect(created.status).toBe(201);
  return created.body.folder;
}

describe("library activity", () => {
  it("records each file upload, move, and deletion with its actor", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const folder = await createFolder(fixture, "Taxes");

    const uploaded = await upload(fixture, "w2.txt", folder.id);
    expect(uploaded.status).toBe(201);
    const file = uploaded.body.object;
    expect(fixture.events("root_type = 'library_file'")).toEqual([
      {
        action: "library.file_uploaded",
        actor_api_key_channel: null,
        actor_api_key_name: null,
        actor_user_id: "member-user",
        details: {
          contentType: "text/plain;charset=utf-8",
          filename: "w2.txt",
          folderId: folder.id,
          folderName: "Taxes",
          size: 8,
        },
        root_id: file.id,
        root_label: "w2.txt",
        root_type: "library_file",
        subject_id: file.id,
        subject_type: "library_file",
      },
    ]);

    // Moving a file where it already is, or to a missing folder, records
    // nothing.
    expect(
      (
        await member("PATCH", `/api/objects/${file.id}`, {
          folderId: folder.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await member("PATCH", `/api/objects/${file.id}`, { folderId: "nope" }))
        .status,
    ).toBe(404);
    expect(fixture.events("root_type = 'library_file'")).toHaveLength(1);

    const moved = await member<{ object: StoredObject }>(
      "PATCH",
      `/api/objects/${file.id}`,
      { folderId: null },
    );
    expect(moved.body.object.folderId).toBeNull();
    expect(fixture.events("action = 'library.file_moved'")).toMatchObject([
      {
        actor_user_id: "member-user",
        details: {
          filename: "w2.txt",
          fromFolderId: folder.id,
          fromFolderName: "Taxes",
          toFolderId: null,
          toFolderName: null,
        },
      },
    ]);

    expect((await member("DELETE", `/api/objects/${file.id}`)).status).toBe(
      204,
    );
    expect(fixture.stored.has(file.objectKey)).toBe(false);
    expect(
      fixture.database.query("SELECT * FROM deleted_object_cleanup").all(),
    ).toEqual([]);
    expect((await member("DELETE", `/api/objects/${file.id}`)).status).toBe(
      404,
    );
    const deleted = fixture.events("action = 'library.file_deleted'");
    expect(deleted).toMatchObject([
      {
        actor_user_id: "member-user",
        details: { filename: "w2.txt", folderId: null, size: 8 },
        root_label: "w2.txt",
      },
    ]);
    // Never the storage key or contents.
    expect(JSON.stringify(fixture.events())).not.toContain(file.objectKey);

    // History outlives the file and is visible to members of the
    // organization only.
    const feed = await fixture.as("owner-user")<Page>(
      "GET",
      "/api/activity?resourceType=library_file",
    );
    expect(feed.body.events.map(({ action }) => action)).toEqual([
      "library.file_deleted",
      "library.file_moved",
      "library.file_uploaded",
    ]);
    const outside = await fixture.as("other-user")<Page>(
      "GET",
      "/api/activity?resourceType=library_file",
    );
    expect(outside.body.events).toEqual([]);
  });

  it("keeps a deletion, queueing the bytes, when removing them fails", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const file = (await upload(fixture, "w2.txt")).body.object;
    fixture.storage.delete = async () => {
      throw new Error("R2 unavailable");
    };
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await member("DELETE", `/api/objects/${file.id}`)).status).toBe(
        204,
      );
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(fixture.events("action = 'library.file_deleted'")).toHaveLength(1);
    expect(
      fixture.database
        .query("SELECT object_key FROM deleted_object_cleanup")
        .all(),
    ).toEqual([{ object_key: file.objectKey }]);
    expect((await member("DELETE", `/api/objects/${file.id}`)).status).toBe(
      404,
    );
  });

  it("names the API key and channel a file was changed through", async () => {
    const fixture = libraryFixture();
    const owner = fixture.as("owner-user");
    fixture.useApiKey("mcp");
    const form = new FormData();
    form.set("file", new File(["contents"], "lease.txt"));
    const uploaded = await owner<{ object: StoredObject }>(
      "POST",
      "/api/objects",
      form,
    );
    fixture.useApiKey("rest");
    await owner("DELETE", `/api/objects/${uploaded.body.object.id}`);
    expect(
      fixture
        .events("root_type = 'library_file'")
        .map(({ action, actor_api_key_channel, actor_api_key_name }) => [
          action,
          actor_api_key_name,
          actor_api_key_channel,
        ]),
    ).toEqual([
      ["library.file_uploaded", "Automation", "mcp"],
      ["library.file_deleted", "Automation", "rest"],
    ]);
  });

  it("records nothing for an upload that expired before it was saved", async () => {
    const fixture = libraryFixture();
    fixture.hooks.before("INSERT INTO objects", () => {
      fixture.database
        .query("UPDATE deleted_object_cleanup SET cleanup_token = 'claimed'")
        .run();
    });
    expect((await upload(fixture, "late.txt")).status).toBe(409);
    expect(fixture.events()).toEqual([]);
  });

  it("records folder changes, counting what a deletion unfiles and unlinks", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const folder = await createFolder(fixture, "Taxes");
    await createFolder(fixture, "Contracts");
    const path = `/api/library/folders/${folder.id}`;

    expect((await member("PATCH", path, { name: "Taxes" })).status).toBe(200);
    expect((await member("PATCH", path, { name: "contracts" })).status).toBe(
      409,
    );
    expect(
      (await member("PATCH", "/api/library/folders/nope", { name: "X" }))
        .status,
    ).toBe(404);
    expect(fixture.events("action = 'library.folder_renamed'")).toEqual([]);

    await member("PATCH", path, { name: "Tax returns" });
    // A change of letter case is a rename.
    await member("PATCH", path, { name: "tax returns" });
    expect(
      fixture
        .events("action = 'library.folder_renamed'")
        .map(({ details, root_label }) => [root_label, details]),
    ).toEqual([
      ["Tax returns", { after: "Tax returns", before: "Taxes" }],
      ["tax returns", { after: "tax returns", before: "Tax returns" }],
    ]);

    await upload(fixture, "w2.txt", folder.id);
    await member("POST", "/api/inbox/email-1/links", {
      targetId: folder.id,
      targetType: "library_folder",
    });
    const history = await member<Page>("GET", `${path}/activity`);
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "inbox.email_linked",
      "library.file_uploaded",
      "library.folder_renamed",
      "library.folder_renamed",
      "library.folder_created",
    ]);
    expect(
      (await fixture.as("other-user")("GET", `${path}/activity`)).status,
    ).toBe(404);

    expect((await member("DELETE", path)).status).toBe(204);
    expect((await member("DELETE", path)).status).toBe(404);
    expect(fixture.events("action = 'library.folder_deleted'")).toMatchObject([
      {
        actor_user_id: "member-user",
        details: { emailLinkCount: 1, fileCount: 1, name: "tax returns" },
        root_id: folder.id,
        root_label: "tax returns",
      },
    ]);
    const feed = await member<Page>(
      "GET",
      "/api/activity?resourceType=library_folder",
    );
    expect(feed.body.events.map(({ action }) => action)).toEqual([
      "library.folder_deleted",
      "inbox.email_unlinked",
      "inbox.email_linked",
      "library.folder_renamed",
      "library.folder_renamed",
      "library.folder_created",
      "library.folder_created",
    ]);
  });

  it("rolls the change back when its event cannot be recorded", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const folder = await createFolder(fixture, "Taxes");
    const uploaded = await upload(fixture, "w2.txt", folder.id);
    const file = uploaded.body.object;
    fixture.failActivity();

    expect((await upload(fixture, "late.txt")).status).toBe(500);
    expect(
      (await member("PATCH", `/api/objects/${file.id}`, { folderId: null }))
        .status,
    ).toBe(500);
    expect((await member("DELETE", `/api/objects/${file.id}`)).status).toBe(
      500,
    );
    expect(
      (
        await member("PATCH", `/api/library/folders/${folder.id}`, {
          name: "Renamed",
        })
      ).status,
    ).toBe(500);
    expect(
      (await member("DELETE", `/api/library/folders/${folder.id}`)).status,
    ).toBe(500);
    expect(
      (await member("POST", "/api/library/folders", { name: "New" })).status,
    ).toBe(500);

    expect(fixture.stored.has(file.objectKey)).toBe(true);
    expect(
      fixture.database
        .query("SELECT filename, folder_id FROM objects ORDER BY filename")
        .all(),
    ).toEqual([{ filename: "w2.txt", folder_id: folder.id }]);
    expect(
      fixture.database.query("SELECT name FROM library_folders").all(),
    ).toEqual([{ name: "Taxes" }]);
    expect(fixture.stored.size).toBe(1);
  });
});
