import { describe, expect, it } from "bun:test";
import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import type { ContractDetail } from "@balebase/validators/contracts";
import { createFixture, draft } from "../testing/contractFixture";
import { sha256Hex } from "./contractPdf";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII=";
const input: ContractAuthoringInput = {
  formatVersion: 1,
  title: "Written service agreement",
  source:
    '# Agreement\n\nServices for :value[client.name] at :value[project.site].\n\nClient: :name{#client-name role="client"}\n\nInitials: :initials{#scope-initials role="client"}\n\n::signature{#client-signature role="client"}\n\nDate: :signed-date{#client-date role="client"}\n\nTitle: :text{#client-title role="client" label="Title"}',
  recipients: [
    {
      key: "client",
      name: "Sam Signer",
      email: "sam@example.com",
      routingOrder: 1,
    },
  ],
  values: { "project.site": "Main Street" },
  signingOrder: "parallel",
  message: "Please review.",
  dueDate: null,
  reminderIntervalDays: null,
};

describe("authored contracts", () => {
  it("retains source, replaces a draft atomically, and signs the reviewed PDF", async () => {
    const fixture = createFixture();
    const created = await fixture.json<{ contract: ContractDetail }>(
      "POST",
      "/api/contracts/authored",
      input,
    );
    expect(created.status).toBe(201);
    const contract = created.body.contract;
    expect(contract.authoring).toEqual({ ...input, revision: 1 });
    expect(contract.fields.map((field) => field.type)).toEqual([
      "name",
      "initials",
      "signature",
      "date_signed",
      "text",
    ]);
    const originalKey = fixture.database
      .query("SELECT document_object_key FROM contracts WHERE id = ?")
      .get(contract.id) as { document_object_key: string };
    const revised = {
      ...input,
      source: input.source.replace("# Agreement", "# Revised agreement"),
    };
    const saved = await fixture.json<{ contract: ContractDetail }>(
      "PUT",
      `/api/contracts/${contract.id}/authored`,
      { ...revised, expectedRevision: 1 },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.contract.authoring).toEqual({ ...revised, revision: 2 });
    expect(saved.body.contract.document.sha256).not.toBe(
      contract.document.sha256,
    );
    expect(
      fixture.database
        .query(
          "SELECT object_key FROM deleted_object_cleanup WHERE object_key = ?",
        )
        .get(originalKey.document_object_key),
    ).not.toBeNull();
    const reopened = await fixture.json<{ contract: ContractDetail }>(
      "GET",
      `/api/contracts/${contract.id}`,
    );
    expect(reopened.body.contract.authoring).toEqual(
      saved.body.contract.authoring,
    );
    expect(
      (
        await fixture.json("PUT", `/api/contracts/${contract.id}/authored`, {
          ...input,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.json(
          "PUT",
          `/api/contracts/${contract.id}/draft`,
          draft(),
        )
      ).status,
    ).toBe(409);
    expect(
      (await fixture.json("POST", `/api/contracts/${contract.id}/send`)).status,
    ).toBe(409);
    expect(
      (
        await fixture.json(
          "POST",
          `/api/contracts/${contract.id}/send?expectedRevision=1`,
        )
      ).status,
    ).toBe(409);
    const sent = await fixture.json<{ contract: ContractDetail }>(
      "POST",
      `/api/contracts/${contract.id}/send?expectedRevision=2`,
    );
    expect(sent.status).toBe(200);
    expect(sent.body.contract.status).toBe("sent");
    expect(
      (
        await fixture.json("PUT", `/api/contracts/${contract.id}/authored`, {
          ...input,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
    const token = fixture.emails[0]?.text.match(/\/sign\/([^\s]+)/)?.[1];
    expect(token).toBeDefined();
    const signing = await fixture.json<{
      fields: Array<{ id: string; type: string }>;
    }>("GET", `/api/signing/${token}`);
    const text = signing.body.fields.find((field) => field.type === "text");
    expect(text).toBeDefined();
    const signed = await fixture.json<{ completed: boolean }>(
      "POST",
      `/api/signing/${token}/sign`,
      {
        consent: true,
        signature: png,
        initials: png,
        values: { [text?.id ?? ""]: "Director" },
      },
    );
    expect(signed.status).toBe(200);
    expect(signed.body.completed).toBe(true);
    const completed = await fixture.json<{ contract: ContractDetail }>(
      "GET",
      `/api/contracts/${contract.id}`,
    );
    expect(completed.body.contract.document.sha256).toBe(
      saved.body.contract.document.sha256,
    );
    expect(completed.body.contract.authoring).toEqual(
      saved.body.contract.authoring,
    );
    expect(completed.body.contract.finalSha256).toMatch(/^[0-9a-f]{64}$/);
    const final = await fixture.request(`/api/contracts/${contract.id}/final`);
    expect(final.status).toBe(200);
    expect(completed.body.contract.finalSha256).toBe(
      await sha256Hex(new Uint8Array(await final.arrayBuffer())),
    );
  });

  it("refuses invalid source before creating a contract or storing bytes", async () => {
    const fixture = createFixture();
    const result = await fixture.json<{ error: string }>(
      "POST",
      "/api/contracts/authored",
      {
        ...input,
        source:
          'Unknown value :value[missing.key]\n\n::signature{#sig role="client"}',
      },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("missing.key");
    expect(
      fixture.database.query("SELECT count(*) AS total FROM contracts").get(),
    ).toEqual({ total: 0 });
    expect(fixture.stored.size).toBe(0);
  });

  it("keeps authored drafts organization-scoped", async () => {
    const fixture = createFixture();
    const created = await fixture.json<{ contract: ContractDetail }>(
      "POST",
      "/api/contracts/authored",
      input,
    );
    const other = fixture.as("other-user", "org-2");
    expect(
      (
        await other.json(
          "PUT",
          `/api/contracts/${created.body.contract.id}/authored`,
          { ...input, expectedRevision: 1 },
        )
      ).status,
    ).toBe(404);
    expect(
      (await other.json("GET", `/api/contracts/${created.body.contract.id}`))
        .status,
    ).toBe(404);
  });

  it.each(["revision", "sent"] as const)(
    "does not overwrite a draft when a concurrent %s change wins",
    async (change) => {
      const fixture = createFixture();
      const created = await fixture.json<{ contract: ContractDetail }>(
        "POST",
        "/api/contracts/authored",
        input,
      );
      const original = created.body.contract;
      fixture.hooks.before("UPDATE contracts SET authoring_json", () => {
        const update =
          change === "revision" ? "revision = revision + 1" : "status = 'sent'";
        fixture.database
          .query(`UPDATE contracts SET ${update} WHERE id = ?`)
          .run(original.id);
      });
      const raced = await fixture.json(
        "PUT",
        `/api/contracts/${original.id}/authored`,
        {
          ...input,
          source: `${input.source}\n\nChanged terms.`,
          expectedRevision: 1,
        },
      );
      expect(raced.status).toBe(409);
      const current = await fixture.json<{ contract: ContractDetail }>(
        "GET",
        `/api/contracts/${original.id}`,
      );
      expect(current.body.contract.document).toEqual(original.document);
      expect(current.body.contract.fields).toEqual(original.fields);
      expect(current.body.contract.recipients).toEqual(original.recipients);
      expect(current.body.contract.events.map((event) => event.type)).toEqual([
        "created",
      ]);
      expect(
        fixture.database
          .query("SELECT count(*) AS total FROM deleted_object_cleanup")
          .get(),
      ).toEqual({ total: 1 });
    },
  );
});
