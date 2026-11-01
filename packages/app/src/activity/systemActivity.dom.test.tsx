import { describe, expect, it } from "bun:test";
import type {
  ActivityActor,
  ActivityEvent,
} from "@balebase/validators/activity";
import { installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { ActivityFeed } from "./ActivityFeed";

const { mount, respond, settle } = installDom({
  url: "http://localhost:5173/activity",
  globals: () => ({ IntersectionObserver: IntersectionObserverFixture }),
});

const maintenance: ActivityActor = {
  apiKey: null,
  email: "",
  id: null,
  name: "Balebase maintenance",
  source: "purgeExpiredFreeAuditRuns",
  type: "system",
};

function activity(
  id: number,
  action: string,
  root: ActivityEvent["root"],
  details: ActivityEvent["details"],
  actor: ActivityActor = maintenance,
): ActivityEvent {
  return {
    action,
    actor,
    details,
    historical: false,
    id,
    occurredAt: "2026-10-02T12:00:00.000Z",
    root,
    subject: { id: root.id, type: root.type },
  };
}

function rowsOf(container: Element) {
  return [...container.querySelectorAll(".activityRow")].map(
    (row) => row.textContent ?? "",
  );
}

describe("system and provider activity", () => {
  it("names maintenance and providers without inventing a person", async () => {
    respond(async () =>
      Response.json({
        events: [
          activity(
            4,
            "organization.audit_runs_purged",
            { id: "org", label: "Acme", type: "organization" },
            { completedBefore: "2026-07-27", count: 3, retentionDays: 30 },
          ),
          activity(
            3,
            "project.form_disabled",
            { id: "project", label: "Site A", type: "project" },
            { reason: "form_purged", templateId: "form", title: "Safety" },
          ),
          activity(
            2,
            "inbox.email_purged",
            { id: "email", label: "Invoice", type: "inbound_email" },
            { attachmentCount: 1, equipmentLinkCount: 0, folderLinkCount: 2 },
          ),
          activity(
            1,
            "billing.subscription_changed",
            { id: "org", label: "Acme", type: "organization_billing" },
            {},
            {
              ...maintenance,
              name: "Stripe",
              source: "stripe",
              type: "provider",
            },
          ),
        ],
        nextCursor: null,
      }),
    );
    const { container } = await mount(<ActivityFeed onNavigate={() => {}} />);
    await settle();
    const rows = rowsOf(container);
    expect(rows[0]).toContain(
      "Balebase maintenance removed audits past Free-plan retention",
    );
    expect(rows[0]).toContain("Automatic maintenance");
    expect(rows[0]).toContain("3 completed audits from before");
    expect(rows[1]).toContain("Balebase maintenance turned off an audit form");
    expect(rows[1]).toContain("Safety · The discarded global form was purged");
    expect(rows[1]).toContain("Open project");
    expect(rows[2]).toContain(
      "Balebase maintenance permanently deleted an email from Trash",
    );
    expect(rows[2]).toContain(
      "1 attachment · 2 folder links · 0 equipment links",
    );
    expect(rows[3]).toContain("Stripe");
    expect(rows[3]).toContain("Provider update");
    // The purged email has no page to open.
    expect(rows[2]).not.toContain("Open");
  });

  it("reads the purge history for root admins", async () => {
    const requests: string[] = [];
    respond(async (url) => {
      requests.push(url.pathname);
      return Response.json({
        events: [
          activity(
            2,
            "user.purged",
            { id: "user-9", label: "user-9", type: "user" },
            {
              requestedAt: "2026-08-02",
              requestedBy: "admin",
              requestedByEmail: "admin@example.com",
              requestedByName: "Root Admin",
              via: "root_admin",
            },
            { ...maintenance, source: "purgeRequestedUsers" },
          ),
          activity(
            1,
            "organization.purged",
            { id: "org-9", label: "org-9", type: "organization" },
            {
              deletedAt: "2026-08-01",
              deletedBy: "owner",
              deletedByName: "Olive Owner",
              via: "owner",
            },
            { ...maintenance, source: "purgeDeletedOrganizations" },
          ),
        ],
        nextCursor: null,
      });
    });
    const { container } = await mount(
      <ActivityFeed
        source={{ id: "platform", type: "admin_purges" }}
        title="Purge history"
      />,
    );
    await settle();
    expect(requests).toEqual(["/api/admin/jobs/purges"]);
    expect(container.textContent).toContain("Purge history");
    const rows = rowsOf(container);
    expect(rows[0]).toContain(
      "Balebase maintenance permanently deleted an account",
    );
    expect(rows[0]).toContain("Requested by Root Admin (root admin) on");
    expect(rows[1]).toContain(
      "Balebase maintenance permanently deleted an organization",
    );
    expect(rows[1]).toContain("Deleted by Olive Owner (owner) on");
  });
});
