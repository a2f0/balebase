import { describe, expect, it } from "bun:test";
import type { ContractDetail } from "@balebase/validators/contracts";
import type {
  CreateAuthoredTemplateInput,
  TemplateVersionInput,
} from "@balebase/validators/contractTemplates";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";
import { createFixture, type Template } from "../testing/contractFixture";

const input: CreateAuthoredTemplateInput = {
  name: "Written service agreement",
  description: "Reusable services",
  definition: {
    roles: [{ key: "client", label: "Client", routingOrder: 1 }],
    fields: [
      {
        roleKey: "client",
        type: "text",
        page: 99,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
        required: true,
        label: "Untrusted",
      },
    ],
    message: "Please review.",
    reminderIntervalDays: 3,
    signingOrder: "parallel",
  },
  authoring: {
    formatVersion: 1,
    source:
      '# Agreement\n\n:value[client.name]\n\n:value[client.email]\n\n:value[project.site]\n\n:value[project.price] :value[project.currency]\n\n:signature{#client-signature role="client"}',
    values: { "project.price": "100", "project.currency": "USD" },
  },
};
const mapping = {
  recipients: [
    { roleKey: "client", name: "Sam Signer", email: "sam@example.com" },
  ],
  title: "Sam's agreement",
};

async function authoredFixture() {
  const fixture = createFixture();
  const result = await fixture.json<{ template: Template }>(
    "POST",
    "/api/contracts/templates/authored",
    input,
  );
  expect(result.status).toBe(201);
  const template = result.body.template;
  const path = `/api/contracts/templates/${template.id}`;
  const save = (source: Template, patch: Partial<TemplateVersionInput> = {}) =>
    fixture.json<{ template: Template }>("POST", `${path}/versions`, {
      authoring: source.authoring,
      definition: source.definition,
      description: source.description,
      name: source.name,
      expectedCurrentVersion: source.currentVersion,
      sourceVersion: source.version,
      ...patch,
    });
  return { ...fixture, template, path, save };
}

async function pdfText(response: Response) {
  expect(response.status).toBe(200);
  const pdf = await PDFDocument.load(await response.arrayBuffer());
  return pdf
    .getPages()
    .flatMap((page) => {
      const contents = page.node.lookup(PDFName.of("Contents"));
      const streams =
        contents instanceof PDFArray
          ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
          : [contents];
      return streams.flatMap((stream) => {
        if (!(stream instanceof PDFRawStream))
          throw new Error("Expected PDF content.");
        const operations = new TextDecoder().decode(
          decodePDFRawStream(stream).decode(),
        );
        return [...operations.matchAll(/<([0-9A-F]+)>\s*Tj/g)].map((match) =>
          Buffer.from(match[1] ?? "", "hex").toString("latin1"),
        );
      });
    })
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("authored contract templates", () => {
  it("renders a draft preview with role labels and nonpersisted placeholders, ignoring supplied geometry", async () => {
    const fixture = await authoredFixture();
    expect(fixture.template).toMatchObject({
      status: "draft",
      currentStatus: "draft",
      authoring: input.authoring,
    });
    expect(fixture.template.definition.fields).toHaveLength(1);
    expect(fixture.template.definition.fields[0]).toMatchObject({
      page: 1,
      type: "signature",
      roleKey: "client",
    });
    const preview = await pdfText(
      await fixture.request(`${fixture.path}/document`),
    );
    expect(preview).toContain("Client");
    expect(preview).toContain("[Client email]");
    expect(preview).toContain("[project.site]");
    expect(preview).toContain("100");
    expect(preview).not.toContain("sam@example.com");
    const list = await fixture.json<{ templates: unknown[] }>(
      "GET",
      "/api/contracts/templates",
    );
    expect(list.body.templates).toMatchObject([
      { format: "markdown", status: "draft" },
    ]);
    const stored = fixture.database
      .query("SELECT authoring_json FROM contract_template_versions")
      .get() as { authoring_json: string };
    expect(JSON.parse(stored.authoring_json)).toEqual(input.authoring);
    expect(
      (
        await fixture.json("POST", `${fixture.path}/contracts`, {
          ...mapping,
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await fixture.save(fixture.template, { authoring: null })).status,
    ).toBe(400);
    const outsider = fixture.as("other-user", "org-2");
    expect((await outsider.json("GET", fixture.path)).status).toBe(404);
  });

  it("keeps preview placeholders outside the saved merge-value limit", async () => {
    const fixture = createFixture();
    const authoring = {
      ...input.authoring,
      values: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `unused.value${index}`,
          "Default",
        ]),
      ),
    };
    const created = await fixture.json<{ template: Template }>(
      "POST",
      "/api/contracts/templates/authored",
      { ...input, authoring },
    );
    expect(created.status).toBe(201);
    const template = created.body.template;
    const path = `/api/contracts/templates/${template.id}`;
    expect(template.authoring).toEqual(authoring);
    expect(await pdfText(await fixture.request(`${path}/document`))).toContain(
      "[project.site]",
    );
    const published = await fixture.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      {
        authoring,
        definition: template.definition,
        description: template.description,
        name: template.name,
        expectedCurrentVersion: 1,
        sourceVersion: 1,
        status: "published",
      },
    );
    expect(published.status).toBe(201);
    expect(published.body.template.authoring).toEqual(authoring);
    const contract = await fixture.json<{ error: string }>(
      "POST",
      `${path}/contracts`,
      { ...mapping, version: 2 },
    );
    expect(contract.status).toBe(400);
    expect(contract.body.error).toContain(
      'Supply a non-empty merge value for "project.site"',
    );
  });

  it("instantiates the selected snapshot with per-use values, then edits and sends its own reviewed revision", async () => {
    const fixture = await authoredFixture();
    const published = await fixture.save(fixture.template, {
      status: "published",
    });
    expect(published.status).toBe(201);
    const version = published.body.template;
    const changedSource = {
      ...input.authoring,
      source: input.authoring.source.replace("# Agreement", "# Latest"),
      values: { "project.price": "900", "project.currency": "CAD" },
    };
    const latest = await fixture.save(
      { ...fixture.template, currentVersion: 2 },
      { authoring: changedSource },
    );
    expect(latest.status).toBe(201);
    expect(latest.body.template.status).toBe("published");
    expect(
      fixture.database
        .query(
          "SELECT source_version FROM contract_template_versions WHERE version = 3",
        )
        .get(),
    ).toEqual({ source_version: 1 });
    const historical = await fixture.json<{ template: Template }>(
      "GET",
      `${fixture.path}?version=2`,
    );
    expect(historical.body.template).toEqual({ ...version, currentVersion: 3 });
    const missing = await fixture.json<{ error: string }>(
      "POST",
      `${fixture.path}/contracts`,
      { ...mapping, version: 2 },
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("project.site");
    expect(
      (
        await fixture.json("POST", `${fixture.path}/contracts`, {
          ...mapping,
          version: 2,
          values: { "project.site": "Site", "client.name": "Impersonator" },
        })
      ).status,
    ).toBe(400);
    expect(fixture.stored.size).toBe(3);
    const values = {
      "project.site": "ExplicitSite ".repeat(100),
      "project.price": "250",
    };
    const created = await fixture.json<{ contractId: string }>(
      "POST",
      `${fixture.path}/contracts`,
      { ...mapping, version: 2, values },
    );
    expect(created.status).toBe(201);
    const contractPath = `/api/contracts/${created.body.contractId}`;
    const detail = await fixture.json<{ contract: ContractDetail }>(
      "GET",
      contractPath,
    );
    const contract = detail.body.contract;
    expect(contract.authoring).toEqual({
      ...input.authoring,
      values: { ...input.authoring.values, ...values },
      title: mapping.title,
      message: "Please review.",
      dueDate: null,
      reminderIntervalDays: 3,
      signingOrder: "parallel",
      recipients: [
        {
          key: "client",
          name: "Sam Signer",
          email: "sam@example.com",
          routingOrder: 1,
        },
      ],
      revision: 1,
    });
    expect(contract.template).toEqual({ name: version.name, version: 2 });
    expect(contract.document.sha256).not.toBe(version.document.sha256);
    const sourceField = version.definition.fields[0];
    const actualField = contract.fields[0];
    expect([actualField?.page, actualField?.y]).not.toEqual([
      sourceField?.page,
      sourceField?.y,
    ]);
    const renderedText = await pdfText(
      await fixture.request(`${contractPath}/document`),
    );
    expect(renderedText).toContain("Sam Signer");
    expect(renderedText).toContain("sam@example.com");
    expect(renderedText).toContain("ExplicitSite");
    expect(renderedText).toContain("250");
    expect(renderedText).toContain("USD");
    expect(renderedText).not.toContain("[project.site]");
    expect(renderedText).not.toContain("CAD");
    const history = await fixture.json<{ events: unknown[] }>(
      "GET",
      `${fixture.path}/activity`,
    );
    for (const secret of [
      input.authoring.source,
      "project.site",
      "ExplicitSite",
      "sam@example.com",
    ])
      expect(JSON.stringify(history.body.events)).not.toContain(secret);
    expect(
      (await fixture.save(latest.body.template, { status: "unpublished" }))
        .status,
    ).toBe(201);
    expect((await fixture.json("DELETE", fixture.path)).status).toBe(204);
    const cleanup = fixture.database
      .query("SELECT object_key FROM deleted_object_cleanup")
      .all() as Array<{ object_key: string }>;
    expect(cleanup).toHaveLength(4);
    for (const { object_key } of cleanup) fixture.stored.delete(object_key);
    expect((await fixture.request(`${contractPath}/document`)).status).toBe(
      200,
    );
    expect((await fixture.json("POST", `${contractPath}/send`)).status).toBe(
      409,
    );
    const revised = {
      ...contract.authoring,
      source: `${input.authoring.source}\n\nReviewed terms.`,
    };
    const saved = await fixture.json<{ contract: ContractDetail }>(
      "PUT",
      `${contractPath}/authored`,
      { ...revised, expectedRevision: 1 },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.contract.authoring?.revision).toBe(2);
    expect(saved.body.contract.template).toEqual(contract.template);
    expect(
      (
        await fixture.json("PUT", `${contractPath}/authored`, {
          ...revised,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await fixture.json("POST", `${contractPath}/send?expectedRevision=1`))
        .status,
    ).toBe(409);
    expect(
      (await fixture.json("POST", `${contractPath}/send?expectedRevision=2`))
        .status,
    ).toBe(200);
    expect(fixture.emails).toHaveLength(1);
  });

  it.each(["stale", "demoted", "failed"] as const)(
    "cleans a generated preview after a %s save and leaves history unchanged",
    async (failure) => {
      const fixture = await authoredFixture();
      const history = fixture.database
        .query("SELECT * FROM activity_events ORDER BY id")
        .all();
      if (failure === "failed") {
        fixture.database.exec(`CREATE TEMP TRIGGER fail_template_history BEFORE INSERT ON activity_events
        WHEN NEW.action = 'contract_template.published'
        BEGIN SELECT RAISE(ABORT, 'History unavailable'); END`);
      } else {
        fixture.hooks.before("INSERT INTO contract_template_versions", () => {
          if (failure === "demoted") {
            fixture.database.exec(
              "UPDATE member SET role = 'member' WHERE userId = 'owner-user'",
            );
          } else {
            fixture.database
              .query(`INSERT INTO contract_template_versions
            (id, template_id, version, name, definition_json, authoring_json, status,
             document_object_key, document_filename, document_size, document_sha256, document_page_count, created_at)
            SELECT 'winner', template_id, 2, 'Winner', definition_json, authoring_json, status,
              document_object_key, document_filename, document_size, document_sha256, document_page_count, created_at
            FROM contract_template_versions WHERE template_id = ? AND version = 1`)
              .run(fixture.template.id);
            fixture.database
              .query(
                "UPDATE contract_templates SET current_version = 2 WHERE id = ?",
              )
              .run(fixture.template.id);
          }
        });
      }
      const result = await fixture.save(fixture.template, {
        status: "published",
      });
      expect(result.status).toBe(
        failure === "stale" ? 409 : failure === "demoted" ? 403 : 500,
      );
      expect(fixture.stored.size).toBe(1);
      expect(
        fixture.database
          .query("SELECT * FROM activity_events ORDER BY id")
          .all(),
      ).toEqual(history);
      expect(
        fixture.database
          .query("SELECT current_version FROM contract_templates")
          .get(),
      ).toEqual({ current_version: failure === "stale" ? 2 : 1 });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM contract_template_versions")
          .get(),
      ).toEqual({ count: failure === "stale" ? 2 : 1 });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
          .get(),
      ).toEqual({ count: 1 });
    },
  );

  it("cleans fresh contract bytes if unpublication wins during rendering or history insertion fails", async () => {
    for (const failure of ["unpublished", "failed"] as const) {
      const fixture = await authoredFixture();
      const published = await fixture.save(fixture.template, {
        status: "published",
      });
      expect(published.status).toBe(201);
      if (failure === "failed") {
        fixture.database.exec(`CREATE TEMP TRIGGER fail_contract_history BEFORE INSERT ON contract_events
          BEGIN SELECT RAISE(ABORT, 'History unavailable'); END`);
      } else {
        fixture.hooks.before("INSERT INTO contracts", () => {
          fixture.database
            .query(
              "UPDATE contract_template_versions SET status = 'unpublished' WHERE template_id = ? AND version = 2",
            )
            .run(fixture.template.id);
        });
      }
      const response = await fixture.json("POST", `${fixture.path}/contracts`, {
        ...mapping,
        version: 2,
        values: { "project.site": "Real site" },
      });
      expect(response.status).toBe(failure === "failed" ? 500 : 409);
      expect(fixture.stored.size).toBe(2);
      for (const table of [
        "contracts",
        "contract_recipients",
        "contract_fields",
        "contract_events",
      ])
        expect(
          fixture.database
            .query(`SELECT COUNT(*) AS count FROM ${table}`)
            .get(),
        ).toEqual({ count: 0 });
    }
  });
});
