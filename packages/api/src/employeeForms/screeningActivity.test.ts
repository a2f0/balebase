import { describe, expect, it } from "bun:test";
import { activity } from "../activity/activity";
import {
  checkrResponses,
  checkrWebhook,
  createFixture,
  homerSubmission,
  mockCheckr,
  orderedScreening,
  orgId,
  requestedScreening,
  submitScreening,
} from "../testing/employeeFormFixture";
import { testApp } from "../testing/session";
import { refreshActiveCheckrScreenings } from "./checkrSync";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface EventRow {
  action: string;
  actor_api_key_channel: string | null;
  actor_api_key_name: string | null;
  actor_name: string;
  actor_source: string | null;
  actor_type: string;
  actor_user_id: string | null;
  causation_id: string | null;
  causation_type: string | null;
  details: string;
  root_id: string;
}

function screeningEvents(fixture: Fixture) {
  return fixture.database
    .query(
      `SELECT action, actor_type, actor_source, actor_user_id, actor_name,
              actor_api_key_name, actor_api_key_channel, causation_type,
              causation_id, details, root_id
       FROM activity_events
       WHERE action IN ('employee_requirement.screening_updated',
                        'employee_requirement.screening_submitted',
                        'employee_requirement.screening_report_adopted')
       ORDER BY id`,
    )
    .all() as EventRow[];
}

function details(event: EventRow | undefined) {
  return JSON.parse(event?.details ?? "{}") as Record<string, unknown>;
}

function state(fixture: Fixture, id: string) {
  return fixture.database
    .query(
      `SELECT status, checkr_report_status, checkr_result
       FROM employee_requirements WHERE id = ?`,
    )
    .get(id);
}

function failInserts(fixture: Fixture, action: string) {
  fixture.database.exec(
    `CREATE TRIGGER fail_audit BEFORE INSERT ON activity_events
     WHEN NEW.action = '${action}'
     BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
  );
}

/** Checkr reporting report-1 with the given status and result. */
function reportAt(report: { result: string | null; status: string }) {
  return mockCheckr((call) =>
    call.url === "/reports/report-1"
      ? Response.json({
          candidate_id: "candidate-1",
          id: "report-1",
          ...report,
        })
      : checkrResponses(call),
  );
}

function reportEvent(id: string) {
  return {
    data: {
      object: { candidate_id: "candidate-1", id: "report-1", object: "report" },
    },
    id,
    type: "report.completed",
  };
}

const refresh = (
  fixture: Fixture,
  id: string,
  role = "owner",
  apiKey = false,
) =>
  fixture
    .app("owner", role, { apiKey })
    .request(`/${id}/checkr/refresh`, { method: "POST" });

describe("screening activity", () => {
  it("records a manager's refresh that changes the screening, with its key", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = reportAt({ result: "clear", status: "complete" });
    try {
      expect((await refresh(fixture, id, "owner", true)).status).toBe(200);
      const [updated] = screeningEvents(fixture);
      expect(updated).toMatchObject({
        action: "employee_requirement.screening_updated",
        actor_api_key_channel: "mcp",
        actor_api_key_name: "Assistant",
        actor_type: "user",
        actor_user_id: "owner",
        causation_id: null,
        root_id: id,
      });
      expect(details(updated)).toEqual({
        hasResult: true,
        kind: "background_check",
        personEmail: "employee@example.com",
        personName: expect.any(String),
        previousReportStatus: "pending",
        previousStatus: "in_progress",
        reportStatus: "complete",
        resultChanged: true,
        status: "complete",
        title: "Background check",
        via: "manual",
      });
      // The result itself stays with the requirement.
      expect(updated?.details).not.toContain("clear");

      // A refresh that finds nothing new records nothing.
      expect((await refresh(fixture, id)).status).toBe(200);
      expect(screeningEvents(fixture)).toHaveLength(1);
    } finally {
      checkr.restore();
    }
  });

  it("records nothing for a refused, stale, or failed refresh", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = reportAt({ result: "consider", status: "complete" });
    const before = state(fixture, id);
    try {
      expect((await refresh(fixture, id, "member")).status).toBe(403);

      // Another refresh landed first.
      fixture.beforeRun("checkr_refresh_revision + 1", () => {
        fixture.database
          .query(
            `UPDATE employee_requirements
             SET checkr_refresh_revision = checkr_refresh_revision + 1
             WHERE id = ?`,
          )
          .run(id);
      });
      expect((await refresh(fixture, id)).status).toBe(409);

      // The manager stopped being one while the refresh ran.
      fixture.beforeRun("checkr_refresh_revision + 1", () => {
        fixture.database
          .query("UPDATE member SET role = 'member' WHERE userId = 'owner'")
          .run();
      });
      expect((await refresh(fixture, id)).status).toBe(409);
      fixture.database
        .query("UPDATE member SET role = 'owner' WHERE userId = 'owner'")
        .run();

      // The event failing rolls the refresh back.
      failInserts(fixture, "employee_requirement.screening_updated");
      expect((await refresh(fixture, id)).status).toBe(500);
      expect(state(fixture, id)).toEqual(before);
      expect(screeningEvents(fixture)).toEqual([]);
      fixture.database.exec("DROP TRIGGER fail_audit");

      expect((await refresh(fixture, id)).status).toBe(200);
      expect(state(fixture, id)).toEqual({
        checkr_report_status: "complete",
        checkr_result: "consider",
        status: "complete",
      });
      expect(screeningEvents(fixture)).toHaveLength(1);
    } finally {
      checkr.restore();
    }
  });

  it("records Checkr's changes once per webhook event or refresh run", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const report = { result: "consider" as string | null, status: "complete" };
    const checkr = mockCheckr((call) =>
      call.url === "/reports/report-1"
        ? Response.json({
            candidate_id: "candidate-1",
            id: "report-1",
            ...report,
          })
        : checkrResponses(call),
    );
    try {
      expect(
        (await checkrWebhook(fixture.bindings, reportEvent("evt-1"))).status,
      ).toBe(200);
      const [completed] = screeningEvents(fixture);
      expect(completed).toMatchObject({
        action: "employee_requirement.screening_updated",
        actor_api_key_name: null,
        actor_name: "Checkr",
        actor_source: "checkr",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: "evt-1",
        causation_type: "checkr_event",
      });
      expect(details(completed)).toMatchObject({
        previousStatus: "in_progress",
        status: "complete",
        via: "webhook",
      });

      // A redelivery finds the screening current and records nothing.
      await checkrWebhook(fixture.bindings, reportEvent("evt-1"));
      expect(screeningEvents(fixture)).toHaveLength(1);

      // Adjudication changes the result. A late redelivery of the event that
      // already recorded a change cannot record another, so it leaves the
      // change for a refresh with its own cause instead of hiding it.
      report.result = "clear";
      await checkrWebhook(fixture.bindings, reportEvent("evt-1"));
      expect(state(fixture, id)).toMatchObject({ checkr_result: "consider" });
      expect(screeningEvents(fixture)).toHaveLength(1);

      const runId = crypto.randomUUID();
      expect(
        (await refreshActiveCheckrScreenings(fixture.bindings, runId))
          .refreshed,
      ).toBe(1);
      expect(state(fixture, id)).toMatchObject({ checkr_result: "clear" });
      const adjudicated = screeningEvents(fixture).at(-1);
      expect(adjudicated).toMatchObject({
        actor_source: "checkr",
        actor_type: "provider",
        causation_id: runId,
        causation_type: "job_run",
      });
      expect(details(adjudicated)).toMatchObject({
        previousReportStatus: "complete",
        previousStatus: "complete",
        reportStatus: "complete",
        resultChanged: true,
        status: "complete",
        via: "scheduled",
      });
      expect(screeningEvents(fixture)).toHaveLength(2);
    } finally {
      checkr.restore();
    }
  });

  it("records the person's submission that ordered the report, once", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let rejectCandidate = true;
    const checkr = mockCheckr((call) =>
      rejectCandidate && call.method === "POST" && call.url === "/candidates"
        ? Response.json({ error: "Ssn is invalid" }, { status: 400 })
        : checkrResponses(call),
    );
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(422);
      expect(screeningEvents(fixture)).toEqual([]);

      rejectCandidate = false;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(200);
      const consents = fixture.database
        .query(
          `SELECT id FROM employee_screening_consents
           WHERE requirement_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(id) as Array<{ id: string }>;
      const [submitted] = screeningEvents(fixture);
      expect(submitted).toMatchObject({
        action: "employee_requirement.screening_submitted",
        actor_type: "user",
        actor_user_id: "employee",
        root_id: id,
      });
      expect(details(submitted)).toMatchObject({
        adopted: false,
        consentId: consents[0]?.id,
        reportStatus: "pending",
      });
      // None of the person's details reach the history.
      for (const text of ["110-11-1100", "1983-02-10", "M2233344", "94088"])
        expect(submitted?.details).not.toContain(text);

      // The report is ordered; submitting again is refused and records nothing.
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(409);
      expect(screeningEvents(fixture)).toHaveLength(1);
    } finally {
      checkr.restore();
    }
  });

  it("rolls a submission's report back with its event, and keeps the attempt", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      failInserts(fixture, "employee_requirement.screening_submitted");
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      expect(
        fixture.database
          .query(
            `SELECT checkr_report_id, checkr_candidate_id, status
             FROM employee_requirements WHERE id = ?`,
          )
          .get(id),
      ).toEqual({
        checkr_candidate_id: "candidate-1",
        checkr_report_id: null,
        status: "pending",
      });
      expect(screeningEvents(fixture)).toEqual([]);
    } finally {
      checkr.restore();
    }
  });

  it("records an adopted report as the person's retry or as Checkr's", async () => {
    const fixture = await createFixture();
    const retried = await requestedScreening(fixture);
    const recovered = await requestedScreening(fixture);
    const checkr = mockCheckr((call) =>
      call.url.startsWith("/candidates/")
        ? Response.json({
            id: call.url.slice("/candidates/".length),
            report_ids: ["report-1"],
          })
        : Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    // Attempts whose report request reached Checkr but lost its response.
    const attempt = fixture.database.query(
      `UPDATE employee_requirements
       SET checkr_start_nonce = ?, checkr_start_nonce_at = ?,
           checkr_start_package = 'background_package',
           checkr_candidate_id = ?, checkr_attempt_consent_id = ?,
           checkr_report_requested_at = ?
       WHERE id = ?`,
    );
    const earlier = new Date(Date.now() - 60_000).toISOString();
    attempt.run("retry", earlier, "candidate-1", "consent-1", earlier, retried);
    attempt.run(
      "recover",
      earlier,
      "candidate-2",
      "consent-2",
      earlier,
      recovered,
    );
    try {
      expect(
        (await submitScreening(fixture, retried, homerSubmission())).status,
      ).toBe(200);
      expect(
        (
          await checkrWebhook(fixture.bindings, {
            data: {
              object: {
                candidate_id: "candidate-2",
                id: "report-1",
                object: "report",
              },
            },
            id: "evt-2",
            type: "report.created",
          })
        ).status,
      ).toBe(200);
      const [byPerson, byCheckr] = screeningEvents(fixture);
      expect(byPerson).toMatchObject({
        action: "employee_requirement.screening_submitted",
        actor_user_id: "employee",
        root_id: retried,
      });
      expect(details(byPerson)).toMatchObject({
        adopted: true,
        consentId: "consent-1",
        reportStatus: "pending",
      });
      expect(byCheckr).toMatchObject({
        action: "employee_requirement.screening_report_adopted",
        actor_source: "checkr",
        actor_type: "provider",
        actor_user_id: null,
        causation_id: "evt-2",
        causation_type: "checkr_event",
        root_id: recovered,
      });
      expect(details(byCheckr)).toMatchObject({
        adopted: true,
        consentId: "consent-2",
        reportStatus: "pending",
      });
      expect(screeningEvents(fixture)).toHaveLength(2);
    } finally {
      checkr.restore();
    }
  });

  it("shows screening history only to organization managers", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = reportAt({ result: "clear", status: "complete" });
    try {
      await checkrWebhook(fixture.bindings, reportEvent("evt-3"));
    } finally {
      checkr.restore();
    }
    const feed = async (userId: string, role: string, path: string) => {
      const app = testApp(
        { "/api/activity": activity },
        { organizationId: orgId, organizationRole: role, userId },
      );
      const response = await app.request(path, undefined, fixture.bindings);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        events: Array<{
          action: string;
          actor: { name: string; type: string };
        }>;
      };
      return page.events.filter(
        ({ action }) => action === "employee_requirement.screening_updated",
      );
    };
    const query = "/api/activity?resourceType=employee_requirement";
    expect(await feed("owner", "owner", query)).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ name: "Checkr", type: "provider" }),
      }),
    ]);
    expect(await feed("employee", "member", query)).toEqual([]);
    expect(await feed("employee", "member", "/api/activity")).toEqual([]);
    const history = await fixture
      .app("owner", "owner")
      .request(`/${id}/activity`);
    expect(history.status).toBe(200);
    expect(
      (await fixture.app("employee", "member").request(`/${id}/activity`))
        .status,
    ).toBe(403);
  });
});
