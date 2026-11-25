import { describe, expect, it } from "bun:test";
import { activity } from "../activity/activity";
import {
  configureCheckr,
  createFixture,
  createRequirement,
  jsonPost,
  orgId,
} from "../testing/employeeFormFixture";
import { testApp } from "../testing/session";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface ActivityRow {
  action: string;
  actor_api_key_channel: string | null;
  actor_api_key_name: string | null;
  actor_user_id: string;
  details: Record<string, unknown>;
  root_id: string;
  root_label: string;
}

function requirementActivity(fixture: Fixture) {
  return (
    fixture.database
      .query(
        `SELECT action, actor_user_id, actor_api_key_name,
                actor_api_key_channel, details, root_id, root_label
         FROM activity_events WHERE root_type = 'employee_requirement'
         ORDER BY id`,
      )
      .all() as Array<Omit<ActivityRow, "details"> & { details: string }>
  ).map((row) => ({ ...row, details: JSON.parse(row.details) }));
}

function patch(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  };
}

function upload(name: string): RequestInit {
  const form = new FormData();
  form.set("file", new File([name], name, { type: "application/pdf" }));
  return { body: form, method: "POST" };
}

function failInserts(fixture: Fixture, action: string) {
  fixture.database.exec(
    `CREATE TRIGGER fail_audit BEFORE INSERT ON activity_events
     WHEN NEW.action = '${action}'
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
  );
}

function requirement(fixture: Fixture, id: string) {
  return fixture.database
    .query(
      `SELECT status, due_date, document_revision
       FROM employee_requirements WHERE id = ?`,
    )
    .get(id);
}

const person = { personEmail: "employee@example.com" };

describe("employee requirement activity", () => {
  it("records each manager change with its old and new values", async () => {
    const fixture = await createFixture();
    const owner = fixture.app("owner", "owner");
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const [assigned] = requirementActivity(fixture);
    expect(assigned).toMatchObject({
      action: "employee_requirement.assigned",
      actor_api_key_name: null,
      actor_user_id: "owner",
      root_id: checkId,
    });
    expect(assigned?.root_label).toStartWith("Background check · ");
    expect(assigned?.details).toMatchObject({
      dueDate: "2026-10-01",
      invited: false,
      kind: "background_check",
      title: "Background check",
      ...person,
    });

    // A by-hand completion, then saves that change nothing.
    expect(
      (await owner.request(`/${checkId}`, patch({ status: "complete" })))
        .status,
    ).toBe(200);
    for (const body of [{ status: "complete" }, { dueDate: "2026-10-01" }])
      expect((await owner.request(`/${checkId}`, patch(body))).status).toBe(
        200,
      );
    expect(
      (
        await owner.request(
          `/${checkId}`,
          patch({ dueDate: "2026-11-01", status: "pending" }),
        )
      ).status,
    ).toBe(200);
    expect(
      requirementActivity(fixture)
        .slice(1)
        .map(({ action, details }) => [action, details.before, details.after]),
    ).toEqual([
      ["employee_requirement.status_changed", "pending", "complete"],
      ["employee_requirement.status_changed", "complete", "pending"],
      ["employee_requirement.due_date_changed", "2026-10-01", "2026-11-01"],
    ]);
    expect(requirementActivity(fixture)[1]?.details).toMatchObject({
      checkrReport: false,
      kind: "background_check",
    });

    // Refused and unknown changes record nothing.
    const recorded = requirementActivity(fixture).length;
    expect(
      (
        await fixture
          .app("employee", "member")
          .request(`/${checkId}`, patch({ status: "complete" }))
      ).status,
    ).toBe(403);
    expect(
      (await owner.request("/missing", patch({ status: "complete" }))).status,
    ).toBe(404);
    expect(requirementActivity(fixture)).toHaveLength(recorded);

    expect(
      (await owner.request(`/${checkId}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(requirementActivity(fixture).at(-1)).toMatchObject({
      action: "employee_requirement.deleted",
      actor_user_id: "owner",
      details: {
        checkrReport: false,
        consentsRemoved: 0,
        dueDate: "2026-11-01",
        status: "pending",
        ...person,
      },
      root_id: checkId,
    });
    expect(
      (await owner.request(`/${checkId}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(requirementActivity(fixture)).toHaveLength(recorded + 1);
  });

  it("rolls each change back when its event cannot be recorded", async () => {
    const fixture = await createFixture();
    const owner = fixture.app("owner", "owner");
    failInserts(fixture, "employee_requirement.assigned");
    const created = await owner.request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [
          { dueDate: "2026-10-01", kind: "form", title: "W-4" },
          { dueDate: "2026-10-01", kind: "credit_check", title: "Credit" },
        ],
      }),
    );
    expect(created.status).toBe(500);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM employee_requirements")
        .get(),
    ).toEqual({ count: 0 });
    fixture.database.exec("DROP TRIGGER fail_audit");

    const id = await createRequirement(fixture, "credit_check", "Credit");
    for (const [action, init] of [
      ["employee_requirement.status_changed", patch({ status: "complete" })],
      [
        "employee_requirement.due_date_changed",
        patch({ dueDate: "2026-12-01" }),
      ],
      ["employee_requirement.deleted", { method: "DELETE" }],
    ] as const) {
      failInserts(fixture, action);
      expect((await owner.request(`/${id}`, init)).status).toBe(500);
      expect(requirement(fixture, id)).toEqual({
        document_revision: 0,
        due_date: "2026-10-01",
        status: "pending",
      });
      fixture.database.exec("DROP TRIGGER fail_audit");
    }

    const formId = await createRequirement(fixture, "form", "W-4");
    failInserts(fixture, "employee_requirement.document_uploaded");
    expect(
      (
        await fixture
          .app("employee", "member")
          .request(`/${formId}/document`, upload("w4.pdf"))
      ).status,
    ).toBe(500);
    expect(requirement(fixture, formId)).toMatchObject({
      document_revision: 0,
      status: "pending",
    });
    expect(fixture.files.size).toBe(0);
    expect(requirementActivity(fixture).map(({ action }) => action)).toEqual([
      "employee_requirement.assigned",
      "employee_requirement.assigned",
    ]);
  });

  it("refuses a manager demoted after their request began", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "credit_check", "Credit");
    fixture.database
      .query("UPDATE member SET role = 'member' WHERE userId = 'owner'")
      .run();
    // The request still carries the owner role it was authorized with.
    const owner = fixture.app("owner", "owner");
    expect(
      (await owner.request(`/${id}`, patch({ status: "complete" }))).status,
    ).toBe(409);
    expect((await owner.request(`/${id}`, { method: "DELETE" })).status).toBe(
      409,
    );
    expect(
      (
        await owner.request(
          "/",
          jsonPost({
            memberId: "employee-member",
            requirements: [
              { dueDate: "2026-10-01", kind: "form", title: "I-9" },
            ],
          }),
        )
      ).status,
    ).toBe(409);
    expect(requirement(fixture, id)).toMatchObject({ status: "pending" });
    expect(requirementActivity(fixture)).toHaveLength(1);
  });

  it("names the API key and channel a manager acted through", async () => {
    const fixture = await createFixture();
    const agent = fixture.app("owner", "owner", { apiKey: true });
    const created = await agent.request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [{ dueDate: "2026-10-01", kind: "form", title: "W-4" }],
      }),
    );
    expect(created.status).toBe(201);
    const { ids } = (await created.json()) as { ids: string[] };
    await agent.request(`/${ids[0]}`, patch({ dueDate: "2026-10-09" }));
    expect(
      requirementActivity(fixture).map(
        ({ action, actor_api_key_channel, actor_api_key_name }) => [
          action,
          actor_api_key_name,
          actor_api_key_channel,
        ],
      ),
    ).toEqual([
      ["employee_requirement.assigned", "Assistant", "mcp"],
      ["employee_requirement.due_date_changed", "Assistant", "mcp"],
    ]);
    expect(
      fixture.database.query("SELECT * FROM activity_api_key_context").all(),
    ).toEqual([]);
  });

  it("records who uploaded each document revision", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(fixture, "form", "W-4");
    expect(
      (
        await fixture
          .app("employee", "member")
          .request(`/${id}/document`, upload("w4.pdf"))
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture
          .app("owner", "owner")
          .request(`/${id}/document`, upload("w4-replaced.pdf"))
      ).status,
    ).toBe(200);
    const uploads = requirementActivity(fixture).filter(
      ({ action }) => action === "employee_requirement.document_uploaded",
    );
    expect(uploads).toMatchObject([
      {
        actor_user_id: "employee",
        details: {
          previousRevision: 0,
          previousStatus: "pending",
          replaced: false,
          revision: 1,
          size: 6,
          uploadedBySubject: true,
        },
      },
      {
        actor_user_id: "owner",
        details: {
          previousRevision: 1,
          previousStatus: "submitted",
          replaced: true,
          revision: 2,
          size: 15,
          uploadedBySubject: false,
        },
      },
    ]);
    // Filenames stay out of the shared history.
    expect(JSON.stringify(uploads)).not.toContain("w4");

    // An upload that loses a race to another changes and records nothing.
    fixture.beforeRun("SET document_key = ?", () => {
      fixture.database
        .query(
          "UPDATE employee_requirements SET document_key = 'raced' WHERE id = ?",
        )
        .run(id);
    });
    expect(
      (
        await fixture
          .app("employee", "member")
          .request(`/${id}/document`, upload("again.pdf"))
      ).status,
    ).toBe(409);
    expect(requirementActivity(fixture)).toHaveLength(3);
  });

  it("records each background-check request and the report it supersedes", async () => {
    const fixture = await createFixture();
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const owner = fixture.app("owner", "owner");
    const request = () =>
      owner.request(
        `/${id}/checkr/request`,
        jsonPost({ city: "San Jose", state: "CA" }),
      );
    expect((await request()).status).toBe(503);
    configureCheckr(fixture);
    expect((await request()).status).toBe(200);
    fixture.database
      .query(
        `UPDATE employee_requirements
         SET checkr_report_id = 'report-1', checkr_report_status = 'canceled',
             checkr_result = 'consider'
         WHERE id = ?`,
      )
      .run(id);
    expect((await request()).status).toBe(200);
    const requests = requirementActivity(fixture).filter(
      ({ action }) => action === "employee_requirement.screening_requested",
    );
    expect(
      requests.map(({ actor_user_id, details }) => [actor_user_id, details]),
    ).toEqual([
      [
        "owner",
        expect.objectContaining({
          previousReportId: null,
          rerequest: false,
          workCity: "San Jose",
          workState: "CA",
        }),
      ],
      [
        "owner",
        expect.objectContaining({
          previousReportId: "report-1",
          previousReportStatus: "canceled",
          rerequest: true,
        }),
      ],
    ]);
    // Screening results never reach the history.
    expect(JSON.stringify(requests)).not.toContain("consider");
  });

  it("lists one request's history to managers, page by page", async () => {
    const fixture = await createFixture();
    const owner = fixture.app("owner", "owner");
    const id = await createRequirement(fixture, "form", "W-4");
    const otherId = await createRequirement(fixture, "form", "I-9");
    expect(
      (await owner.request(`/${id}`, patch({ dueDate: "2026-11-01" }))).status,
    ).toBe(200);
    type Page = {
      events: Array<{
        action: string;
        actor: { apiKey: unknown; id: string };
        details: Record<string, unknown>;
        root: { id: string };
      }>;
      nextCursor: string | null;
    };
    const read = async (
      app: ReturnType<Fixture["app"]>,
      requirementId: string,
      cursor = "",
    ) => {
      const response = await app.request(
        `/${requirementId}/activity${cursor ? `?cursor=${cursor}` : ""}`,
      );
      return {
        body: (await response.json()) as Page,
        status: response.status,
      };
    };
    const first = await read(owner, id);
    expect(first.status).toBe(200);
    expect(first.body.events.map(({ action }) => action)).toEqual([
      "employee_requirement.due_date_changed",
      "employee_requirement.assigned",
    ]);
    expect(first.body.events.every(({ root }) => root.id === id)).toBe(true);
    expect(first.body.events[0]).toMatchObject({
      actor: { apiKey: null, id: "owner" },
      details: { after: "2026-11-01", before: "2026-10-01" },
    });
    expect(first.body.nextCursor).toBeNull();
    expect(
      (await read(owner, otherId)).body.events.map(({ action }) => action),
    ).toEqual(["employee_requirement.assigned"]);

    // The person it was requested from and other members cannot read it.
    for (const [user, role] of [
      ["employee", "member"],
      ["invitee", "member"],
    ] as const)
      expect((await read(fixture.app(user, role), id)).status).toBe(403);

    // A request in another organization is not found.
    fixture.database
      .query(
        "UPDATE employee_requirements SET organization_id = 'org_other' WHERE id = ?",
      )
      .run(otherId);
    expect((await read(owner, otherId)).status).toBe(404);
    expect((await read(owner, "missing")).status).toBe(404);
    expect((await read(owner, id, "not-a-cursor")).status).toBe(400);

    // Long histories page 50 events at a time.
    const insert = fixture.database.query(
      `INSERT INTO activity_events (organization_id, root_type, root_id,
         root_label, subject_type, subject_id, action, actor_user_id,
         actor_name, actor_email, occurred_at, details)
       VALUES (?, 'employee_requirement', ?, 'W-4', 'employee_requirement', ?,
         'employee_requirement.due_date_changed', 'owner', 'Owner',
         'owner@example.com', ?, '{}')`,
    );
    for (let index = 0; index < 50; index += 1)
      insert.run(orgId, id, id, new Date().toISOString());
    const paged = await read(owner, id);
    expect(paged.body.events).toHaveLength(50);
    expect(paged.body.nextCursor).not.toBeNull();
    const rest = await read(owner, id, paged.body.nextCursor ?? "");
    expect(rest.body.events.map(({ action }) => action)).toEqual([
      "employee_requirement.due_date_changed",
      "employee_requirement.assigned",
    ]);
    expect(rest.body.nextCursor).toBeNull();
  });

  it("shows requirement history only to organization managers", async () => {
    const fixture = await createFixture();
    await createRequirement(fixture, "form", "W-4");
    const feed = async (userId: string, role: string, query = "") => {
      const app = testApp(
        { "/api/activity": activity },
        { organizationId: orgId, organizationRole: role, userId },
      );
      const response = await app.request(
        `/api/activity${query}`,
        undefined,
        fixture.bindings,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        events: Array<{ root: { type: string } }>;
      };
      return page.events.filter(
        ({ root }) => root.type === "employee_requirement",
      );
    };
    expect(await feed("owner", "owner")).toHaveLength(1);
    expect(
      await feed("owner", "owner", "?resourceType=employee_requirement"),
    ).toHaveLength(1);
    expect(await feed("employee", "member")).toEqual([]);
    expect(
      await feed("employee", "member", "?resourceType=employee_requirement"),
    ).toEqual([]);
  });
});
