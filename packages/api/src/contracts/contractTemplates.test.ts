import { describe, expect, it } from "bun:test";
import {
  type Contract,
  createFixture,
  roleMapping,
  type Template,
  templateVersion,
  uploadTemplate,
} from "../testing/contractFixture";
import { streamedUpload } from "../testing/http";

describe("contract templates", () => {
  it("keeps versions immutable and maps every field through a role into an independent draft", async () => {
    const fixture = createFixture();
    const first = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${first.id}`;
    const saved = await fixture.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      templateVersion(first),
    );
    expect(saved.status).toBe(201);
    const second = saved.body.template;
    expect(second.version).toBe(2);
    expect(second.definition.roles).toEqual([
      { key: "sam", label: "Employee", routingOrder: 1 },
      { key: "cai", label: "Company", routingOrder: 2 },
    ]);
    expect(JSON.stringify(second.definition)).not.toContain("sam@example.com");
    expect(JSON.stringify(second.definition)).not.toContain("Sam Signer");
    const created = await fixture.json<{ contractId: string }>(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(created.status).toBe(201);
    const id = created.body.contractId;
    const detail = await fixture.json<{
      contract: Contract & { template: { name: string; version: number } };
    }>("GET", `/api/contracts/${id}`);
    expect(detail.body.contract.status).toBe("draft");
    expect(detail.body.contract.fields).toHaveLength(5);
    expect(detail.body.contract.template).toEqual({
      name: "Employment agreement",
      version: 2,
    });
    const employee = detail.body.contract.recipients.find(
      (recipient) => recipient.email === "sam@example.com",
    );
    expect(
      detail.body.contract.fields.filter(
        (field) => field.recipientId === employee?.id,
      ),
    ).toHaveLength(3);
    expect(detail.body.contract.events[0]?.type).toBe("created_from_template");
    const changed = templateVersion(second);
    changed.definition.fields = [];
    changed.name = "New employment agreement";
    expect(
      (await fixture.json("POST", `${path}/versions`, changed)).status,
    ).toBe(201);
    expect(
      (await fixture.json<{ template: Template }>("GET", `${path}?version=1`))
        .body.template.definition.fields,
    ).toEqual([]);
    expect(
      (await fixture.json<{ template: Template }>("GET", `${path}?version=2`))
        .body.template,
    ).toEqual({ ...second, currentVersion: 3 });
    const history = await fixture.json<{
      versions: Array<{ version: number }>;
    }>("GET", `${path}/versions`);
    expect(history.body.versions.map(({ version }) => version)).toEqual([
      3, 2, 1,
    ]);
    const old = await fixture.json<{ contractId: string }>(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(old.status).toBe(201);
    expect(
      (
        await fixture.json<{ contract: Contract }>(
          "GET",
          `/api/contracts/${old.body.contractId}`,
        )
      ).body.contract.fields,
    ).toHaveLength(5);
    expect((await fixture.json("DELETE", path)).status).toBe(204);
    const queue = fixture.database
      .query("SELECT object_key FROM deleted_object_cleanup")
      .all() as Array<{ object_key: string }>;
    expect(queue).toHaveLength(1);
    fixture.stored.delete(queue[0]?.object_key ?? "");
    expect(
      (await fixture.request(`/api/contracts/${id}/document`)).status,
    ).toBe(200);
    expect(
      (
        await fixture.json<{ contract: Contract & { template: unknown } }>(
          "GET",
          `/api/contracts/${id}`,
        )
      ).body.contract.template,
    ).toEqual({ name: "Employment agreement", version: 2 });
    expect(
      (await fixture.json("POST", `/api/contracts/${id}/send`)).status,
    ).toBe(200);
    expect(fixture.emails).toHaveLength(1);
    expect(fixture.emails[0]?.to.email).toBe("sam@example.com");
  });

  it("rejects stale saves and preserves the winner's version", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    const input = templateVersion(template);
    expect((await fixture.json("POST", `${path}/versions`, input)).status).toBe(
      201,
    );
    expect(
      (
        await fixture.json("POST", `${path}/versions`, {
          ...input,
          name: "Stale overwrite",
        })
      ).status,
    ).toBe(409);
    const current = await fixture.json<{ template: Template }>("GET", path);
    expect(current.body.template.currentVersion).toBe(2);
    expect(current.body.template.name).toBe("Employment agreement");
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_template_versions")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("validates roles, boxes, and complete unique mappings without saving people in templates", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    const input = templateVersion(template);
    const [role] = input.definition.roles;
    const [field] = input.definition.fields;
    for (const [definition, error] of [
      [{ ...input.definition, roles: [] }, "Add at least one signer role."],
      [
        { ...input.definition, roles: [role, role] },
        "Each signer needs a unique key.",
      ],
      [
        {
          ...input.definition,
          roles: [role, { ...role, key: "other", label: " EMPLOYEE " }],
        },
        "Give each signer role a different label.",
      ],
      [
        { ...input.definition, roles: [{ ...role, label: " " }] },
        "Give every signer role a label.",
      ],
      [
        { ...input.definition, fields: [{ ...field, roleKey: "missing" }] },
        "Every field must belong to a signer.",
      ],
      [
        { ...input.definition, fields: [{ ...field, page: 3 }] },
        "A field is on a page the document doesn't have.",
      ],
      [
        { ...input.definition, fields: [{ ...field, x: 0.99 }] },
        "A field extends past the edge of its page.",
      ],
      [
        { ...input.definition, fields: "none" },
        "The template fields are invalid.",
      ],
      [
        { ...input.definition, reminderIntervalDays: 31 },
        "Reminders can repeat every 1 to 30 days.",
      ],
    ] as const)
      expect(
        (
          await fixture.json("POST", `${path}/versions`, {
            ...input,
            definition,
          })
        ).body,
      ).toEqual({ error });
    for (const [change, error] of [
      [{ sourceVersion: 0 }, "Choose a template version."],
      [{ description: 1 }, "Keep the description to 2,000 characters."],
      [{ name: " " }, "Give the contract a title of up to 200 characters."],
    ] as const)
      expect(
        (
          await fixture.json("POST", `${path}/versions`, {
            ...input,
            ...change,
          })
        ).body,
      ).toEqual({ error });
    expect((await fixture.json("POST", `${path}/versions`, input)).status).toBe(
      201,
    );
    const mapping = roleMapping(2);
    const [employee, company] = mapping.recipients;
    for (const [recipients, error] of [
      [[], "Map every signer role to a person."],
      [[employee], "Map every signer role to a person."],
      [[employee, employee], "Map every signer role exactly once."],
      [[{ ...employee, name: "" }, company], "Choose a name for Employee."],
      [
        [{ ...employee, email: "invalid" }, company],
        "Choose a valid email address for Employee.",
      ],
      [
        [{ ...employee, email: "cai@example.com" }, company],
        "cai@example.com is listed more than once.",
      ],
      [[1, company], "A signer is invalid."],
    ] as const)
      expect(
        (
          await fixture.json("POST", `${path}/contracts`, {
            ...mapping,
            recipients,
          })
        ).body,
      ).toEqual({ error });
    expect(
      (
        await fixture.json("POST", `${path}/contracts`, {
          ...mapping,
          version: "latest",
        })
      ).body,
    ).toEqual({ error: "Choose a template version." });
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
    expect(fixture.stored.size).toBe(1);
  });

  it("refuses an oversized template while it streams", async () => {
    const fixture = await createFixture();
    const fileBytes = 32 * 1024 * 1024;
    const upload = streamedUpload(fileBytes);
    const response = await fixture.request("/api/contracts/templates", {
      body: upload.body,
      headers: upload.headers,
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Contract templates must be 10 MB or smaller.",
    });
    expect(upload.progress.cancelled).toBe(true);
    expect(upload.progress.sentBytes).toBeLessThan(fileBytes);
    expect(fixture.stored.size).toBe(0);
  });

  it("scopes every template route to the active organization", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const outsider = fixture.as("other-user", "org-2");
    const path = `/api/contracts/templates/${template.id}`;
    for (const [method, route, body] of [
      ["GET", path, undefined],
      ["GET", `${path}/document`, undefined],
      ["GET", `${path}/versions`, undefined],
      ["POST", `${path}/versions`, templateVersion(template)],
      ["POST", `${path}/contracts`, roleMapping(1)],
      ["DELETE", path, undefined],
    ] as const)
      expect((await outsider.json(method, route, body)).status).toBe(404);
    expect(
      (
        await outsider.json<{ templates: unknown[] }>(
          "GET",
          "/api/contracts/templates",
        )
      ).body.templates,
    ).toEqual([]);
    expect((await fixture.json("GET", `${path}?version=bogus`)).status).toBe(
      400,
    );
    expect(
      (await fixture.json("GET", `${path}/document?version=bogus`)).status,
    ).toBe(400);
  });

  it("rolls back a failed copy and handles deletion while a contract is being created", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${template.id}`;
    await fixture.json("POST", `${path}/versions`, templateVersion(template));
    // Fail inside the batch, after the contract row is written, so only a
    // rollback leaves no contract behind.
    fixture.database.exec(`CREATE TEMP TRIGGER fail_contract_fields
      BEFORE INSERT ON contract_fields
      BEGIN SELECT RAISE(ABORT, 'Database unavailable'); END`);
    expect(
      (
        await fixture.request(`${path}/contracts`, {
          body: JSON.stringify(roleMapping(2)),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(500);
    fixture.database.exec("DROP TRIGGER fail_contract_fields");
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
    fixture.hooks.before("INSERT INTO contracts", () => {
      fixture.database
        .query("DELETE FROM contract_templates WHERE id = ?")
        .run(template.id);
    });
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(2))).status,
    ).toBe(404);
    expect(fixture.stored.size).toBe(1);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
    ).toEqual({ count: 0 });
  });

  it("queues template PDFs when an organization is purged", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    await fixture.json(
      "POST",
      `/api/contracts/templates/${template.id}/versions`,
      templateVersion(template),
    );
    fixture.database.query("DELETE FROM organization WHERE id = 'org-1'").run();
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_template_versions")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 1 });
  });
});
