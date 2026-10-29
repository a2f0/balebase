import { describe, expect, it } from "bun:test";
import { verifyCheckrWebhook } from "./checkr";
import { refreshActiveCheckrScreenings } from "./checkrSync";
import {
  checkrWebhook,
  createFixture,
  jsonPost,
  mockCheckr,
  now,
  orderedScreening,
  orgId,
  requestedScreening,
  withoutCheckrKey,
} from "./testing/employeeFormFixture";

describe("Checkr sync", () => {
  it("refreshes canceled reports and lets managers request the check again", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.database
      .query(`INSERT INTO employee_screening_consents
              (id, organization_id, requirement_id, user_id, signature_name,
               signed_at, disclosure_version, state_notices, document_key,
               created_at)
              VALUES ('consent-1', ?, ?, 'employee', 'Homer Simpson', ?, 'v',
                      '[]', 'consents/consent-1.pdf', ?)`)
      .run(orgId, id, now(), now());
    let reportResult: string | null = null;
    let reportStatus = "pending";
    const checkr = mockCheckr(() =>
      Response.json({
        id: "report-1",
        includes_canceled: true,
        result: reportResult,
        status: reportStatus,
      }),
    );
    const refresh = async () => {
      const response = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(response.status).toBe(200);
      return response.json();
    };
    const state = () =>
      fixture.database
        .query(`SELECT status, completed_at, checkr_result,
                       checkr_report_status
                FROM employee_requirements WHERE id = ?`)
        .get(id);
    try {
      expect(await refresh()).toEqual({
        reportStatus: "pending",
        result: null,
      });
      expect(state()).toEqual({
        checkr_report_status: "pending",
        checkr_result: null,
        completed_at: null,
        status: "in_progress",
      });
      reportStatus = "complete";
      expect(await refresh()).toEqual({
        reportStatus: "canceled",
        result: null,
      });
      expect(state()).toEqual({
        checkr_report_status: "canceled",
        checkr_result: null,
        completed_at: null,
        status: "pending",
      });
      reportResult = "consider";
      expect(await refresh()).toEqual({
        reportStatus: "partially_canceled",
        result: "consider",
      });

      const again = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/request`, jsonPost({ state: "NV" }));
      expect(again.status).toBe(200);
      expect(
        fixture.database
          .query(`SELECT status, checkr_report_id, checkr_report_status,
                         checkr_result, checkr_candidate_id, checkr_work_state
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_candidate_id: null,
        checkr_report_id: null,
        checkr_report_status: null,
        checkr_result: null,
        checkr_work_state: "NV",
        status: "pending",
      });
      const removed = await fixture
        .app("owner", "owner")
        .request(`/${id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT object_key FROM deleted_object_cleanup")
          .all(),
      ).toEqual([{ object_key: "consents/consent-1.pdf" }]);
    } finally {
      checkr.restore();
    }
  });

  it("keeps a completed screening when an older refresh finishes last", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.beforeRun(
      "checkr_refresh_revision = checkr_refresh_revision + 1",
      () => {
        fixture.database
          .query(`UPDATE employee_requirements
                  SET status = 'complete', checkr_result = 'clear',
                      checkr_refresh_revision = checkr_refresh_revision + 1
                  WHERE id = ?`)
          .run(id);
      },
    );
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_result: "clear", status: "complete" });
    } finally {
      checkr.restore();
    }
  });

  it("keeps manual completion when a canceled report refresh overlaps", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.database
      .query(`UPDATE employee_requirements
              SET checkr_report_status = 'canceled', status = 'pending'
              WHERE id = ?`)
      .run(id);
    let manualStatus = 0;
    const checkr = mockCheckr(async () => {
      if (!manualStatus) {
        manualStatus = (
          await fixture.app("owner", "owner").request(`/${id}`, {
            body: JSON.stringify({ status: "complete" }),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          })
        ).status;
      }
      return Response.json({
        id: "report-1",
        includes_canceled: true,
        result: null,
        status: "complete",
      });
    });
    try {
      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(manualStatus).toBe(200);
      expect(refreshed.status).toBe(409);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "complete" });
      const settled = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(settled.status).toBe(200);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "complete" });
    } finally {
      checkr.restore();
    }
  });

  it("verifies Checkr webhook signatures with Checkr's published example", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ monday: "75F", tuesday: "80F" }),
    );
    const signature =
      "b7412f05e981a473b5ecbdb5393afaea02a679db6d7c8e56803512ec4ba98151";
    expect(await verifyCheckrWebhook(payload, signature, "test-secret")).toBe(
      true,
    );
    expect(await verifyCheckrWebhook(payload, signature, "other-key")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, "not-hex", "test-secret")).toBe(
      false,
    );
    expect(await verifyCheckrWebhook(payload, undefined, "test-secret")).toBe(
      false,
    );
  });

  it("refreshes a screening from a signed Checkr report webhook", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: "clear", status: "complete" }),
    );
    try {
      const event = {
        data: { object: { id: "report-1", object: "report" } },
        id: "event-1",
        object: "event",
        type: "report.completed",
      };
      expect(
        (await checkrWebhook(withoutCheckrKey(fixture.bindings), event)).status,
      ).toBe(503);
      expect(
        (await checkrWebhook(fixture.bindings, event, "other-key")).status,
      ).toBe(400);
      expect((await checkrWebhook(fixture.bindings, event, null)).status).toBe(
        400,
      );
      for (const type of ["invitation.completed", "candidate.created"]) {
        const ignored = await checkrWebhook(fixture.bindings, {
          data: { object: { id: "candidate-1", object: "candidate" } },
          type,
        });
        expect(ignored.status).toBe(200);
      }
      const malformed = await checkrWebhook(fixture.bindings, {
        data: {},
        type: "report.completed",
      });
      expect(malformed.status).toBe(400);
      expect(checkr.calls).toEqual([]);

      const received = await checkrWebhook(fixture.bindings, event);
      expect(received.status).toBe(200);
      expect(await received.json()).toEqual({ received: true });
      expect(checkr.calls.map(({ url }) => url)).toEqual(["/reports/report-1"]);
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_report_status,
                         checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_report_status: "complete",
        checkr_result: "clear",
        status: "complete",
      });
    } finally {
      checkr.restore();
    }
  });

  it("matches a report webhook through its candidate and retries failed refreshes", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    let checkrAvailable = true;
    const checkr = mockCheckr(() =>
      checkrAvailable
        ? Response.json({
            candidate_id: "candidate-1",
            id: "report-1",
            result: "consider",
            status: "complete",
          })
        : Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      const stranger = await checkrWebhook(fixture.bindings, {
        data: { object: { id: "stranger-report", object: "report" } },
        type: "report.completed",
      });
      expect(stranger.status).toBe(200);
      expect(checkr.calls).toEqual([]);

      checkrAvailable = false;
      const unavailable = await checkrWebhook(fixture.bindings, {
        data: {
          object: {
            candidate_id: "candidate-1",
            id: "upgraded-report",
            object: "report",
          },
        },
        type: "report.upgraded",
      });
      expect(unavailable.status).toBe(200);
      expect(checkr.calls.map(({ url }) => url)).toEqual(["/reports/report-1"]);
      const requested = fixture.database
        .query(`SELECT status, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_refresh_requested_at: string; status: string };
      expect(requested.status).toBe("in_progress");
      expect(requested.checkr_refresh_requested_at).toEqual(expect.any(String));

      checkrAvailable = true;
      expect(await refreshActiveCheckrScreenings(fixture.bindings)).toEqual({
        notifications: {
          sent: 1,
          failed: 0,
          abandoned: 0,
          queueUnavailable: false,
        },
        refreshed: 1,
        skipped: false,
      });
      expect(
        fixture.database
          .query(`SELECT status, checkr_result, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_result: "consider",
        status: "complete",
      });
    } finally {
      checkr.restore();
    }
  });

  it("refreshes unfinished Checkr screenings on schedule", async () => {
    const fixture = await createFixture();
    const active = await orderedScreening(fixture);
    const failing = await orderedScreening(fixture, "report-2");
    const finished = await orderedScreening(fixture, "report-3");
    const canceled = await orderedScreening(fixture, "report-4");
    const waiting = await requestedScreening(fixture);
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete' WHERE id = ?",
      )
      .run(finished);
    fixture.database
      .query(`UPDATE employee_requirements
              SET status = 'pending', checkr_report_status = 'canceled'
              WHERE id = ?`)
      .run(canceled);
    const checkr = mockCheckr((call) =>
      call.url === "/reports/report-2"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      expect(
        await refreshActiveCheckrScreenings(withoutCheckrKey(fixture.bindings)),
      ).toEqual({
        refreshed: 0,
        skipped: true,
        notifications: {
          sent: 0,
          failed: 0,
          abandoned: 0,
          queueUnavailable: false,
        },
      });
      expect(checkr.calls).toEqual([]);
      await expect(
        refreshActiveCheckrScreenings(fixture.bindings),
      ).rejects.toThrow("Could not refresh 1 Checkr screening(s).");
      expect(checkr.calls.map(({ url }) => url).toSorted()).toEqual([
        "/reports/report-1",
        "/reports/report-2",
      ]);
      const rows = fixture.database
        .query("SELECT id, checkr_refresh_revision FROM employee_requirements")
        .all() as Array<{ checkr_refresh_revision: number; id: string }>;
      const revisions = Object.fromEntries(
        rows.map((row) => [row.id, row.checkr_refresh_revision]),
      );
      expect(revisions[active]).toBe(1);
      expect(revisions[failing]).toBe(0);
      expect(revisions[finished]).toBe(0);
      expect(revisions[canceled]).toBe(0);
      expect(revisions[waiting]).toBe(1);
    } finally {
      checkr.restore();
    }
  });

  it("rotates scheduled Checkr refreshes past screenings that keep failing", async () => {
    const fixture = await createFixture();
    const reports = Array.from(
      { length: 26 },
      (_, index) => `rotating-${String(index).padStart(2, "0")}`,
    );
    for (const report of reports) await orderedScreening(fixture, report);
    const attempted: string[][] = [];
    const checkr = mockCheckr((call) => {
      const report = /\/reports\/(.+)$/.exec(call.url)?.[1];
      if (report) attempted.at(-1)?.push(report);
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    try {
      for (let run = 0; run < 2; run += 1) {
        attempted.push([]);
        await expect(
          refreshActiveCheckrScreenings(fixture.bindings),
        ).rejects.toThrow("Could not refresh 24 Checkr screening(s).");
      }
      expect(attempted[0]).toHaveLength(24);
      const skipped = reports.filter(
        (report) => !attempted[0]?.includes(report),
      );
      expect(skipped).toHaveLength(2);
      for (const report of skipped) expect(attempted[1]).toContain(report);
      expect(
        fixture.database
          .query(`SELECT COUNT(*) AS unchecked FROM employee_requirements
                  WHERE checkr_checked_at IS NULL`)
          .get(),
      ).toEqual({ unchecked: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("keeps a Checkr refresh request that a racing refresh cannot settle", async () => {
    const newer = "2999-01-01T00:00:00.000Z";
    const event = {
      data: { object: { id: "report-1", object: "report" } },
      type: "report.completed",
    };
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    try {
      const requestedDuringRefresh = await createFixture();
      const first = await orderedScreening(requestedDuringRefresh);
      beforeCheckrRefreshWrite(requestedDuringRefresh, () => {
        requestedDuringRefresh.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_requested_at = ? WHERE id = ?`)
          .run(newer, first);
      });
      expect(
        (await checkrWebhook(requestedDuringRefresh.bindings, event)).status,
      ).toBe(200);
      expect(
        requestedDuringRefresh.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(first),
      ).toEqual({
        checkr_refresh_requested_at: newer,
        checkr_refresh_revision: 1,
      });

      const reordered = await createFixture();
      const delayed = await orderedScreening(reordered);
      reordered.database
        .query(`UPDATE employee_requirements
                SET checkr_refresh_requested_at = ? WHERE id = ?`)
        .run(newer, delayed);
      expect((await checkrWebhook(reordered.bindings, event)).status).toBe(200);
      expect(
        reordered.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(delayed),
      ).toEqual({
        checkr_refresh_requested_at: newer,
        checkr_refresh_revision: 1,
      });

      const conflicted = await createFixture();
      const second = await orderedScreening(conflicted);
      beforeCheckrRefreshWrite(conflicted, () => {
        conflicted.database
          .query(`UPDATE employee_requirements
                  SET checkr_refresh_revision = checkr_refresh_revision + 1
                  WHERE id = ?`)
          .run(second);
      });
      expect((await checkrWebhook(conflicted.bindings, event)).status).toBe(
        200,
      );
      const kept = conflicted.database
        .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                FROM employee_requirements WHERE id = ?`)
        .get(second) as {
        checkr_refresh_requested_at: string | null;
        checkr_refresh_revision: number;
      };
      expect(kept.checkr_refresh_revision).toBe(1);
      expect(kept.checkr_refresh_requested_at).toEqual(expect.any(String));
      expect(await refreshActiveCheckrScreenings(conflicted.bindings)).toEqual({
        notifications: {
          sent: 0,
          failed: 0,
          abandoned: 0,
          queueUnavailable: false,
        },
        refreshed: 1,
        skipped: false,
      });
      expect(
        conflicted.database
          .query(`SELECT checkr_refresh_revision, checkr_refresh_requested_at
                  FROM employee_requirements WHERE id = ?`)
          .get(second),
      ).toEqual({
        checkr_refresh_requested_at: null,
        checkr_refresh_revision: 2,
      });
    } finally {
      checkr.restore();
    }
  });
});

// Runs action just before a Checkr refresh records its result, skipping any
// earlier writes such as a webhook's refresh request.
function beforeCheckrRefreshWrite(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  action: () => void,
) {
  fixture.beforeRun(
    "checkr_refresh_revision = checkr_refresh_revision + 1",
    action,
  );
}
