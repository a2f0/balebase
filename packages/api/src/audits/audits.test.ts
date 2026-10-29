import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  auditTarget,
  createActivityAudit,
  createAuditIssue,
  createFixture,
  jsonRequest,
  type RunListResponse,
  type RunResponse,
  type TemplateListResponse,
  type TemplateResponse,
  type TestIdentity,
} from "../testing/auditFixture";

describe("audits", () => {
  it("paginates every retained audit run with a stable cursor", async () => {
    const fixture = createFixture();
    const insert = fixture.database.query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, 'org_user-1', 'History test', ?, '{}', 'completed',
               'user-1', ?, ?)`,
    );
    const definition = JSON.stringify({
      sections: [{ id: "section", items: [], title: "History" }],
      version: 1,
    });
    for (let index = 0; index < 105; index += 1) {
      const createdAt = new Date(
        Date.UTC(2026, 7, 1, 0, 0, index),
      ).toISOString();
      insert.run(
        `history-${index.toString().padStart(3, "0")}`,
        definition,
        createdAt,
        createdAt,
      );
    }

    const first = await jsonRequest<RunListResponse>(fixture, "/runs", "GET");
    expect(first.status).toBe(200);
    expect(first.body.audits).toHaveLength(100);
    expect(first.body.nextCursor).toBeString();

    const second = await jsonRequest<RunListResponse>(
      fixture,
      `/runs?cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
      "GET",
    );
    expect(second.status).toBe(200);
    expect(second.body.audits).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.audits, ...second.body.audits].map(
      ({ id }) => id,
    );
    expect(ids).toHaveLength(105);
    expect(new Set(ids)).toHaveLength(105);
    expect(ids[0]).toBe("history-104");
    expect(ids.at(-1)).toBe("history-000");

    const invalid = await jsonRequest(fixture, "/runs?cursor=not-valid", "GET");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: "Invalid audit cursor." });
  });

  it("reports an audit removed during an update as missing", async () => {
    const fixture = createFixture();
    const now = "2026-08-25T12:00:00.000Z";
    fixture.database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_name, definition, responses, status,
          started_by, created_at, updated_at)
         VALUES ('update-race', 'org_user-1', 'Race test', ?, '{}',
                 'in_progress', 'user-1', ?, ?)`,
      )
      .run(
        JSON.stringify({
          sections: [{ id: "section", items: [], title: "Race" }],
          version: 1,
        }),
        now,
        now,
      );
    fixture.hooks.before("UPDATE audits SET responses", (event) => {
      const { auditId, organizationId } = auditTarget(event);
      fixture.database
        .query("DELETE FROM audits WHERE id = ? AND organization_id = ?")
        .run(auditId, organizationId);
    });

    const updated = await jsonRequest(fixture, "/runs/update-race", "PATCH", {
      expectedRevision: 0,
      responses: {},
      status: "in_progress",
    });

    expect(updated.status).toBe(404);
    expect(updated.body).toEqual({ error: "Audit not found." });
  });

  it("lists the built-in starter templates with their questions", async () => {
    const fixture = createFixture();
    const starterResponse = await fixture.request("/templates", undefined);
    expect(starterResponse.status).toBe(200);
    const starterBody = (await starterResponse.json()) as TemplateListResponse;
    expect(starterBody.templates).toHaveLength(2);
    const nfpaStarter = starterBody.templates.find(
      ({ id }) => id === "nfpa70e_global",
    );
    expect(nfpaStarter).toMatchObject({
      id: "nfpa70e_global",
      name: "NFPA 70E readiness checklist",
      scope: "global",
    });
    expect(nfpaStarter?.definition.sections).toHaveLength(6);
    const residentialStarter = starterBody.templates.find(
      ({ id }) => id === "us_residential_core_global",
    );
    expect(residentialStarter).toMatchObject({
      name: "U.S. residential construction — comprehensive baseline",
      scope: "global",
    });
    expect(residentialStarter?.definition.sections.length).toBeGreaterThan(15);
    expect(
      residentialStarter?.definition.sections.reduce(
        (count, section) => count + section.items.length,
        0,
      ),
    ).toBeGreaterThanOrEqual(225);
  });

  it("versions a new template and snapshots that version into an audit run", async () => {
    const fixture = createFixture();
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Site walkthrough" },
    );
    expect(created.status).toBe(201);
    const template = created.body.template;
    expect(template).toMatchObject({
      currentVersion: 1,
      scope: "organization",
      version: 1,
    });
    template.definition.sections[0]?.items.push({
      id: "notes-item",
      prompt: "Record observations",
      required: false,
      responseType: "text",
    });

    const updated = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${template.id}`,
      "PUT",
      {
        definition: template.definition,
        description: "A small operational checklist.",
        name: template.name,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.template).toMatchObject({
      currentVersion: 2,
      version: 2,
    });

    const started = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${template.id}/runs`,
      "POST",
    );
    expect(started.status).toBe(201);

    const incomplete = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      { expectedRevision: 0, responses: {}, status: "completed" },
    );
    expect(incomplete.status).toBe(400);

    const firstItem = template.definition.sections[0]?.items[0];
    expect(firstItem).toBeDefined();
    const saved = await jsonRequest(
      fixture,
      `/runs/${started.body.auditId}`,
      "PATCH",
      {
        expectedRevision: 0,
        responses: { [firstItem?.id ?? ""]: "fail" },
        status: "in_progress",
      },
    );
    expect(saved.status).toBe(200);

    const detail = await fixture.request(
      `/runs/${started.body.auditId}`,
      undefined,
    );
    expect(await detail.json()).toMatchObject({
      audit: {
        responses: { [firstItem?.id ?? ""]: "fail" },
        templateId: template.id,
        templateVersion: 2,
      },
    });
  });

  it("assigns an audit issue only to a current member", async () => {
    const fixture = createFixture();
    const { auditId, issue } = await createAuditIssue(fixture);
    expect(issue.status).toBe(201);

    const invalidAssignee = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(invalidAssignee.status).toBe(400);

    fixture.database
      .query(
        `INSERT INTO member
         (id, organizationId, userId, role, createdAt)
         VALUES ('member-user-2-org-1', 'org_user-1', 'user-2', 'member', ?)`,
      )
      .run("2026-08-25T12:00:00.000Z");
    fixture.hooks.before(
      /UPDATE issues[\s\S]*SELECT 1 FROM member/,
      ({ values }) => {
        fixtureMemberDeletion(fixture.database, values.at(-2), values.at(-1));
      },
    );
    const removedDuringAssignment = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-2" },
    );
    expect(removedDuringAssignment.status).toBe(400);
    expect(
      fixture.database
        .query(`SELECT assigned_to FROM issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1" });

    const unassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: null },
    );
    expect(unassigned.status).toBe(200);
    const reassigned = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { assignedTo: "user-1" },
    );
    expect(reassigned.status).toBe(200);

    const detail = await fixture.request(`/runs/${auditId}`, undefined);
    expect(await detail.json()).toMatchObject({
      issues: [
        {
          assignedTo: "user-1",
          assigneeName: "Example Person",
          description: "Correct before the next shift.",
          priority: "high",
          status: "open",
        },
      ],
      members: [{ id: "user-1", name: "Example Person" }],
    });
  });

  it("resolves an issue after its assignee leaves the organization", async () => {
    const fixture = createFixture();
    const { issue } = await createAuditIssue(fixture);
    fixture.database
      .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
      .run("org_user-1", "user-1");
    const resolved = await jsonRequest(
      fixture,
      `/issues/${issue.body.issueId}`,
      "PATCH",
      { status: "resolved" },
    );
    expect(resolved.status).toBe(200);
    expect(
      fixture.database
        .query(`SELECT assigned_to, status FROM issues WHERE id = ?`)
        .get(issue.body.issueId),
    ).toEqual({ assigned_to: "user-1", status: "resolved" });
  });
});

describe("audit request rules", () => {
  it("keeps each rule's message for template and answer saves", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const { auditId, templateId } = await createActivityAudit(fixture);
    const template = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${templateId}`,
      "GET",
    );
    const { definition, name } = template.body.template;
    const shared = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "Shared form" },
      admin,
    );
    const sharedId = shared.body.template.id;
    const longPrompt = structuredClone(definition);
    const firstItem = longPrompt.sections[0]?.items[0];
    if (firstItem) firstItem.prompt = "x".repeat(501);
    const cases: Array<[string, string, unknown, string, TestIdentity?]> = [
      ["POST", "/templates", { name: " " }, "A template name is required."],
      [
        "POST",
        "/templates",
        { name: "Form", scope: "global" },
        "Template scope is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition: longPrompt, name },
        "The template definition is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition: { ...definition, sections: [] }, name },
        "The template definition is invalid.",
      ],
      [
        "PUT",
        `/templates/${templateId}`,
        { definition, description: "x".repeat(2001), name },
        "Descriptions are limited to 2,000 characters.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: -1, responses: {} },
        "A valid audit revision is required. Reload it before saving.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: 0, responses: { check: 1 } },
        "Invalid audit responses.",
      ],
      [
        "PATCH",
        `/runs/${auditId}`,
        { expectedRevision: 0, responses: {}, status: "done" },
        "Invalid audit status.",
      ],
      [
        "PUT",
        `/admin/audit-templates/${sharedId}`,
        { definition, name, status: "draft" },
        "Template status is invalid.",
        admin,
      ],
      [
        "DELETE",
        `/admin/audit-templates/${sharedId}`,
        {},
        "The current template version is required.",
        admin,
      ],
    ];
    for (const [method, path, body, error, identity] of cases) {
      expect({
        path,
        response: await jsonRequest(fixture, path, method, body, identity),
      }).toMatchObject({ path, response: { body: { error }, status: 400 } });
    }
  });
});

describe("audit issue writes", () => {
  it("rejects an unknown priority instead of defaulting it", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture);
    const rejected = await jsonRequest(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      {
        itemId: "check",
        priority: "urgent",
        title: "Loose rail",
      },
    );
    expect(rejected).toMatchObject({
      body: { error: "Invalid issue details." },
      status: 400,
    });

    const raised = await jsonRequest<{ issueId: string }>(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      { assignedTo: " ", itemId: "check", title: " Loose rail " },
    );
    expect(raised.status).toBe(201);
    expect(
      fixture.database
        .query(
          "SELECT assigned_to, description, priority, title FROM issues WHERE id = ?",
        )
        .get(raised.body.issueId),
    ).toEqual({
      assigned_to: null,
      description: "",
      priority: "medium",
      title: "Loose rail",
    });
  });

  it("keeps a checklist item ID exactly as the form defines it", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture, " check ");
    const raised = await jsonRequest<{ issueId: string }>(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      { itemId: " check ", title: "Loose rail" },
    );
    expect(raised.status).toBe(201);
    expect(
      fixture.database
        .query("SELECT item_id FROM issues WHERE id = ?")
        .get(raised.body.issueId),
    ).toEqual({ item_id: " check " });
  });

  it("refuses an assignee who leaves after the initial read", async () => {
    const fixture = createFixture();
    const { auditId } = await createActivityAudit(fixture);
    fixture.database
      .query(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES ('member-user-2-org-1', 'org_user-1', 'user-2', 'member', ?)`,
      )
      .run("2026-08-25T12:00:00.000Z");
    fixture.hooks.before(
      "INSERT INTO issues",
      () => fixtureMemberDeletion(fixture.database, "org_user-1", "user-2"),
      { method: "batch" },
    );
    const raised = await jsonRequest(
      fixture,
      `/runs/${auditId}/issues`,
      "POST",
      {
        assignedTo: "user-2",
        itemId: "check",
        title: "Loose rail",
      },
    );
    expect(raised).toMatchObject({
      body: { error: "Issue assignee is not a member." },
      status: 400,
    });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM issues WHERE target_id = ?")
        .get(auditId),
    ).toEqual({ count: 0 });
  });
});

function fixtureMemberDeletion(
  database: Database,
  organizationId: SQLQueryBindings | undefined,
  userId: SQLQueryBindings | undefined,
) {
  if (typeof organizationId !== "string" || typeof userId !== "string") {
    throw new Error("Assignee membership predicate bindings are missing");
  }
  database
    .query(`DELETE FROM member WHERE organizationId = ? AND userId = ?`)
    .run(organizationId, userId);
}
