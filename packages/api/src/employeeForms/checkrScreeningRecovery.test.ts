import { describe, expect, it } from "bun:test";
import {
  checkrResponses,
  checkrRunActor,
  checkrWebhook,
  configureCheckr,
  createFixture,
  createRequirement,
  homerSubmission,
  jsonPost,
  mockCheckr,
  now,
  orgId,
  requestedScreening,
  submitScreening,
} from "../testing/employeeFormFixture";
import { recoverCheckrAttempt } from "./checkrScreening";
import { refreshActiveCheckrScreenings } from "./checkrSync";

describe("Checkr screening recovery", () => {
  it("resumes a lost submission without ordering a second report", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let reportOrdered = false;
    let failUpload = true;
    const checkr = mockCheckr((call) => {
      if (call.url === "/candidates/candidate-1/documents" && failUpload) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (call.method === "POST" && call.url === "/reports") {
        reportOrdered = true;
        throw new TypeError("Network connection lost.");
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          id: "candidate-1",
          report_ids: reportOrdered ? ["report-1"] : [],
        });
      }
      if (call.url === "/reports/report-1") {
        return Response.json({
          id: "report-1",
          result: null,
          status: "pending",
        });
      }
      return checkrResponses(call);
    });
    try {
      const unavailable = await submitScreening(fixture, id, homerSubmission());
      expect(unavailable.status).toBe(502);
      const kept = fixture.database
        .query(`SELECT checkr_start_nonce, checkr_candidate_id,
                       checkr_starting_at
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_start_nonce: string | null };
      expect(kept).toMatchObject({
        checkr_candidate_id: "candidate-1",
        checkr_starting_at: null,
      });
      expect(checkr.calls[0]?.idempotencyKey).toBe(
        `${kept.checkr_start_nonce}:candidate`,
      );

      failUpload = false;
      checkr.calls.length = 0;
      const lost = await submitScreening(fixture, id, homerSubmission());
      expect(lost.status).toBe(500);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "GET /candidates/candidate-1",
          "POST /candidates/candidate-1/documents",
          "POST /reports",
        ],
      );
      expect(checkr.calls[2]?.idempotencyKey).toBe(
        `${kept.checkr_start_nonce}:report`,
      );
      const uploaded = checkr.calls[1]?.idempotencyKey?.split(":consent:")[1];

      checkr.calls.length = 0;
      const resumed = await submitScreening(fixture, id, {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "999-99-9999" },
      });
      expect(resumed.status).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1", "GET /reports/report-1"],
      );
      // The adopted report keeps the authorization that ordered it.
      expect(
        fixture.database
          .query(`SELECT checkr_report_id, checkr_consent_id,
                         checkr_start_nonce, status
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_consent_id: uploaded,
        checkr_report_id: "report-1",
        checkr_start_nonce: null,
        status: "in_progress",
      });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      checkr.restore();
    }
  });

  it("asks the person to wait while a lost report request may still reach Checkr", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let candidates = 0;
    let reportLost = true;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          first_name: "Homer",
          id: "candidate-1",
          report_ids: [],
          ssn: "XXX-XX-1100",
        });
      }
      if (call.method === "POST" && call.url === "/reports" && reportLost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    const corrected = {
      ...homerSubmission(),
      candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
    };
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      checkr.calls.length = 0;
      const early = await submitScreening(fixture, id, corrected);
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual({
        error:
          "Your earlier submission may still be reaching Checkr. Wait a few minutes, then submit again.",
      });
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1"],
      );

      reportLost = false;
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_report_requested_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(id);
      checkr.calls.length = 0;
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      expect(
        checkr.calls
          .filter(({ method }) => method === "POST")
          .map(({ url }) => url),
      ).toEqual([
        "/candidates",
        "/candidates/candidate-2/documents",
        "/reports",
      ]);
    } finally {
      checkr.restore();
    }
  });

  it("does not replay a lost candidate request with corrected details", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let lost = true;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates" && lost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    const candidateKeys = () =>
      checkr.calls
        .filter(({ method, url }) => method === "POST" && url === "/candidates")
        .map(({ idempotencyKey }) => idempotencyKey);
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [first, replayed] = candidateKeys();
      expect(replayed).toBe(first);

      lost = false;
      const corrected = {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
      };
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      const keys = candidateKeys();
      expect(keys).toHaveLength(3);
      expect(keys[2]).not.toBe(first);
      const created = checkr.calls.filter(
        ({ method, url }) => method === "POST" && url === "/candidates",
      )[2];
      expect(new URLSearchParams(String(created?.body)).get("ssn")).toBe(
        "111-11-1100",
      );
    } finally {
      checkr.restore();
    }
  });

  it("replays a lost report request without attaching a newer authorization", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let lost = true;
    const checkr = mockCheckr((call) => {
      if (call.url === "/candidates/candidate-1") {
        return Response.json({ id: "candidate-1", report_ids: [] });
      }
      if (call.method === "POST" && call.url === "/reports" && lost) {
        throw new TypeError("Network connection lost.");
      }
      return checkrResponses(call);
    });
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [, upload, firstReport] = checkr.calls;
      const authorization = upload?.idempotencyKey?.split(":consent:")[1];
      // Even a day later, the replay keeps the report request's key.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(id);
      lost = false;
      checkr.calls.length = 0;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        ["GET /candidates/candidate-1", "POST /reports"],
      );
      expect(checkr.calls[1]?.idempotencyKey).toBe(
        firstReport?.idempotencyKey ?? "",
      );
      expect(
        fixture.database
          .query(
            "SELECT checkr_consent_id, checkr_report_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_consent_id: authorization,
        checkr_report_id: "report-1",
      });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      checkr.restore();
    }
  });

  it("settles an unfinished submission after its person leaves", async () => {
    const fixture = await createFixture();
    const adopted = await requestedScreening(fixture);
    const abandoned = await createRequirement(
      fixture,
      "background_check",
      "Abandoned check",
    );
    await fixture
      .app("owner", "owner")
      .request(`/${abandoned}/checkr/request`, jsonPost({ state: "CA" }));
    let reportCreated = false;
    let failUpload = false;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        return Response.json({
          id: failUpload ? "candidate-2" : "candidate-1",
        });
      }
      if (call.url.endsWith("/documents") && failUpload) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      if (call.method === "POST" && call.url === "/reports") {
        reportCreated = true;
        throw new TypeError("Network connection lost.");
      }
      if (call.url.startsWith("/candidates/")) {
        return Response.json({
          id: call.url.split("/")[2],
          report_ids:
            call.url === "/candidates/candidate-1" && reportCreated
              ? ["report-1"]
              : [],
        });
      }
      return Response.json({ id: "report-1", result: null, status: "pending" });
    });
    try {
      expect(
        (await submitScreening(fixture, adopted, homerSubmission())).status,
      ).toBe(500);
      failUpload = true;
      expect(
        (await submitScreening(fixture, abandoned, homerSubmission())).status,
      ).toBe(502);
      fixture.database
        .query("DELETE FROM member WHERE id = 'employee-member'")
        .run();
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${abandoned}`, { method: "DELETE" })
        ).status,
      ).toBe(409);

      // A report event for the candidate adopts its report at once.
      const event = await checkrWebhook(fixture.bindings, {
        data: {
          object: {
            candidate_id: "candidate-1",
            id: "report-1",
            object: "report",
          },
        },
        type: "report.created",
      });
      expect(event.status).toBe(200);
      const consent = fixture.database
        .query(
          "SELECT id FROM employee_screening_consents WHERE requirement_id = ?",
        )
        .get(adopted) as { id: string };
      expect(
        fixture.database
          .query(`SELECT checkr_report_id, checkr_consent_id, checkr_start_nonce
                  FROM employee_requirements WHERE id = ?`)
          .get(adopted),
      ).toEqual({
        checkr_consent_id: consent.id,
        checkr_report_id: "report-1",
        checkr_start_nonce: null,
      });

      // The hourly job clears an attempt that never reached a report.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce_at = '2026-01-01T00:00:00.000Z'
                WHERE id = ?`)
        .run(abandoned);
      await refreshActiveCheckrScreenings(
        fixture.bindings,
        crypto.randomUUID(),
      );
      expect(
        fixture.database
          .query(`SELECT checkr_start_nonce, checkr_candidate_id
                  FROM employee_requirements WHERE id = ?`)
          .get(abandoned),
      ).toEqual({ checkr_candidate_id: null, checkr_start_nonce: null });
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${abandoned}`, { method: "DELETE" })
        ).status,
      ).toBe(200);
    } finally {
      checkr.restore();
    }
  });

  it("recovers an attempt as it is when claimed, not as it was read", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let report = false;
    const checkr = mockCheckr((call) =>
      call.url === "/candidates/candidate-1"
        ? Response.json({
            id: "candidate-1",
            report_ids: report ? ["report-1"] : [],
          })
        : Response.json({ id: "report-1", result: null, status: "pending" }),
    );
    const stale = {
      checkr_attempt_consent_id: "consent-old",
      checkr_candidate_id: "candidate-1",
      checkr_report_requested_at: null,
      checkr_start_nonce: "attempt",
      id,
      organization_id: orgId,
    };
    try {
      // A retry asked for the report after the row was read.
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_start_nonce = 'attempt',
                    checkr_start_nonce_at = '2026-01-01T00:00:00.000Z',
                    checkr_candidate_id = 'candidate-1',
                    checkr_attempt_consent_id = 'consent-new',
                    checkr_report_requested_at = ?
                WHERE id = ?`)
        .run(new Date().toISOString(), id);
      expect(
        await recoverCheckrAttempt(fixture.bindings, stale, checkrRunActor()),
      ).toBe("waiting");
      expect(
        fixture.database
          .query(
            "SELECT checkr_start_nonce, checkr_starting_at FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_start_nonce: "attempt", checkr_starting_at: null });

      report = true;
      expect(
        await recoverCheckrAttempt(fixture.bindings, stale, checkrRunActor()),
      ).toBe("adopted");
      expect(
        fixture.database
          .query(
            "SELECT checkr_report_id, checkr_consent_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_consent_id: "consent-new",
        checkr_report_id: "report-1",
      });
    } finally {
      checkr.restore();
    }
  });

  it("rotates attempt recovery past attempts that keep failing", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const candidates = Array.from(
      { length: 26 },
      (_, index) => `stuck-${String(index).padStart(2, "0")}`,
    );
    for (const candidate of candidates) {
      const id = await createRequirement(fixture, "background_check", "Check");
      fixture.database
        .query(`UPDATE employee_requirements
                SET checkr_requested_at = ?, checkr_start_nonce = ?,
                    checkr_start_nonce_at = '2026-01-01T00:00:00.000Z',
                    checkr_candidate_id = ?
                WHERE id = ?`)
        .run(now(), `nonce-${candidate}`, candidate, id);
    }
    const attempted: string[][] = [];
    const checkr = mockCheckr((call) => {
      const candidate = /^\/candidates\/(.+)$/.exec(call.url)?.[1];
      if (candidate) attempted.at(-1)?.push(candidate);
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    try {
      for (let run = 0; run < 2; run += 1) {
        attempted.push([]);
        await expect(
          refreshActiveCheckrScreenings(fixture.bindings, crypto.randomUUID()),
        ).rejects.toThrow();
      }
      expect(attempted[0]).toHaveLength(24);
      const skipped = candidates.filter(
        (candidate) => !attempted[0]?.includes(candidate),
      );
      expect(skipped).toHaveLength(2);
      for (const candidate of skipped) {
        expect(attempted[1]).toContain(candidate);
      }
      expect(
        fixture.database
          .query(`SELECT COUNT(*) AS held FROM employee_requirements
                  WHERE checkr_start_nonce IS NOT NULL
                    AND checkr_starting_at IS NULL`)
          .get(),
      ).toEqual({ held: 26 });
    } finally {
      checkr.restore();
    }
  });

  it("fences a submission whose claim expired out of the newer claim", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) => {
      if (call.url.endsWith("/documents")) {
        // This request is slow; its claim expires and another one takes over.
        fixture.database
          .query(`UPDATE employee_requirements
                  SET checkr_start_lease = 'newer-claim',
                      checkr_starting_at = '2999-01-01T00:00:00.000Z'
                  WHERE id = ?`)
          .run(id);
      }
      return checkrResponses(call);
    });
    try {
      const slow = await submitScreening(fixture, id, homerSubmission());
      expect(slow.status).toBe(409);
      expect(
        checkr.calls.some(
          ({ method, url }) => method === "POST" && url === "/reports",
        ),
      ).toBe(false);
      expect(
        fixture.database
          .query(`SELECT checkr_start_lease, checkr_starting_at,
                         checkr_attempt_consent_id
                  FROM employee_requirements WHERE id = ?`)
          .get(id),
      ).toEqual({
        checkr_attempt_consent_id: null,
        checkr_start_lease: "newer-claim",
        checkr_starting_at: "2999-01-01T00:00:00.000Z",
      });
    } finally {
      checkr.restore();
    }
  });
});
