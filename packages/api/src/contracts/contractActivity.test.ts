import { describe, expect, it } from "bun:test";
import type { ApiKeyPrincipal } from "../auth/apiEnv";
import {
  type Contract,
  createFixture,
  draft,
  type SentEmail,
  samplePdf,
  signers,
  type Template,
  templateVersion,
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
      "contract.completed",
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
      declinedAt: null,
      sentAt: expect.any(String),
      signedCount: 1,
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
      "contract.completed",
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

  it("completes a contract only together with its completed events", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(singleSigner());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    failInserts(fixture, "contract_events", "NEW.type = 'completed'");
    const signed = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${token}/sign`,
      { consent: true, signature: png },
    );
    expect(signed.body.completed).toBe(false);
    const row = () =>
      fixture.database
        .query("SELECT status, final_object_key FROM contracts WHERE id = ?")
        .get(id);
    expect(row()).toEqual({ final_object_key: null, status: "sent" });
    fixture.database.exec("DROP TRIGGER fail_audit");

    // The shared event failing holds the completion back too.
    failInserts(
      fixture,
      "activity_events",
      "NEW.action = 'contract.completed'",
    );
    await resumeStalledContracts(
      fixture.bindings,
      new Date(Date.now() + 3_600_000),
    );
    expect(row()).toEqual({ final_object_key: null, status: "sent" });
    expect(contractActivity(fixture).map(({ action }) => action)).toEqual([
      "contract.created",
      "contract.sent",
    ]);
    fixture.database.exec("DROP TRIGGER fail_audit");

    await resumeStalledContracts(
      fixture.bindings,
      new Date(Date.now() + 7_200_000),
    );
    expect(row()).toMatchObject({ status: "completed" });
    const completedEvent = fixture.database
      .query("SELECT id FROM contract_events WHERE type = 'completed'")
      .all() as Array<{ id: string }>;
    expect(completedEvent).toHaveLength(1);
    // Recorded once, by the signing workflow and caused by the contract's
    // own completed event; no person is credited.
    const shared = fixture.database
      .query(
        `SELECT actor_type, actor_source, actor_user_id, actor_name,
                causation_type, causation_id, root_label, details
         FROM activity_events WHERE action = 'contract.completed'`,
      )
      .all() as Array<Record<string, unknown> & { details: string }>;
    expect(shared).toHaveLength(1);
    const { finalSha256, documentSha256 } = fixture.database
      .query(
        `SELECT final_sha256 AS finalSha256, document_sha256 AS documentSha256
         FROM contracts WHERE id = ?`,
      )
      .get(id) as { documentSha256: string; finalSha256: string };
    expect(shared[0]).toEqual({
      actor_name: "Balebase signing",
      actor_source: "contractSigning",
      actor_type: "system",
      actor_user_id: null,
      causation_id: completedEvent[0]?.id ?? "",
      causation_type: "contract_event",
      details: expect.any(String),
      root_label: "Services agreement",
    });
    expect(JSON.parse(shared[0]?.details ?? "{}")).toEqual({
      documentSha256,
      finalSha256,
      signerCount: 1,
    });
    // A later sweep finds nothing more to complete or record.
    await resumeStalledContracts(
      fixture.bindings,
      new Date(Date.now() + 10_800_000),
    );
    expect(
      contractActivity(fixture).filter(
        ({ action }) => action === "contract.completed",
      ),
    ).toHaveLength(1);
    expect((await fixture.json("GET", `/api/signing/${token}`)).status).toBe(
      200,
    );
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
    const created = contractActivity(fixture);
    expect(created.map(({ action }) => action)).toEqual([
      "contract_template.created",
    ]);

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
    const events = contractActivity(fixture).slice(created.length);
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
  it("records a template's upload and each saved version, once each", async () => {
    const fixture = createFixture();
    seedKey(fixture);
    const agent = fixture.as("owner-user", "org-1", viaKey);
    const elsewhere = fixture.as("other-user", "org-2");
    const uploadAs = async (client: typeof agent) => {
      const form = new FormData();
      form.set("file", new File([await samplePdf()], "Offer letter.pdf"));
      return client.request("/api/contracts/templates", {
        body: form,
        method: "POST",
      });
    };

    // A failed event takes the upload with it.
    failInserts(
      fixture,
      "activity_events",
      "NEW.action = 'contract_template.created'",
    );
    expect((await uploadAs(agent)).status).toBe(500);
    fixture.database.exec("DROP TRIGGER fail_audit");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_templates")
        .get(),
    ).toEqual({ count: 0 });
    expect(contractActivity(fixture)).toEqual([]);

    const uploaded = await uploadAs(agent);
    expect(uploaded.status).toBe(201);
    const template = ((await uploaded.json()) as { template: Template })
      .template;
    const [created] = contractActivity(fixture);
    expect(created).toMatchObject({
      action: "contract_template.created",
      actor_api_key_channel: "mcp",
      actor_api_key_name: "Assistant",
      actor_user_id: "owner-user",
      organization_id: "org-1",
      root_id: template.id,
      root_label: "Offer letter",
    });
    expect(JSON.parse(created?.details ?? "{}")).toEqual({
      documentSha256: template.document.sha256,
      name: "Offer letter",
      pageCount: 2,
      version: 1,
    });

    const save = (client: typeof agent, body: unknown) =>
      client.json<{ template: Template }>(
        "POST",
        `/api/contracts/templates/${template.id}/versions`,
        body,
      );
    const version2 = templateVersion(template);
    // Another organization's save, and a failed event, record nothing.
    expect((await save(elsewhere, version2)).status).toBe(404);
    failInserts(
      fixture,
      "activity_events",
      "NEW.action = 'contract_template.version_saved'",
    );
    expect((await save(agent, version2)).status).toBe(500);
    fixture.database.exec("DROP TRIGGER fail_audit");
    const versions = () =>
      fixture.database
        .query(
          `SELECT family.current_version AS current,
                  (SELECT COUNT(*) FROM contract_template_versions
                   WHERE template_id = family.id) AS count
           FROM contract_templates AS family WHERE id = ?`,
        )
        .get(template.id);
    expect(versions()).toEqual({ count: 1, current: 1 });
    expect(contractActivity(fixture)).toHaveLength(1);

    expect((await save(agent, version2)).status).toBe(201);
    // A save on top of a stale version is refused and claims nothing.
    expect((await save(fixture, version2)).status).toBe(409);
    expect(versions()).toEqual({ count: 2, current: 2 });
    const saved = contractActivity(fixture).slice(1);
    expect(saved).toMatchObject([
      {
        action: "contract_template.version_saved",
        actor_api_key_channel: "mcp",
        actor_api_key_name: "Assistant",
        actor_user_id: "owner-user",
        root_id: template.id,
        root_label: "Employment agreement",
      },
    ]);
    expect(JSON.parse(saved[0]?.details ?? "{}")).toEqual({
      documentSha256: template.document.sha256,
      fieldCount: 5,
      name: "Employment agreement",
      previousName: "Offer letter",
      roleCount: 2,
      signingOrder: "sequential",
      sourceVersion: 1,
      version: 2,
    });
    // Field values and messages stay out of the shared history.
    expect(saved[0]?.details).not.toContain("Please review");

    // A session save names the person and no key.
    expect(
      (
        await save(fixture, {
          ...version2,
          expectedCurrentVersion: 2,
          sourceVersion: 1,
        })
      ).status,
    ).toBe(201);
    expect(contractActivity(fixture).at(-1)).toMatchObject({
      action: "contract_template.version_saved",
      actor_api_key_name: null,
      actor_user_id: "owner-user",
    });
    expect(
      JSON.parse(contractActivity(fixture).at(-1)?.details ?? "{}"),
    ).toMatchObject({
      previousName: "Employment agreement",
      sourceVersion: 1,
      version: 3,
    });
    expect(
      fixture.database.query("SELECT * FROM activity_api_key_context").all(),
    ).toEqual([]);
  });

  it("lists a template's own history to members while it exists", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const other = await uploadTemplate(fixture);
    await fixture.json(
      "POST",
      `/api/contracts/templates/${template.id}/versions`,
      templateVersion(template),
    );
    type Page = {
      events: Array<{ action: string; root: { id: string } }>;
      nextCursor: string | null;
    };
    const history = (
      client: Pick<typeof fixture, "json">,
      id: string,
      query = "",
    ) =>
      client.json<Page>(
        "GET",
        `/api/contracts/templates/${id}/activity${query}`,
      );
    const member = fixture.as("other-user", "org-1");
    for (const client of [fixture, member]) {
      const page = await history(client, template.id);
      expect(page.status).toBe(200);
      expect(page.body.events.map(({ action }) => action)).toEqual([
        "contract_template.version_saved",
        "contract_template.created",
      ]);
      expect(page.body.nextCursor).toBeNull();
    }
    expect(
      (await history(fixture, other.id)).body.events.map(({ root }) => root.id),
    ).toEqual([other.id]);
    expect(
      (await history(fixture.as("other-user", "org-2"), template.id)).status,
    ).toBe(404);
    expect((await history(fixture, template.id, "?cursor=x")).status).toBe(400);

    // Deleting it ends its page; the workspace feed keeps all of it.
    await fixture.json("DELETE", `/api/contracts/templates/${template.id}`);
    expect((await history(fixture, template.id)).status).toBe(404);
    const feed = await fixture.json<Page>(
      "GET",
      "/api/activity?resourceType=contract_template",
    );
    expect(
      feed.body.events
        .filter(({ root }) => root.id === template.id)
        .map(({ action }) => action),
    ).toEqual([
      "contract_template.deleted",
      "contract_template.version_saved",
      "contract_template.created",
    ]);
  });

  it("keeps a declined contract's decline and signatures when it is deleted", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(
      draft({ fields: draft().fields.filter(({ type }) => type !== "text") }),
    );
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const [samToken, caiToken] = fixture.emails.map(tokenFrom);
    expect(
      (
        await fixture.json("POST", `/api/signing/${samToken}/sign`, {
          consent: true,
          signature: png,
        })
      ).status,
    ).toBe(200);
    const decline = () =>
      fixture.json("POST", `/api/signing/${caiToken}/decline`, {
        reason: "Wrong rate",
      });
    // The shared event failing leaves the signer able to decline later.
    failInserts(fixture, "activity_events", "NEW.action = 'contract.declined'");
    expect((await decline()).status).toBe(500);
    expect(
      fixture.database
        .query(
          `SELECT contracts.status, COUNT(contract_events.id) AS declines
           FROM contracts LEFT JOIN contract_events
             ON contract_events.contract_id = contracts.id
            AND contract_events.type = 'declined'
           WHERE contracts.id = ?`,
        )
        .get(id),
    ).toEqual({ declines: 0, status: "sent" });
    fixture.database.exec("DROP TRIGGER fail_audit");
    expect((await decline()).status).toBe(200);
    // A second decline is refused and records nothing.
    expect((await decline()).status).not.toBe(200);
    const declinedEvent = fixture.database
      .query(
        "SELECT id, recipient_id FROM contract_events WHERE type = 'declined'",
      )
      .get() as { id: string; recipient_id: string };
    const declines = fixture.database
      .query(
        `SELECT actor_type, actor_source, actor_user_id, causation_type,
                causation_id, root_id, details
         FROM activity_events WHERE action = 'contract.declined'`,
      )
      .all() as Array<Record<string, unknown> & { details: string }>;
    expect(declines).toEqual([
      {
        actor_source: "contractSigning",
        actor_type: "system",
        actor_user_id: null,
        causation_id: declinedEvent.id,
        causation_type: "contract_event",
        details: expect.any(String),
        root_id: id,
      },
    ]);
    expect(JSON.parse(declines[0]?.details ?? "{}")).toEqual({
      recipientId: declinedEvent.recipient_id,
      signedCount: 1,
      signerCount: 2,
    });
    for (const text of ["Wrong rate", "cai@example.com", "203.0.113.7"])
      expect(declines[0]?.details).not.toContain(text);
    expect((await fixture.json("DELETE", `/api/contracts/${id}`)).status).toBe(
      204,
    );
    // The decline outlives the contract in the shared history.
    expect(
      contractActivity(fixture).filter(
        ({ action }) => action === "contract.declined",
      ),
    ).toHaveLength(1);
    const deleted = contractActivity(fixture).at(-1);
    expect(deleted?.action).toBe("contract.deleted");
    expect(JSON.parse(deleted?.details ?? "{}")).toMatchObject({
      declinedAt: expect.any(String),
      signedCount: 1,
      signerCount: 2,
      status: "declined",
    });
    // The reason, signer emails, and IPs stay out of the shared history.
    for (const text of ["Wrong rate", "cai@example.com", "203.0.113.7"])
      expect(deleted?.details).not.toContain(text);
  });

  it("records a signer's first view together with its status, once", async () => {
    const fixture = createFixture();
    const id = await fixture.prepare(singleSigner());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const token = tokenFrom(fixture.emails[0]);
    const recipient = () =>
      fixture.database
        .query("SELECT status, viewed_at FROM contract_recipients")
        .get() as { status: string; viewed_at: string | null };
    const views = () =>
      fixture.database
        .query(
          "SELECT ip, user_agent FROM contract_events WHERE type = 'viewed'",
        )
        .all();
    const open = () =>
      fixture.request(`/api/signing/${token}`, {
        headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Probe" },
      });

    failInserts(fixture, "contract_events", "NEW.type = 'viewed'");
    expect((await open()).status).toBe(500);
    expect(recipient()).toEqual({ status: "sent", viewed_at: null });
    fixture.database.exec("DROP TRIGGER fail_audit");

    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    expect(recipient()).toMatchObject({ status: "viewed" });
    expect(views()).toEqual([{ ip: "203.0.113.9", user_agent: "Probe" }]);
  });

  it("names the sender of a manual reminder that could not be sent", async () => {
    const fixture = createFixture();
    seedKey(fixture);
    const agent = fixture.as("owner-user", "org-1", viaKey);
    const id = await fixture.prepare(singleSigner());
    await fixture.json("POST", `/api/contracts/${id}/send`);
    const email = fixture.bindings.EMAIL as unknown as {
      send: (message: unknown) => Promise<unknown>;
    };
    const send = email.send;
    const backdate = () =>
      fixture.database
        .query("UPDATE contract_recipients SET last_reminded_at = ?")
        .run(new Date(Date.now() - 2 * 3_600_000).toISOString());
    const remind = () =>
      agent.json<{ reminded: number }>("POST", `/api/contracts/${id}/remind`);
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

    backdate();
    email.send = async () => {
      throw new Error("Mail is down.");
    };
    expect((await remind()).body.reminded).toBe(0);
    expect((await events()).at(-1)).toMatchObject({
      actorName: "Olivia Owner",
      apiKey: { channel: "mcp", name: "Assistant" },
      type: "delivery_failed",
    });

    // A sent reminder whose record fails is retried, never called a failure.
    email.send = send;
    backdate();
    fixture.hooks.before("INSERT INTO contract_events", () => {
      throw new Error("audit unavailable");
    });
    expect((await remind()).body.reminded).toBe(1);
    const types = (await events()).map(({ type }) => type);
    expect(types.filter((type) => type === "delivery_failed")).toHaveLength(1);
    expect(types.at(-1)).toBe("reminded");

    // A record whose response is lost after it landed is not made twice.
    backdate();
    fixture.hooks.after("INSERT INTO contract_events", () => {
      throw new Error("The response was lost.");
    });
    expect((await remind()).body.reminded).toBe(1);
    expect(
      (await events()).filter(({ type }) => type === "reminded"),
    ).toHaveLength(2);
  });
});
