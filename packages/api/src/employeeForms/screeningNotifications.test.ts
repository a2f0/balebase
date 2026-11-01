import { describe, expect, it } from "bun:test";
import { applyMigrations } from "../testing/database";
import {
  checkrWebhook,
  createFixture,
  mockCheckr,
  orderedScreening,
  orgId,
  requestedScreening,
  withoutCheckrKey,
} from "../testing/employeeFormFixture";
import { refreshActiveCheckrScreenings } from "./checkrSync";
import { sendPendingScreeningNotifications } from "./screeningNotifications";

describe("screening notifications", () => {
  it("emails a branded completion once across repeated and concurrent refreshes", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: "consider", status: "complete" }),
    );
    try {
      const event = {
        data: { object: { id: "report-1" } },
        type: "report.completed",
      };
      await checkrWebhook(fixture.bindings, event);
      await Promise.all([
        checkrWebhook(fixture.bindings, event),
        sendPendingScreeningNotifications(fixture.bindings),
        fixture
          .app("owner", "owner")
          .request(`/${id}/checkr/refresh`, { method: "POST" }),
      ]);
      expect(fixture.emails).toHaveLength(1);
      const mail = fixture.emails[0];
      expect(mail?.from.name).toBe("Acme via Balebase");
      expect(mail?.to.email).toBe("employee@example.com");
      expect(mail?.subject).toBe("Acme: your background report is ready");
      expect(mail?.text).toContain(
        `https://app.balebase.test/me/screening/${id}?organization=${orgId}`,
      );
      expect(mail?.text).toContain(
        "A completed report is not a hiring decision.",
      );
      expect(mail?.text).not.toContain("consider");
      expect(mail?.html).toContain(
        'src="https://app.balebase.test/apple-touch-icon.png"',
      );
      expect(mail?.html).toContain("View screening status");
    } finally {
      checkr.restore();
    }
  });

  it("retries failed completion mail on maintenance without losing completed status", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    const send = fixture.bindings.EMAIL.send;
    fixture.bindings.EMAIL.send = async () => {
      throw new Error("Mail unavailable");
    };
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: "clear", status: "complete" }),
    );
    try {
      expect(
        (
          await fixture
            .app("owner", "owner")
            .request(`/${id}/checkr/refresh`, { method: "POST" })
        ).status,
      ).toBe(200);
      expect(
        fixture.database
          .query("SELECT status FROM employee_requirements WHERE id = ?")
          .get(id),
      ).toEqual({ status: "complete" });
      expect(fixture.emails).toHaveLength(0);
      fixture.bindings.EMAIL.send = send;
      // A failure retains a five-minute retry delay, avoiding a webhook storm.
      await sendPendingScreeningNotifications(fixture.bindings);
      expect(fixture.emails).toHaveLength(0);
      fixture.database.exec(
        "UPDATE employee_screening_notifications SET next_attempt_at = '2000-01-01'",
      );
      await refreshActiveCheckrScreenings(
        fixture.bindings,
        crypto.randomUUID(),
      );
      expect(fixture.emails).toHaveLength(1);
      await refreshActiveCheckrScreenings(
        fixture.bindings,
        crypto.randomUUID(),
      );
      expect(fixture.emails).toHaveLength(1);
    } finally {
      checkr.restore();
    }
  });

  it("claims delivery once and rechecks recipients after claiming", async () => {
    const fixture = await createFixture();
    const id = await orderedScreening(fixture);
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
      )
      .run(id);
    await Promise.all([
      sendPendingScreeningNotifications(fixture.bindings),
      sendPendingScreeningNotifications(fixture.bindings),
    ]);
    expect(fixture.emails).toHaveLength(1);
    const second = await orderedScreening(fixture, "report-2");
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
      )
      .run(second);
    fixture.hooks.before(
      "notification.claim_token",
      () => {
        fixture.database.exec(
          "DELETE FROM member WHERE id = 'employee-member'",
        );
      },
      { method: "first" },
    );
    await sendPendingScreeningNotifications(fixture.bindings);
    expect(fixture.emails).toHaveLength(1);
  });

  it("backs off failed mail, reports failure, and rotates past a full failed batch", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 25; index += 1) {
      const id = await orderedScreening(fixture, `report-${index}`);
      fixture.database
        .query(
          "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
        )
        .run(id);
    }
    const send = fixture.bindings.EMAIL.send;
    fixture.bindings.EMAIL.send = async () => {
      throw new Error("Mail unavailable");
    };
    expect(
      await refreshActiveCheckrScreenings(
        fixture.bindings,
        crypto.randomUUID(),
      ),
    ).toEqual({
      refreshed: 0,
      skipped: false,
      notifications: {
        sent: 0,
        failed: 24,
        abandoned: 0,
        queueUnavailable: false,
      },
    });
    fixture.bindings.EMAIL.send = send;
    expect(
      await refreshActiveCheckrScreenings(
        withoutCheckrKey(fixture.bindings),
        crypto.randomUUID(),
      ),
    ).toEqual({
      refreshed: 0,
      skipped: true,
      notifications: {
        sent: 1,
        failed: 0,
        abandoned: 0,
        queueUnavailable: false,
      },
    });
    fixture.bindings.EMAIL.send = async () => {
      throw new Error("Mail unavailable");
    };
    fixture.database.exec(
      "UPDATE employee_screening_notifications SET next_attempt_at = '2000-01-01' WHERE sent_at IS NULL",
    );
    const before = Date.now();
    expect(await sendPendingScreeningNotifications(fixture.bindings)).toEqual({
      sent: 0,
      failed: 24,
      abandoned: 0,
      queueUnavailable: false,
    });
    const retried = fixture.database
      .query(
        "SELECT attempts, next_attempt_at FROM employee_screening_notifications WHERE sent_at IS NULL LIMIT 1",
      )
      .get() as { attempts: number; next_attempt_at: string };
    expect(retried.attempts).toBe(2);
    expect(Date.parse(retried.next_attempt_at)).toBeGreaterThanOrEqual(
      before + 10 * 60_000,
    );
  });

  it("does not send stale, canceled, reassigned, or deleted organization notifications", async () => {
    for (const change of [
      "UPDATE employee_requirements SET checkr_report_id = 'replacement', checkr_report_status = 'pending', status = 'in_progress'",
      "UPDATE employee_requirements SET checkr_report_status = 'canceled'",
      "UPDATE employee_requirements SET checkr_refresh_requested_at = '2026-10-22T15:00:00Z'",
      "UPDATE employee_requirements SET member_id = (SELECT id FROM member WHERE userId = 'owner')",
      "UPDATE organization SET deletedAt = '2026-01-01'",
    ]) {
      const fixture = await createFixture();
      const id = await orderedScreening(fixture);
      fixture.database
        .query(
          "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
        )
        .run(id);
      fixture.database.exec(change);
      await sendPendingScreeningNotifications(fixture.bindings);
      expect(fixture.emails).toHaveLength(0);
    }
  });

  it("does not backfill notifications for reports completed before deployment", async () => {
    const fixture = await createFixture({ before: "0068" });
    const id = await orderedScreening(fixture);
    fixture.database
      .query(
        "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
      )
      .run(id);
    applyMigrations(fixture.database, { from: "0068" });
    const checkr = mockCheckr(() =>
      Response.json({ id: "report-1", result: "clear", status: "complete" }),
    );
    try {
      await fixture
        .app("owner", "owner")
        .request(`/${id}/checkr/refresh`, { method: "POST" });
      expect(fixture.emails).toHaveLength(0);
    } finally {
      checkr.restore();
    }
  });

  it("abandons expired mail and stops after the tenth delivery attempt", async () => {
    for (const expired of [true, false]) {
      const fixture = await createFixture();
      const id = await orderedScreening(fixture);
      fixture.database
        .query(
          "UPDATE employee_requirements SET status = 'complete', checkr_report_status = 'complete' WHERE id = ?",
        )
        .run(id);
      fixture.database.exec(
        expired
          ? "UPDATE employee_screening_notifications SET created_at = '2000-01-01'"
          : "UPDATE employee_screening_notifications SET attempts = 9",
      );
      let attempts = 0;
      fixture.bindings.EMAIL.send = async () => {
        attempts += 1;
        throw new Error("Address undeliverable");
      };
      const first = await sendPendingScreeningNotifications(fixture.bindings);
      expect(first.failed).toBe(expired ? 0 : 1);
      fixture.database.exec(
        "UPDATE employee_screening_notifications SET next_attempt_at = '2000-01-01'",
      );
      await sendPendingScreeningNotifications(fixture.bindings);
      expect(attempts).toBe(expired ? 0 : 1);
      expect(
        fixture.database
          .query("SELECT abandoned_at FROM employee_screening_notifications")
          .get(),
      ).toEqual({ abandoned_at: expect.any(String) });
    }
  });

  it("reports queue access failures separately from attempted email failures", async () => {
    const fixture = await createFixture();
    fixture.beforeRun("SET abandoned_at", () => {
      throw new Error("Queue unavailable");
    });
    expect(await sendPendingScreeningNotifications(fixture.bindings)).toEqual({
      sent: 0,
      failed: 0,
      abandoned: 0,
      queueUnavailable: true,
    });
  });

  it("escapes names and titles in screening email HTML", async () => {
    const fixture = await createFixture();
    fixture.database.exec(
      `UPDATE organization SET name = '<Acme & Co>' WHERE id = 'org_owner'`,
    );
    const id = await requestedScreening(fixture);
    const mail = fixture.emails[0];
    expect(mail?.html).toContain("&lt;Acme &amp; Co&gt;");
    expect(mail?.html).not.toContain("<Acme & Co>");
    expect(mail?.text).toContain("<Acme & Co>");
    expect(mail?.html).toContain(`/me/screening/${id}?organization=${orgId}`);
  });
});
