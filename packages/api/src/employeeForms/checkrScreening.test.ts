import { describe, expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";
import {
  checkrResponses,
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
import { seedOrganization } from "../testing/seed";
import {
  screeningDisclosureVersion,
  summaryOfRightsUrl,
} from "./screeningDisclosures";

describe("Checkr screening", () => {
  it("requests a background check at a work location and emails the person", async () => {
    const fixture = await createFixture();
    configureCheckr(fixture);
    const id = await createRequirement(
      fixture,
      "background_check",
      "Background check",
    );
    const credit = await createRequirement(fixture, "credit_check", "Credit");
    const request = (
      requirementId: string,
      body: unknown,
      user = "owner",
      role = "owner",
    ) =>
      fixture
        .app(user, role)
        .request(`/${requirementId}/checkr/request`, jsonPost(body));

    expect(
      (await request(id, { state: "CA" }, "employee", "member")).status,
    ).toBe(403);
    for (const body of [
      { state: "ZZ" },
      { state: "ca" },
      { city: "S".repeat(101), state: "CA" },
      { city: 7, state: "CA" },
    ]) {
      const refused = await request(id, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "A US work state and optional city are required.",
      });
    }
    expect((await request(credit, { state: "CA" })).status).toBe(404);
    delete fixture.bindings.CHECKR_BACKGROUND_PACKAGE;
    expect((await request(id, { state: "CA" })).status).toBe(503);
    configureCheckr(fixture);

    const requested = await request(id, { city: " San Jose ", state: "CA" });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ emailed: true });
    expect(fixture.emails).toHaveLength(1);
    expect(fixture.emails[0]?.to.email).toBe("employee@example.com");
    expect(fixture.emails[0]?.subject).toBe(
      "Acme requested a background check",
    );
    expect(fixture.emails[0]?.text).toContain(
      `https://app.balebase.test/me/screening/${id}?organization=${orgId}`,
    );
    const listed = (await (
      await fixture.app("employee", "member").request("/")
    ).json()) as { requirements: Array<{ id: string }> };
    expect(listed.requirements.find((item) => item.id === id)).toMatchObject({
      canSubmitCheckr: true,
      checkrAvailable: true,
      checkrReportStatus: null,
      checkrRequested: true,
      checkrResult: null,
      checkrWorkLocation: { city: "San Jose", state: "CA" },
    });
    expect(
      listed.requirements.find((item) => item.id === credit),
    ).toMatchObject({ checkrAvailable: false, checkrRequested: false });
    const managed = (await (
      await fixture.app("owner", "owner").request("/")
    ).json()) as { requirements: Array<{ id: string }> };
    expect(managed.requirements.find((item) => item.id === id)).toMatchObject({
      canSubmitCheckr: false,
      checkrRequested: true,
    });

    const invited = await fixture.app("owner", "owner").request(
      "/",
      jsonPost({
        invitationId: "invite",
        requirements: [
          { dueDate: "2026-10-01", kind: "background_check", title: "Check" },
        ],
      }),
    );
    const [invitedId] = ((await invited.json()) as { ids: string[] }).ids;
    expect((await request(invitedId ?? "", { state: "NY" })).status).toBe(200);
    expect(fixture.emails[1]?.to.email).toBe("invitee@example.com");
    expect(fixture.emails[1]?.text).toContain("Accept your invitation to Acme");
    expect(fixture.emails[1]?.text).toContain(
      `https://app.balebase.test/me?organization=${orgId}`,
    );
  });

  it("serves the screening form only to the person, with test candidates in staging", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) =>
      call.url.startsWith("/packages")
        ? Response.json({
            data: [
              { screenings: [{ type: "ssn_trace" }], slug: "other_package" },
              {
                screenings: [
                  { type: "ssn_trace" },
                  { type: "motor_vehicle_report" },
                ],
                slug: "background_package",
              },
            ],
          })
        : Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      const managerView = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/form`);
      expect(managerView.status).toBe(404);
      const form = await fixture
        .app("employee", "member")
        .request(`/${id}/checkr/form`);
      expect(form.status).toBe(200);
      const body = (await form.json()) as {
        disclosures: { stateNotices: Record<string, unknown>; version: string };
        testCandidates: Array<{ expectedResult: string; id: string }> | null;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        candidate: { email: "employee@example.com", name: "employee" },
        organizationName: "Acme",
        requiresDriverLicense: true,
        summaryOfRightsUrl,
        title: "Background check",
        workLocation: { city: "San Jose", state: "CA" },
      });
      expect(body.disclosures.version).toBe(screeningDisclosureVersion);
      expect(Object.keys(body.disclosures.stateNotices)).toContain("CA");
      expect(body.testCandidates).toHaveLength(6);
      expect(body.testCandidates?.[0]).toMatchObject({
        expectedResult: "clear",
        id: "homer-simpson",
      });

      fixture.bindings.CHECKR_ENV = "production";
      checkr.respond = () =>
        Response.json({ error: "unavailable" }, { status: 503 });
      const production = (await (
        await fixture.app("employee", "member").request(`/${id}/checkr/form`)
      ).json()) as { requiresDriverLicense: boolean; testCandidates: unknown };
      expect(production.testCandidates).toBeNull();
      expect(production.requiresDriverLicense).toBe(false);
    } finally {
      checkr.restore();
    }
  });

  it("orders a report with the person's details and signed authorization", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const submitted = await submitScreening(fixture, id, homerSubmission());
      expect(submitted.status).toBe(200);
      expect(await submitted.json()).toEqual({ status: "pending" });
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "POST /candidates",
          "POST /candidates/candidate-1/documents",
          "POST /reports",
        ],
      );
      const [candidateCall, documentCall, reportCall] = checkr.calls;
      const candidate = new URLSearchParams(String(candidateCall?.body));
      expect(Object.fromEntries(candidate)).toEqual({
        copy_requested: "true",
        custom_id: id,
        dob: "1983-02-10",
        driver_license_number: "M2233344",
        driver_license_state: "CA",
        email: "employee@example.com",
        first_name: "Homer",
        last_name: "Simpson",
        no_middle_name: "true",
        ssn: "110-11-1100",
        zipcode: "94088",
      });
      const nonce = candidateCall?.idempotencyKey?.replace(/:candidate$/, "");
      expect(nonce).toEqual(expect.any(String));
      expect(documentCall?.idempotencyKey).toStartWith(`${nonce}:consent:`);
      expect(reportCall?.idempotencyKey).toBe(`${nonce}:report`);
      const document = documentCall?.body as FormData;
      expect(document.get("type")).toBe("consent");
      expect((document.get("file") as File).type).toBe("application/pdf");
      expect(
        Object.fromEntries(new URLSearchParams(String(reportCall?.body))),
      ).toEqual({
        candidate_id: "candidate-1",
        package: "background_package",
        "work_locations[][city]": "San Jose",
        "work_locations[][country]": "US",
        "work_locations[][state]": "CA",
      });

      const requirement = fixture.database
        .query(`SELECT status, checkr_candidate_id, checkr_report_id,
                       checkr_report_status, checkr_consent_id,
                       checkr_start_nonce
                FROM employee_requirements WHERE id = ?`)
        .get(id) as { checkr_consent_id: string };
      expect(requirement).toMatchObject({
        checkr_candidate_id: "candidate-1",
        checkr_report_id: "report-1",
        checkr_report_status: "pending",
        checkr_start_nonce: null,
        status: "in_progress",
      });
      const consent = fixture.database
        .query("SELECT * FROM employee_screening_consents")
        .get() as { document_key: string };
      expect(consent).toMatchObject({
        copy_requested: 1,
        disclosure_version: screeningDisclosureVersion,
        id: requirement.checkr_consent_id,
        ip_address: "203.0.113.7",
        requirement_id: id,
        signature_name: "Homer Simpson",
        state_notices: '["CA"]',
        user_agent: "Test browser",
        user_id: "employee",
      });
      const stored = JSON.stringify([
        fixture.database.query("SELECT * FROM employee_requirements").all(),
        fixture.database
          .query("SELECT * FROM employee_screening_consents")
          .all(),
      ]);
      expect(stored).not.toContain("110-11-1100");
      expect(stored).not.toContain("1983-02-10");
      const pdf = fixture.files.get(String(consent.document_key));
      expect(
        new TextDecoder().decode((await pdf?.arrayBuffer())?.slice(0, 5)),
      ).toBe("%PDF-");

      for (const [user, role, status] of [
        ["employee", "member", 200],
        ["owner", "owner", 200],
        ["invitee", "member", 404],
      ] as const) {
        const download = await fixture
          .app(user, role)
          .request(`/${id}/checkr/consent`);
        expect(download.status).toBe(status);
      }

      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(409);
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${id}`, { method: "DELETE" })
        ).status,
      ).toBe(409);
      const manual = await fixture.app("owner", "owner").request(`/${id}`, {
        body: JSON.stringify({ status: "complete" }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      expect(manual.status).toBe(400);
      const ownView = (await (
        await fixture.app("employee", "member").request("/")
      ).json()) as { requirements: Array<Record<string, unknown>> };
      expect(ownView.requirements[0]).toMatchObject({
        checkrReportStatus: "pending",
        checkrRequested: false,
        checkrResult: null,
        hasCheckrConsent: true,
      });

      const refreshed = await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(await refreshed.json()).toEqual({
        reportStatus: "complete",
        result: "clear",
      });
      expect(
        fixture.database
          .query(
            "SELECT status, checkr_result FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_result: "clear", status: "complete" });
      const hidden = (await (
        await fixture.app("employee", "member").request("/")
      ).json()) as { requirements: Array<{ checkrResult: string | null }> };
      expect(hidden.requirements[0]?.checkrResult).toBeNull();
    } finally {
      checkr.restore();
    }
  });

  it("checks acknowledgments and details before contacting Checkr", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const unrequested = await createRequirement(
      fixture,
      "background_check",
      "Not requested",
    );
    const checkr = mockCheckr(checkrResponses);
    try {
      const valid = homerSubmission();
      const cases: Array<[unknown, string]> = [
        [
          { ...valid, disclosureFingerprint: "stale" },
          "These disclosures changed after you opened the form. Reload the page to review the current version.",
        ],
        [
          {
            ...valid,
            acknowledgments: {
              ...valid.acknowledgments,
              summaryOfRights: false,
            },
          },
          "Acknowledge the summary of your rights and the disclosure before submitting.",
        ],
        [
          {
            ...valid,
            acknowledgments: { ...valid.acknowledgments, stateNotices: [] },
          },
          "Acknowledge each state notice before submitting.",
        ],
        [
          { ...valid, residenceState: "NY" },
          "Acknowledge each state notice before submitting.",
        ],
        [
          { ...valid, signature: { ...valid.signature, name: "Someone Else" } },
          "Type your full legal name to sign.",
        ],
        [
          {
            ...valid,
            signature: { ...valid.signature, electronicRecords: false },
          },
          "Agree to sign electronically and authorize the background check to submit.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, ssn: "12345" } },
          "Enter a 9-digit Social Security number.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, dob: "2999-01-01" } },
          "Enter a valid date of birth.",
        ],
        [
          {
            ...valid,
            candidate: { ...valid.candidate, driverLicenseState: "" },
          },
          "Enter both your driver's license number and its state, or leave both blank.",
        ],
        [
          { ...valid, candidate: { ...valid.candidate, noMiddleName: false } },
          "Enter your legal first and last name, and your middle name or that you have none. Checkr accepts letters A–Z and accented letters such as é or ñ.",
        ],
      ];
      for (const [body, error] of cases) {
        const response = await submitScreening(fixture, id, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
      }
      expect(
        (await submitScreening(fixture, id, valid, "owner", "owner")).status,
      ).toBe(404);
      expect((await submitScreening(fixture, unrequested, valid)).status).toBe(
        409,
      );
      const stale = await submitScreening(fixture, id, {
        ...valid,
        requestRevision: "2026-01-01T00:00:00.000Z",
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error:
          "This background check changed after you opened it. Reload the page to review it again.",
      });
      expect(checkr.calls).toEqual([]);
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("clears an attempt Checkr rejects so the person can correct it", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let reject: "candidate" | "report" | null = "candidate";
    let candidates = 0;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        if (reject === "candidate") {
          return Response.json({ error: "Ssn is invalid" }, { status: 400 });
        }
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.method === "POST" && call.url === "/reports" && reject) {
        return Response.json(
          { error: ["Driver license number is required"] },
          { status: 422 },
        );
      }
      return checkrResponses(call);
    });
    try {
      const rejected = await submitScreening(fixture, id, homerSubmission());
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toEqual({
        error: "Checkr couldn't accept these details: Ssn is invalid",
      });
      const cleared = () =>
        fixture.database
          .query(`SELECT checkr_start_nonce, checkr_candidate_id, status
                  FROM employee_requirements WHERE id = ?`)
          .get(id);
      expect(cleared()).toEqual({
        checkr_candidate_id: null,
        checkr_start_nonce: null,
        status: "pending",
      });

      reject = "report";
      const missingLicense = await submitScreening(
        fixture,
        id,
        homerSubmission(),
      );
      expect(missingLicense.status).toBe(422);
      expect(await missingLicense.json()).toEqual({
        error:
          "Checkr couldn't accept these details: Driver license number is required",
      });
      expect(cleared()).toEqual({
        checkr_candidate_id: null,
        checkr_start_nonce: null,
        status: "pending",
      });

      reject = null;
      const corrected = await submitScreening(fixture, id, homerSubmission());
      expect(corrected.status).toBe(200);
      const candidateKeys = checkr.calls
        .filter(({ method, url }) => method === "POST" && url === "/candidates")
        .map(({ idempotencyKey }) => idempotencyKey);
      expect(new Set(candidateKeys).size).toBe(3);
      expect(
        fixture.database
          .query(
            "SELECT checkr_candidate_id, checkr_report_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        checkr_candidate_id: "candidate-2",
        checkr_report_id: "report-1",
      });
      // Each signed attempt keeps its authorization record.
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      checkr.restore();
    }
  });

  it("starts a new candidate when the person corrects details after a failed attempt", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let candidates = 0;
    let uploadAvailable = false;
    const checkr = mockCheckr((call) => {
      if (call.method === "POST" && call.url === "/candidates") {
        candidates += 1;
        return Response.json({ id: `candidate-${candidates}` });
      }
      if (call.url === "/candidates/candidate-1") {
        return Response.json({
          dob: "1983-02-10",
          first_name: "Homer",
          id: "candidate-1",
          last_name: "Simpson",
          report_ids: [],
          ssn: "XXX-XX-1100",
          zipcode: "94088",
        });
      }
      if (call.url.endsWith("/documents") && !uploadAvailable) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return checkrResponses(call);
    });
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(502);
      uploadAvailable = true;
      checkr.calls.length = 0;
      const corrected = {
        ...homerSubmission(),
        candidate: { ...homerSubmission().candidate, ssn: "111-11-1100" },
      };
      expect((await submitScreening(fixture, id, corrected)).status).toBe(200);
      expect(checkr.calls.map(({ method, url }) => `${method} ${url}`)).toEqual(
        [
          "GET /candidates/candidate-1",
          "POST /candidates",
          "POST /candidates/candidate-2/documents",
          "POST /reports",
        ],
      );
      expect(
        new URLSearchParams(String(checkr.calls[1]?.body)).get("ssn"),
      ).toBe("111-11-1100");
      expect(
        fixture.database
          .query(
            "SELECT checkr_candidate_id FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_candidate_id: "candidate-2" });
    } finally {
      checkr.restore();
    }
  });

  it("queues a consent PDF for cleanup until its record exists", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      fixture.storageState.failPutAfterWrite = true;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(500);
      const [stored] = [...fixture.files.keys()];
      expect(stored).toContain("/screening-consents/");
      expect(
        fixture.database
          .query("SELECT object_key FROM deleted_object_cleanup")
          .all(),
      ).toEqual([{ object_key: stored }]);
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM employee_screening_consents")
          .get(),
      ).toEqual({ count: 0 });
      expect(checkr.calls).toEqual([]);

      fixture.storageState.failPutAfterWrite = false;
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(200);
      const consent = fixture.database
        .query("SELECT document_key FROM employee_screening_consents")
        .get() as { document_key: string };
      expect(
        fixture.database
          .query(
            "SELECT COUNT(*) AS count FROM deleted_object_cleanup WHERE object_key = ?",
          )
          .get(consent.document_key),
      ).toEqual({ count: 0 });
    } finally {
      checkr.restore();
    }
  });

  it("keeps an attempt when Checkr refuses access instead of the details", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    let failure: { status: number; url: string } = {
      status: 503,
      url: "/candidates/candidate-1/documents",
    };
    const checkr = mockCheckr((call) =>
      call.url === failure.url
        ? Response.json({ error: "Not allowed" }, { status: failure.status })
        : call.url === "/candidates/candidate-1"
          ? Response.json({ id: "candidate-1", report_ids: [] })
          : checkrResponses(call),
    );
    const attempt = () =>
      fixture.database
        .query(`SELECT checkr_candidate_id, checkr_start_nonce IS NOT NULL AS held
                FROM employee_requirements WHERE id = ?`)
        .get(id);
    try {
      expect(
        (await submitScreening(fixture, id, homerSubmission())).status,
      ).toBe(502);
      for (const next of [
        { status: 401, url: "/candidates/candidate-1" },
        { status: 403, url: "/reports" },
      ]) {
        failure = next;
        const response = await submitScreening(fixture, id, homerSubmission());
        expect(response.status).toBe(502);
        expect(attempt()).toEqual({
          checkr_candidate_id: "candidate-1",
          held: 1,
        });
      }
    } finally {
      checkr.restore();
    }
  });

  it("does not order a check the request or membership changed under", async () => {
    for (const change of [
      "UPDATE employee_requirements SET checkr_requested_at = '2999-01-01T00:00:00.000Z', checkr_work_state = 'NV'",
      "DELETE FROM member WHERE id = 'employee-member'",
    ]) {
      const fixture = await createFixture();
      const id = await requestedScreening(fixture);
      const checkr = mockCheckr(checkrResponses);
      fixture.hooks.before(
        "SET checkr_start_nonce = COALESCE",
        () => {
          fixture.database.query(change).run();
        },
        { method: "first" },
      );
      try {
        const raced = await submitScreening(fixture, id, homerSubmission());
        expect(raced.status).toBe(409);
        expect(checkr.calls).toEqual([]);
        expect(
          fixture.database
            .query(
              "SELECT checkr_start_nonce, checkr_report_id FROM employee_requirements WHERE id = ?",
            )
            .get(id),
        ).toEqual({ checkr_report_id: null, checkr_start_nonce: null });
      } finally {
        checkr.restore();
      }
    }
  });

  it("rejects a signature over wording that changed after the form loaded", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const form = (await (
        await fixture.app("employee", "member").request(`/${id}/checkr/form`)
      ).json()) as { disclosureFingerprint: string };
      fixture.database
        .query("UPDATE organization SET name = 'Acme Holdings' WHERE id = ?")
        .run(orgId);
      checkr.calls.length = 0;
      const stale = await submitScreening(fixture, id, {
        ...homerSubmission(),
        disclosureFingerprint: form.disclosureFingerprint,
      });
      expect(stale.status).toBe(400);
      expect(await stale.json()).toEqual({
        error:
          "These disclosures changed after you opened the form. Reload the page to review the current version.",
      });
      expect(checkr.calls).toEqual([]);
    } finally {
      checkr.restore();
    }
  });

  it("orders no report for a person removed while submitting", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr((call) => {
      if (call.url.endsWith("/documents")) {
        fixture.database
          .query("DELETE FROM member WHERE id = 'employee-member'")
          .run();
      }
      return checkrResponses(call);
    });
    try {
      const response = await submitScreening(fixture, id, homerSubmission());
      expect(response.status).toBe(409);
      expect(
        checkr.calls.some(
          ({ method, url }) => method === "POST" && url === "/reports",
        ),
      ).toBe(false);
      expect(
        fixture.database
          .query(
            "SELECT checkr_report_id, checkr_report_requested_at FROM employee_requirements WHERE id = ?",
          )
          .get(id),
      ).toEqual({ checkr_report_id: null, checkr_report_requested_at: null });
    } finally {
      checkr.restore();
    }
  });

  it("lets only the signed-in person, not a key or impersonator, open or sign their form", async () => {
    const fixture = await createFixture();
    const id = await requestedScreening(fixture);
    const checkr = mockCheckr(checkrResponses);
    try {
      const viaKey = fixture.app("employee", "member", { apiKey: true });
      const impersonated = fixture.app("employee", "member", {
        impersonatedBy: "root-admin",
      });
      for (const response of [
        await viaKey.request(`/${id}/checkr/form`),
        await viaKey.request(
          `/${id}/checkr/submit`,
          jsonPost(homerSubmission()),
        ),
        await impersonated.request(`/${id}/checkr/form`),
        await impersonated.request(
          `/${id}/checkr/submit`,
          jsonPost(homerSubmission()),
        ),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "Sign in to complete your own background check.",
        });
      }
      expect(checkr.calls).toEqual([]);
    } finally {
      checkr.restore();
    }
  });

  it("keeps hosted reports, stops on open invitations, and resets closed ones when migrating", async () => {
    const database = createTestDatabase({ before: "0067" });
    seedOrganization(database, { id: orgId });
    const insert = database.query(`INSERT INTO employee_requirements
      (id, organization_id, target_email, kind, title, due_date, status,
       created_at, updated_at, checkr_candidate_id, checkr_invitation_id,
       checkr_invitation_status, checkr_report_id, checkr_result)
      VALUES (?, ?, 'a@example.com', 'background_check', 'Check',
              '2026-10-01', ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "reported",
      orgId,
      "complete",
      now(),
      now(),
      "c1",
      "i1",
      "completed",
      "r1",
      "clear",
    );
    insert.run(
      "canceled",
      orgId,
      "pending",
      now(),
      now(),
      "c2",
      "i2",
      "partially_canceled",
      "r2",
      "consider",
    );
    insert.run(
      "invited",
      orgId,
      "in_progress",
      now(),
      now(),
      "c3",
      "i3",
      "pending",
      null,
      null,
    );
    const migrate0067 = () =>
      applyMigrations(database, { before: "0068", from: "0067" });
    expect(migrate0067).toThrow(
      "Finish or cancel open hosted Checkr invitations first",
    );
    expect(
      database
        .query(
          "SELECT checkr_invitation_id FROM employee_requirements WHERE id = 'invited'",
        )
        .get(),
    ).toEqual({ checkr_invitation_id: "i3" });
    database
      .query(`UPDATE employee_requirements
              SET checkr_invitation_status = 'expired' WHERE id = 'invited'`)
      .run();
    // The failed attempt rolled back, so the retry starts from 0066's schema.
    migrate0067();
    expect(
      database
        .query(`SELECT id, status, checkr_candidate_id, checkr_report_id,
                       checkr_report_status
                FROM employee_requirements ORDER BY id`)
        .all(),
    ).toEqual([
      {
        checkr_candidate_id: "c2",
        checkr_report_id: "r2",
        checkr_report_status: "partially_canceled",
        id: "canceled",
        status: "pending",
      },
      {
        checkr_candidate_id: null,
        checkr_report_id: null,
        checkr_report_status: null,
        id: "invited",
        status: "pending",
      },
      {
        checkr_candidate_id: "c1",
        checkr_report_id: "r1",
        checkr_report_status: "complete",
        id: "reported",
        status: "complete",
      },
    ]);
  });
});
