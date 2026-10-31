import { describe, expect, it } from "bun:test";
import { libraryFixture } from "../testing/libraryFixture";

interface Page {
  events: Array<{
    action: string;
    actor: { apiKey: { channel: string; name: string } | null; id: string };
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  }>;
}

interface EmailLink {
  id: string;
  targetType: string;
}

describe("inbox activity", () => {
  it("keeps who trashed, archived, and restored an email", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const owner = fixture.as("owner-user");

    expect((await member("DELETE", "/api/inbox/email-1")).status).toBe(200);
    expect((await member("DELETE", "/api/inbox/email-1")).status).toBe(404);
    expect((await member("POST", "/api/inbox/email-1/archive")).status).toBe(
      404,
    );
    expect((await owner("POST", "/api/inbox/email-1/restore")).status).toBe(
      200,
    );
    expect((await owner("POST", "/api/inbox/email-1/restore")).status).toBe(
      404,
    );
    expect((await member("POST", "/api/inbox/email-1/archive")).status).toBe(
      200,
    );
    expect((await member("POST", "/api/inbox/email-1/archive")).status).toBe(
      404,
    );
    fixture.useApiKey("mcp");
    expect((await owner("POST", "/api/inbox/email-1/restore")).status).toBe(
      200,
    );
    expect((await owner("DELETE", "/api/inbox/nope")).status).toBe(404);

    expect(
      fixture
        .events("root_type = 'inbound_email'")
        .map((event) => [
          event.action,
          event.actor_user_id,
          event.actor_api_key_name,
          event.actor_api_key_channel,
          event.details,
        ]),
    ).toEqual([
      [
        "inbox.email_trashed",
        "member-user",
        null,
        null,
        { from: "sender@example.com", fromStatus: "inbox" },
      ],
      [
        "inbox.email_restored",
        "owner-user",
        null,
        null,
        { from: "sender@example.com", fromStatus: "trash" },
      ],
      [
        "inbox.email_archived",
        "member-user",
        null,
        null,
        { from: "sender@example.com", fromStatus: "inbox" },
      ],
      [
        "inbox.email_restored",
        "owner-user",
        "Automation",
        "mcp",
        { from: "sender@example.com", fromStatus: "archived" },
      ],
    ]);
    expect(
      fixture
        .events("root_type = 'inbound_email'")
        .map((event) => [event.root_id, event.root_label, event.subject_type]),
    ).toContainEqual(["email-1", "Lease renewal", "inbound_email"]);

    await member("DELETE", "/api/inbox/email-2");
    expect(
      fixture.events("root_id = 'email-2'").map(({ root_label }) => root_label),
    ).toEqual(["(No subject)"]);
  });

  it("records nothing when a linked email cannot be trashed", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    await member("POST", "/api/inbox/email-1/links", {
      targetId: "equipment-1",
      targetType: "equipment",
    });
    expect((await member("DELETE", "/api/inbox/email-1")).status).toBe(409);
    expect(fixture.events("action = 'inbox.email_trashed'")).toEqual([]);
  });

  it("records links on the linked record, keeping Finance links private", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    const finance = fixture.as("finance-user");
    const folder = await member<{ folder: { id: string } }>(
      "POST",
      "/api/library/folders",
      { name: "Leases" },
    );
    const folderId = folder.body.folder.id;

    for (const target of [
      { targetId: folderId, targetType: "library_folder" },
      { targetId: "equipment-1", targetType: "equipment" },
    ]) {
      expect(
        (await member("POST", "/api/inbox/email-1/links", target)).status,
      ).toBe(201);
      // Linking again is harmless and records nothing.
      expect(
        (await member("POST", "/api/inbox/email-1/links", target)).status,
      ).toBe(200);
    }
    const transaction = {
      targetId: "txn-1",
      targetType: "finance_transaction",
    };
    expect(
      (await member("POST", "/api/inbox/email-1/links", transaction)).status,
    ).toBe(403);
    expect(
      (
        await member("POST", "/api/inbox/email-1/links", {
          targetId: "missing",
          targetType: "equipment",
        })
      ).status,
    ).toBe(404);
    expect(
      (await finance("POST", "/api/inbox/email-1/links", transaction)).status,
    ).toBe(201);

    expect(
      fixture
        .events("action = 'inbox.email_linked'")
        .map((event) => [
          event.root_type,
          event.root_id,
          event.root_label,
          event.subject_type,
          event.subject_id,
          event.actor_user_id,
          event.details,
        ]),
    ).toEqual([
      [
        "library_folder",
        folderId,
        "Leases",
        "inbound_email",
        "email-1",
        "member-user",
        { from: "sender@example.com", subject: "Lease renewal" },
      ],
      [
        "equipment",
        "equipment-1",
        "Dell XPS 13",
        "inbound_email",
        "email-1",
        "member-user",
        { from: "sender@example.com", subject: "Lease renewal" },
      ],
      [
        "finance_transaction",
        "txn-1",
        "Test Cafe",
        "inbound_email",
        "email-1",
        "finance-user",
        { from: "sender@example.com", subject: "Lease renewal" },
      ],
    ]);
    fixture.useApiKey("rest");
    await fixture.as("owner-user")("POST", "/api/inbox/email-2/links", {
      targetId: folderId,
      targetType: "library_folder",
    });
    fixture.state.apiKey = undefined;
    expect(
      fixture
        .events("subject_id = 'email-2'")
        .map((event) => [
          event.actor_user_id,
          event.actor_api_key_name,
          event.actor_api_key_channel,
        ]),
    ).toEqual([["owner-user", "Automation", "rest"]]);

    const links = fixture.database
      .query(
        `SELECT id, target_type AS targetType FROM inbound_email_links
         WHERE email_id = 'email-1'`,
      )
      .all() as EmailLink[];
    const transactionLink = links.find(
      ({ targetType }) => targetType === "finance_transaction",
    );
    const folderLink = links.find(
      ({ targetType }) => targetType === "library_folder",
    );
    expect(
      (
        await member(
          "DELETE",
          `/api/inbox/email-1/links/${transactionLink?.id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await member("DELETE", `/api/inbox/email-1/links/${folderLink?.id}`))
        .status,
    ).toBe(204);
    expect(
      (await member("DELETE", `/api/inbox/email-1/links/${folderLink?.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await finance(
          "DELETE",
          `/api/inbox/email-1/links/${transactionLink?.id}`,
        )
      ).status,
    ).toBe(204);
    expect(
      fixture
        .events("action = 'inbox.email_unlinked'")
        .map((event) => [
          event.root_type,
          event.root_label,
          event.actor_user_id,
        ]),
    ).toEqual([
      ["library_folder", "Leases", "member-user"],
      ["finance_transaction", "Test Cafe", "finance-user"],
    ]);

    const actions = (page: Page) =>
      page.events.map(({ action, root }) => `${action}:${root.type}`);
    const memberHistory = await member<Page>(
      "GET",
      "/api/inbox/email-1/activity",
    );
    expect(actions(memberHistory.body)).toEqual([
      "inbox.email_unlinked:library_folder",
      "inbox.email_linked:equipment",
      "inbox.email_linked:library_folder",
    ]);
    const financeHistory = await finance<Page>(
      "GET",
      "/api/inbox/email-1/activity",
    );
    expect(actions(financeHistory.body)).toEqual([
      "inbox.email_unlinked:finance_transaction",
      "inbox.email_unlinked:library_folder",
      "inbox.email_linked:finance_transaction",
      "inbox.email_linked:equipment",
      "inbox.email_linked:library_folder",
    ]);
    const memberFeed = await member<Page>("GET", "/api/activity");
    expect(
      memberFeed.body.events.filter(
        ({ root }) => root.type === "finance_transaction",
      ),
    ).toEqual([]);
    expect(
      (
        await member<Page>(
          "GET",
          "/api/activity?resourceType=finance_transaction",
        )
      ).body.events,
    ).toEqual([]);
    const financeFeed = await finance<Page>(
      "GET",
      "/api/activity?resourceType=finance_transaction",
    );
    expect(financeFeed.body.events).toHaveLength(2);
    expect(
      (await fixture.as("other-user")("GET", "/api/inbox/email-1/activity"))
        .status,
    ).toBe(404);
  });

  it("rolls the change back when its event cannot be recorded", async () => {
    const fixture = libraryFixture();
    const member = fixture.as("member-user");
    await member("POST", "/api/inbox/email-2/links", {
      targetId: "equipment-1",
      targetType: "equipment",
    });
    fixture.failActivity();

    expect((await member("DELETE", "/api/inbox/email-1")).status).toBe(500);
    expect((await member("POST", "/api/inbox/email-1/archive")).status).toBe(
      500,
    );
    expect(
      (
        await member("POST", "/api/inbox/email-1/links", {
          targetId: "equipment-1",
          targetType: "equipment",
        })
      ).status,
    ).toBe(500);
    const link = fixture.database
      .query("SELECT id FROM inbound_email_links")
      .get() as { id: string };
    expect(
      (await member("DELETE", `/api/inbox/email-2/links/${link.id}`)).status,
    ).toBe(500);

    expect(
      fixture.database
        .query(
          `SELECT id, archived_at, deleted_at FROM inbound_emails ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { archived_at: null, deleted_at: null, id: "email-1" },
      { archived_at: null, deleted_at: null, id: "email-2" },
    ]);
    expect(
      fixture.database.query("SELECT email_id FROM inbound_email_links").all(),
    ).toEqual([{ email_id: "email-2" }]);
  });
});
