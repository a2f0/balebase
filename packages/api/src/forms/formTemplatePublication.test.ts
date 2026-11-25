import { describe, expect, it } from "bun:test";
import {
  createFixture,
  jsonRequest,
  type RunResponse,
  startForm,
  type TemplateListResponse,
  type TemplateResponse,
} from "../testing/formFixture";

describe("organization template publication", () => {
  it("lets managers publish and unpublish an organization template, keeping it across saves", async () => {
    const fixture = createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walk" },
    );
    const template = created.body.template;
    expect(template.status).toBe("draft");
    const save = (
      expectedCurrentVersion: number,
      status?: string,
      organizationRole?: string,
    ) =>
      jsonRequest<TemplateResponse>(
        fixture,
        `/templates/${template.id}`,
        "PUT",
        { ...template, expectedCurrentVersion, status },
        organizationRole ? { organizationRole } : undefined,
      );

    const draftUnpublish = await save(1, "unpublished");
    expect(draftUnpublish.status).toBe(409);
    expect(Reflect.get(draftUnpublish.body, "error")).toBe(
      "Only published templates can be unpublished.",
    );
    const memberPublish = await save(1, "published", "member");
    expect(memberPublish.status).toBe(403);
    expect(Reflect.get(memberPublish.body, "error")).toBe(
      "Only organization managers can publish or unpublish templates.",
    );

    expect((await save(1, "published")).body.template).toMatchObject({
      status: "published",
      version: 2,
    });
    // A member's ordinary save keeps the template published.
    expect((await save(2, undefined, "member")).body.template).toMatchObject({
      status: "published",
      version: 3,
    });
    expect((await save(3, "unpublished", "admin")).body.template).toMatchObject(
      { status: "unpublished", version: 4 },
    );
    // Unpublished templates stay usable inside the organization.
    expect((await startForm(fixture, template.id)).status).toBe(201);
    expect((await save(3, "published")).status).toBe(409);
    const versions = fixture.database
      .query(
        "SELECT version, status FROM form_template_versions WHERE template_id = ? ORDER BY version",
      )
      .all(template.id);
    expect(versions).toEqual([
      { status: "draft", version: 1 },
      { status: "published", version: 2 },
      { status: "published", version: 3 },
      { status: "unpublished", version: 4 },
    ]);
  });

  it("counts each template's forms that were not discarded, per organization or across them", async () => {
    const fixture = createFixture();
    const other = { organizationId: "org_user-2", userId: "user-2" };
    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walk" },
    );
    const start = async (templateId: string, identity?: typeof other) =>
      (await startForm<RunResponse>(fixture, templateId, identity)).body.formId;
    const localId = local.body.template.id;
    await start(localId);
    const discarded = await start(localId);
    expect(
      (await jsonRequest(fixture, `/runs/${discarded}`, "DELETE")).status,
    ).toBe(200);
    await start("nfpa70e_global");
    await start("nfpa70e_global", other);
    await start("nfpa70e_global", other);

    const counts = (body: TemplateListResponse) =>
      Object.fromEntries(
        body.templates.map((template) => [template.id, template.formCount]),
      );
    const listed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
    );
    expect(counts(listed.body)).toMatchObject({
      [localId]: 1,
      nfpa70e_global: 1,
      us_residential_core_global: 0,
    });
    const managed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/admin/form-templates",
      "GET",
      undefined,
      { role: "admin" },
    );
    expect(counts(managed.body)).toMatchObject({
      nfpa70e_global: 3,
      us_residential_core_global: 0,
    });
  });
});
