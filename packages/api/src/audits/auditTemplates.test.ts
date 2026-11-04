import { describe, expect, it } from "bun:test";
import {
  createFixture,
  jsonRequest,
  type RunResponse,
  startAudit,
  type TemplateResponse,
  type TemplateVersionsResponse,
} from "../testing/auditFixture";
import { insertBilling } from "../testing/seed";

describe("audit templates", () => {
  it("keeps every saved template version immutable", async () => {
    const fixture = createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Versioned form", scope: "organization" },
    );
    const first = created.body.template;
    const secondDefinition = structuredClone(first.definition);
    const firstItem = secondDefinition.sections[0]?.items[0];
    if (firstItem) firstItem.prompt = "Second version question";
    const second = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}`,
      "PUT",
      {
        definition: secondDefinition,
        description: "Second version",
        expectedCurrentVersion: 1,
        name: first.name,
      },
    );
    expect(second.body.template.version).toBe(2);

    const third = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}`,
      "PUT",
      {
        definition: first.definition,
        description: "Created from the first version",
        expectedCurrentVersion: 2,
        name: "Restored form",
      },
    );
    expect(third.body.template).toMatchObject({
      currentVersion: 3,
      name: "Restored form",
      version: 3,
    });

    const history = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/templates/${first.id}/versions`,
      "GET",
    );
    expect(history.body.versions.map(({ version }) => version)).toEqual([
      3, 2, 1,
    ]);
    expect(
      history.body.versions.every(({ createdBy }) => createdBy.id === "user-1"),
    ).toBe(true);

    const original = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${first.id}/versions/1`,
      "GET",
    );
    expect(original.body.template).toMatchObject({
      currentVersion: 3,
      name: "Versioned form",
      version: 1,
    });
    expect(original.body.template.definition).toEqual(first.definition);

    const stale = await jsonRequest(fixture, `/templates/${first.id}`, "PUT", {
      definition: first.definition,
      expectedCurrentVersion: 2,
      name: "Stale form",
    });
    expect(stale.status).toBe(409);
  });

  it("allows every question to be removed from a section", async () => {
    const fixture = createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Empty section form" },
    );
    const definition = structuredClone(created.body.template.definition);
    const section = definition.sections[0];
    expect(section).toBeDefined();
    if (section) section.items = [];

    const saved = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${created.body.template.id}`,
      "PUT",
      {
        definition,
        expectedCurrentVersion: 1,
        name: created.body.template.name,
      },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.template.definition.sections[0]?.items).toEqual([]);

    const started = await startAudit<RunResponse>(
      fixture,
      created.body.template.id,
    );
    const completed = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { expectedRevision: 0, responses: {}, status: "completed" },
    );
    expect(completed.status).toBe(200);
  });

  it("limits Free organizations to five form templates", async () => {
    const fixture = createFixture();
    for (let index = 1; index <= 5; index += 1) {
      const created = await jsonRequest(fixture, "/templates", "POST", {
        name: `Free form ${index}`,
      });
      expect(created.status).toBe(201);
    }
    const limited = await jsonRequest(fixture, "/templates", "POST", {
      name: "Sixth free form",
    });
    expect(limited.status).toBe(409);
    expect(limited.body).toEqual({
      code: "UPGRADE_REQUIRED",
      error:
        "The Free plan is limited to 5 form templates. Upgrade to Pro for unlimited forms.",
    });

    insertBilling(fixture.database, "org_user-1", {
      seat_quantity: 1,
      stripe_event_created: 1,
      stripe_price_id: "price_pro_test",
      stripe_status: "active",
    });
    const pro = await jsonRequest(fixture, "/templates", "POST", {
      name: "Sixth Pro form",
    });
    expect(pro.status).toBe(201);
  });
});
