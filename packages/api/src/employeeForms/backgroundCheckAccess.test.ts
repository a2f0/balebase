import { describe, expect, it } from "bun:test";
import { activity } from "../activity/activity";
import {
  configureCheckr,
  createFixture,
  createRequirement,
  jsonPost,
  orgId,
} from "../testing/employeeFormFixture";
import { seedMember } from "../testing/seed";
import { testApp } from "../testing/session";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const hrGroupId = "team_hr_org_owner";
const backgroundCheck = {
  dueDate: "2026-10-01",
  kind: "background_check",
  title: "Background check",
};
const checksRequired = "Background checks group membership required.";
const managerRequired = "Organization manager access required.";

/** Adds `userId` to Acme's HR group, or takes them out of it. */
function setHrMember(fixture: Fixture, userId: string, member: boolean) {
  if (member) {
    fixture.database
      .query(
        `INSERT INTO teamMember (id, teamId, userId, membershipKey, createdAt)
         VALUES (?, ?, ?, NULL, '2026-01-01')`,
      )
      .run(`hr-${userId}`, hrGroupId, userId);
    return;
  }
  fixture.database
    .query("DELETE FROM teamMember WHERE teamId = ? AND userId = ?")
    .run(hrGroupId, userId);
}

/** Acme's recruiter: a plain member who is in the HR group. */
function addRecruiter(fixture: Fixture) {
  seedMember(fixture.database, {
    id: "recruiter-member",
    organizationId: orgId,
    userId: "other",
  });
  setHrMember(fixture, "other", true);
  return fixture.app("other", "member");
}

function json(method: string, body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  };
}

async function listedIds(client: ReturnType<Fixture["app"]>) {
  const response = await client.request("/");
  expect(response.status).toBe(200);
  const { requirements } = (await response.json()) as {
    requirements: Array<{ checkrResult: string | null; id: string }>;
  };
  return requirements.map(({ id }) => id);
}

function requirementCount(fixture: Fixture) {
  return (
    fixture.database
      .query("SELECT COUNT(*) AS count FROM employee_requirements")
      .get() as { count: number }
  ).count;
}

describe("background check access", () => {
  it("lets an HR member who isn't a manager handle background checks, and only those", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const recruiter = addRecruiter(fixture);
    const formId = await createRequirement(fixture, "form", "W-4");

    const created = await recruiter.request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [backgroundCheck],
      }),
    );
    expect(created.status).toBe(201);
    const [checkId = ""] = ((await created.json()) as { ids: string[] }).ids;

    // Forms stay with owners and admins.
    const form = await recruiter.request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [backgroundCheck, { ...backgroundCheck, kind: "form" }],
      }),
    );
    expect(form.status).toBe(403);
    expect(await form.json()).toEqual({ error: managerRequired });
    expect(requirementCount(fixture)).toBe(2);

    expect(await listedIds(recruiter)).toEqual([checkId]);
    expect(
      (
        await recruiter.request(
          `/${checkId}/checkr/request`,
          jsonPost({ state: "CA" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await recruiter.request(
          `/${checkId}`,
          json("PATCH", { dueDate: "2026-11-01" }),
        )
      ).status,
    ).toBe(200);
    expect((await recruiter.request(`/${checkId}/activity`)).status).toBe(200);

    for (const response of [
      await recruiter.request(`/${formId}/activity`),
      await recruiter.request(
        `/${formId}`,
        json("PATCH", { dueDate: "2026-11-01" }),
      ),
      await recruiter.request(`/${formId}`, { method: "DELETE" }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: managerRequired });
    }
  });

  it("keeps background checks from an owner outside every group that grants them", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const formId = await createRequirement(fixture, "form", "W-4");
    setHrMember(fixture, "owner", false);
    const owner = fixture.app("owner", "owner");

    expect(await listedIds(owner)).toEqual([formId]);
    for (const response of [
      await owner.request(
        "/",
        jsonPost({
          memberId: "employee-member",
          requirements: [backgroundCheck],
        }),
      ),
      await owner.request(
        `/${checkId}`,
        json("PATCH", { dueDate: "2026-11-01" }),
      ),
      await owner.request(`/${checkId}`, { method: "DELETE" }),
      await owner.request(`/${checkId}/activity`),
      await owner.request(
        `/${checkId}/checkr/request`,
        jsonPost({ state: "CA" }),
      ),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: checksRequired });
    }
    expect(requirementCount(fixture)).toBe(2);

    // Forms are unaffected.
    expect(
      (
        await owner.request(
          `/${formId}`,
          json("PATCH", { dueDate: "2026-11-01" }),
        )
      ).status,
    ).toBe(200);
  });

  it("refuses a member who handles neither kind before looking the request up", async () => {
    const fixture = await createFixture();
    const checkId = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const employee = fixture.app("employee", "member");
    for (const path of [`/${checkId}/activity`, "/missing/activity"]) {
      const response = await employee.request(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: managerRequired });
    }
  });

  it("assigns nothing when the person leaves the HR group mid-request", async () => {
    const fixture = await createFixture();
    fixture.beforeRun("INSERT INTO employee_requirements", () =>
      setHrMember(fixture, "owner", false),
    );
    const response = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        memberId: "employee-member",
        requirements: [backgroundCheck],
      }),
    );
    expect(response.status).toBe(409);
    expect(requirementCount(fixture)).toBe(0);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_type = 'employee_requirement'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("shows background check history only to those with Background checks access", async () => {
    const fixture = await createFixture();
    addRecruiter(fixture);
    await createRequirement(fixture, "background_check", "Background check");
    await createRequirement(fixture, "form", "W-4");
    const feed = async (userId: string, role: string) => {
      const app = testApp(
        { "/api/activity": activity },
        { organizationId: orgId, organizationRole: role, userId },
      );
      const response = await app.request(
        "/api/activity?resourceType=employee_requirement",
        undefined,
        fixture.bindings,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        events: Array<{ details: { kind: string } }>;
      };
      return page.events.map(({ details }) => details.kind);
    };

    expect(await feed("owner", "owner")).toEqual(["form", "background_check"]);
    expect(await feed("other", "member")).toEqual(["background_check"]);
    expect(await feed("employee", "member")).toEqual([]);
    setHrMember(fixture, "owner", false);
    expect(await feed("owner", "owner")).toEqual(["form"]);
  });
});
