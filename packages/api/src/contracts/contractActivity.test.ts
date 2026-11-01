import { describe, expect, it } from "bun:test";
import type { ApiKeyPrincipal } from "../auth/apiEnv";
import {
  type Contract,
  createFixture,
  draft,
  type SentEmail,
  samplePdf,
  signers,
  timestamp,
  uploadTemplate,
} from "../testing/contractFixture";
import {
  resumeStalledContracts,
  sendContractReminders,
} from "./contractReminders";
import { describeEvent } from "./contractWorkflow";

const png = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII="}`;

const viaKey: ApiKeyPrincipal = {
  access: "write",
  channel: "mcp",
  id: "owner-key",
  organizationId: "org-1",
};

type Fixture = ReturnType<typeof createFixture>;

interface ActivityRow {
  action: string;
  actor_api_key_channel: string | null;
  actor_api_key_name: string | null;
  actor_user_id: string;
  details: string;
  organization_id: string;
  root_id: string;
  root_label: string;
}

/** One signer and only their signature, so one signature completes it. */
function singleSigner() {
  return draft({
    fields: draft().fields.filter(
      ({ recipientKey, type }) =>
        recipientKey === "sam" && type === "signature",
    ),
    recipients: [signers[0]],
  });
}

function contractActivity(fixture: Fixture) {
  return fixture.database
    .query(
      `SELECT action, actor_user_id, actor_api_key_name, actor_api_key_channel,
              details, organization_id, root_id, root_label
       FROM activity_events
       WHERE root_type IN ('contract', 'contract_template') ORDER BY id`,
    )
    .all() as ActivityRow[];
}

function seedKey(fixture: Fixture) {
  fixture.database
    .query(
      `INSERT INTO organization_api_keys
       (id, organization_id, name, access, token_prefix, token_hash,
        created_by, created_at)
       VALUES ('owner-key', 'org-1', 'Assistant', 'write', 'test', 'hash',
               'owner-user', ?)`,
    )
    .run(timestamp);
}

function tokenFrom(email: SentEmail | undefined) {
  const token = /\/sign\/([A-Za-z0-9_-]{43})/.exec(email?.text ?? "")?.[1];
  if (!token) throw new Error("No signing link in email.");
  return token;
}

function failInserts(fixture: Fixture, table: string, when: string) {
  fixture.database.exec(
    `CREATE TRIGGER fail_audit BEFORE INSERT ON ${table}
     WHEN ${when} BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
  );
}

async function completedContract(fixture: Fixture) {
  const id = await fixture.prepare(singleSigner());
  await fixture.json("POST", `/api/contracts/${id}/send`);
  const signed = await fixture.json<{ completed: boolean }>(
    "POST",
    `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
    { consent: true, signature: png },
  );
  expect(signed.body.completed).toBe(true);
  return id;
}

describe("contract activity", () => {
  it("keeps a deleted contract's history after its own events are gone", async () => {
    const fixture = createFixture();
    const id = await completedContract(fixture);
    const before = await fixture.json<{
      contract: Contract & { finalSha256: string };
    }>("GET", `/api/contracts/${id}`);
    expect(before.body.contract.events.map(({ type }) => type)).toEqual([
      "created",
      "sent",
      "notified",
      "signed",
      "completed",
    ]);

    // Another member of a different organization finds nothing to delete.
    const elsewhere = fixture.as("other-user", "org-2");
    expect(
      (await elsewhere.json("DELETE", `/api/contracts/${id}`)).status,
    ).toBe(404);
    expect(contractActivity(fixture).map(({ action }) => action)).toEqual([
      "contract.created",
      "contract.sent",
    ]);

    const other = fixture.as("other-user", "org-1");
    expect((await other.json("DELETE", `/api/contracts/${id}`)).status).toBe(
      204,
    );
    expect((await fixture.json("GET", `/api/contracts/${id}`)).status).toBe(
      404,
    );
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_events")
        .get(),
    ).toEqual({ count: 0 });

    const deleted = contractActivity(fixture).at(-1);
    expect(deleted).toMatchObject({
      action: "contract.deleted",
      actor_api_key_name: null,
      actor_user_id: "other-user",
      organization_id: "org-1",
      root_id: id,
      root_label: "Services agreement",
    });
    expect(JSON.parse(deleted?.details ?? "{}")).toEqual({
      completedAt: expect.any(String),
      documentSha256: before.body.contract.document.sha256,
      finalSha256: before.body.contract.finalSha256,
      sentAt: expect.any(String),
      signerCount: 1,
      status: "completed",
      templateName: null,
      templateVersion: null,
      voidedAt: null,
    });
    // No signer emails, IPs, or signatures reach the shared history.
    expect(deleted?.details).not.toContain("sam@example.com");
    expect(deleted?.details).not.toContain("203.0.113.7");

    const feed = await fixture.json<{
      events: Array<{ action: string; actor: { id: string } }>;
    }>("GET", "/api/activity?resourceType=contract");
    expect(feed.body.events.map(({ action }) => action)).toEqual([
      "contract.deleted",
      "contract.sent",
      "contract.created",
    ]);
    expect(feed.body.events[0]?.actor.id).toBe("other-user");
    const otherOrganization = await elsewhere.json<{ events: unknown[] }>(
      "GET",
      "/api/activity?resourceType=contract",
    );
    expect(otherOrganization.body.events).toEqual([]);
  });

  it("records nothing for a refused delete, and rolls one back with its event", async () => {
    const fixture = createFixture();
    const sentId = await fixture.prepare(singleSigner());
    await fixture.json("POST", `/api/contracts/${sentId}/send`);
    const recorded = contractActivity(fixture).length;
    expect(
      (await fixture.json("DELETE", `/api/contracts/${sentId}`)).status,
    ).toBe(409);
    expect(contractActivity(fixture)).toHaveLength(recorded);

    const draftId = await fixture.prepare(singleSigner());
    failInserts(fixture, "activity_events", "NEW.action = 'contract.deleted'");
    expect(
      (await fixture.json("DELETE", `/api/contracts/${draftId}`)).status,
    ).toBe(500);
    expect(
      (await fixture.json("GET", `/api/contracts/${draftId}`)).status,
    ).toBe(200);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("sends and voids together with their events, or not at all", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(singleSigner());
    failInserts(fixture, "contract_events", "NEW.type = 'sent'");
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/send`)).status,
    ).toBe(500);
    const status = () =>
      (
        fixture.database
          .query("SELECT status FROM contracts WHERE id = ?")
          .get(id) as { status: string }
      ).status;
    expect(status()).toBe("draft");
    expect(fixture.emails).toEqual([]);
    fixture.database.exec("DROP TRIGGER fail_audit");

    failInserts(fixture, "activity_events", "NEW.action = 'contract.sent'");
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/send`)).status,
    ).toBe(500);
    expect(status()).toBe("draft");
    fixture.database.exec("DROP TRIGGER fail_audit");

    const sent = await fixture.json<{ contract: Contract }>(
      "POST",
      `/api/contracts/${id}/send`,
    );
    expect(sent.status).toBe(200);
    expect(
      JSON.parse(contractActivity(fixture).at(-1)?.details ?? "{}"),
    ).toEqual({
      documentSha256: sent.body.contract.document.sha256,
      dueDate: "2026-10-01",
      reminderIntervalDays: 2,
      signerCount: 1,
      signingOrder: "parallel",
    });
    // A second send is refused and claims nothing.
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/send`)).status,
    ).toBe(409);

    failInserts(fixture, "contract_events", "NEW.type = 'voided'");
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/void`, { reason: "x" }))
        .status,
    ).toBe(500);
    expect(status()).toBe("sent");
    fixture.database.exec("DROP TRIGGER fail_audit");
    expect(
      (
        await fixture.json("POST", `/api/contracts/${id}/void`, {
          reason: "Wrong rate",
        })
      ).status,
    ).toBe(200);
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/void`, {})).status,
    ).toBe(409);
    const actions = contractActivity(fixture).map(({ action }) => action);
    expect(actions).toEqual([
      "contract.created",
      "contract.sent",
      "contract.voided",
    ]);
    expect(
      JSON.parse(contractActivity(fixture).at(-1)?.details ?? "{}"),
    ).toEqual({ reason: "Wrong rate", signedCount: 0, signerCount: 1 });
  });

  it("completes a contract only together with its completed event", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(singleSigner());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    failInserts(fixture, "contract_events", "NEW.type = 'completed'");
    const signed = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${tokenFrom(fixture.emails[0])}/sign`,
      { consent: true, signature: png },
    );
    expect(signed.body.completed).toBe(false);
    const row = () =>
      fixture.database
        .query("SELECT status, final_object_key FROM contracts WHERE id = ?")
        .get(id);
    expect(row()).toEqual({ final_object_key: null, status: "sent" });

    fixture.database.exec("DROP TRIGGER fail_audit");
    await resumeStalledContracts(
      fixture.bindings,
      new Date(Date.now() + 3_600_000),
    );
    expect(row()).toMatchObject({ status: "completed" });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM contract_events WHERE type = 'completed'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("attributes contract work to the API key and channel it came through", async () => {
    const fixture = createFixture();
    seedKey(fixture);
    const agent = fixture.as("owner-user", "org-1", viaKey);
    const created = await agent.upload(await samplePdf(), "Agent.pdf");
    expect(created.status).toBe(201);
    const id = created.body.contract.id;
    await agent.json("PUT", `/api/contracts/${id}/draft`, singleSigner());
    await agent.json("POST", `/api/contracts/${id}/send`);

    type Event = {
      actorName: string | null;
      apiKey: { channel: string; name: string } | null;
      type: string;
    };
    const events = async () =>
      (
        await fixture.json<{ contract: { events: Event[] } }>(
          "GET",
          `/api/contracts/${id}`,
        )
      ).body.contract.events;
    expect(await events()).toMatchObject([
      {
        actorName: "Olivia Owner",
        apiKey: { channel: "mcp", name: "Assistant" },
        type: "created",
      },
      {
        actorName: "Olivia Owner",
        apiKey: { channel: "mcp", name: "Assistant" },
        type: "sent",
      },
      { actorName: null, apiKey: null, type: "notified" },
    ]);
    expect(
      contractActivity(fixture).map(
        ({ action, actor_api_key_channel, actor_api_key_name }) => [
          action,
          actor_api_key_name,
          actor_api_key_channel,
        ],
      ),
    ).toEqual([
      ["contract.created", "Assistant", "mcp"],
      ["contract.sent", "Assistant", "mcp"],
    ]);
    expect(
      fixture.database.query("SELECT * FROM activity_api_key_context").all(),
    ).toEqual([]);

    // A scheduled reminder has no actor; a manual one names its sender.
    const sentAt = Date.now();
    await sendContractReminders(
      fixture.bindings,
      new Date(sentAt + 2 * 86_400_000 + 3_600_000),
    );
    fixture.database
      .query("UPDATE contract_recipients SET last_reminded_at = ?")
      .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    expect(
      (
        await agent.json<{ reminded: number }>(
          "POST",
          `/api/contracts/${id}/remind`,
        )
      ).body.reminded,
    ).toBe(1);
    const reminders = (await events()).filter(
      ({ type }) => type === "reminded",
    );
    expect(reminders).toMatchObject([
      { actorName: null, apiKey: null },
      {
        actorName: "Olivia Owner",
        apiKey: { channel: "mcp", name: "Assistant" },
      },
    ]);

    // A session void names the person and no key.
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/void`, {})).status,
    ).toBe(200);
    expect((await events()).at(-1)).toMatchObject({
      actorName: "Olivia Owner",
      apiKey: null,
      type: "voided",
    });
    expect(contractActivity(fixture).at(-1)).toMatchObject({
      action: "contract.voided",
      actor_api_key_name: null,
    });
  });

  it("names the key and channel on the certificate", () => {
    const event = {
      actor_name: "Olivia Owner",
      actor_user_id: "owner-user",
      api_key_channel: "mcp" as const,
      api_key_name: "Assistant",
      created_at: timestamp,
      detail: null,
      id: "e",
      ip: null,
      recipient_id: "r",
      type: "sent",
      user_agent: null,
    };
    const signer = new Map([["r", { email: "sam@example.com", name: "Sam" }]]);
    expect(describeEvent(event, signer)).toBe(
      "Sent for signature by Olivia Owner via API key Assistant (MCP)",
    );
    expect(
      describeEvent(
        { ...event, api_key_channel: null, api_key_name: null },
        signer,
      ),
    ).toBe("Sent for signature by Olivia Owner");
    expect(describeEvent({ ...event, type: "reminded" }, signer)).toBe(
      "Reminder emailed to Sam <sam@example.com> by Olivia Owner via API key Assistant (MCP)",
    );
    expect(
      describeEvent(
        { ...event, actor_name: null, actor_user_id: null, type: "reminded" },
        signer,
      ),
    ).toBe("Reminder emailed to Sam <sam@example.com>");
  });

  it("records a template's deletion with its versions, once", async () => {
    const fixture = createFixture();
    seedKey(fixture);
    const template = await uploadTemplate(fixture);
    const agent = fixture.as("owner-user", "org-1", viaKey);
    const elsewhere = fixture.as("other-user", "org-2");
    expect(
      (
        await elsewhere.json(
          "DELETE",
          `/api/contracts/templates/${template.id}`,
        )
      ).status,
    ).toBe(404);
    expect(contractActivity(fixture)).toEqual([]);

    failInserts(fixture, "activity_events", "1 = 1");
    expect(
      (await agent.json("DELETE", `/api/contracts/templates/${template.id}`))
        .status,
    ).toBe(500);
    fixture.database.exec("DROP TRIGGER fail_audit");
    expect(
      (await agent.json("DELETE", `/api/contracts/templates/${template.id}`))
        .status,
    ).toBe(204);
    expect(
      (await agent.json("DELETE", `/api/contracts/templates/${template.id}`))
        .status,
    ).toBe(404);
    const events = contractActivity(fixture);
    expect(events).toMatchObject([
      {
        action: "contract_template.deleted",
        actor_api_key_channel: "mcp",
        actor_api_key_name: "Assistant",
        actor_user_id: "owner-user",
        root_id: template.id,
        root_label: template.name,
      },
    ]);
    expect(JSON.parse(events[0]?.details ?? "{}")).toEqual({
      title: template.name,
      version: 1,
      versionCount: 1,
    });
  });
});
