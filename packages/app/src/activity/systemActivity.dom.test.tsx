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

  it("names the signing workflow and Checkr on contracts and screenings", async () => {
    const contract = { id: "c1", label: "Lease", type: "contract" };
    const request = {
      id: "r1",
      label: "Background check · Bob",
      type: "employee_requirement",
    };
    const person = {
      kind: "background_check",
      personName: "Bob",
      title: "Background check",
    };
    const signing = { ...maintenance, name: "Balebase signing" };
    const checkr: ActivityActor = {
      ...maintenance,
      name: "Checkr",
      source: "checkr",
      type: "provider",
    };
    const bob: ActivityActor = {
      apiKey: null,
      email: "bob@example.com",
      id: "bob",
      name: "Bob",
      source: null,
      type: "user",
    };
    respond(async () =>
      Response.json({
        events: [
          activity(
            5,
            "contract.completed",
            contract,
            { signerCount: 2 },
            { ...signing, source: "contractSigning" },
          ),
          activity(
            4,
            "contract.declined",
            contract,
            { recipientId: "rcp", signedCount: 1, signerCount: 2 },
            { ...signing, source: "contractSigning" },
          ),
          activity(
            3,
            "employee_requirement.screening_updated",
            request,
            {
              ...person,
              hasResult: true,
              previousReportStatus: "pending",
              previousStatus: "in_progress",
              reportStatus: "complete",
              resultChanged: true,
              status: "complete",
              via: "webhook",
            },
            checkr,
          ),
          activity(
            2,
            "employee_requirement.screening_report_adopted",
            request,
            { ...person, adopted: true, reportStatus: "pending" },
            checkr,
          ),
          activity(
            1,
            "employee_requirement.screening_submitted",
            request,
            { ...person, adopted: false, reportStatus: "pending" },
            bob,
          ),
        ],
        nextCursor: null,
      }),
    );
    const { container } = await mount(<ActivityFeed onNavigate={() => {}} />);
    await settle();
    const rows = rowsOf(container);
    expect(rows[0]).toContain("Balebase signing completed a contract");
    expect(rows[0]).toContain("Signing link");
    expect(rows[0]).toContain("Every signer signed · 2 signers");
    expect(rows[1]).toContain("Balebase signing recorded a signer's decline");
    expect(rows[1]).toContain("A signer declined · 1 of 2 signers had signed");
    expect(rows[2]).toContain("Checkr updated a background check");
    expect(rows[2]).toContain(
      "Report Pending → Complete · In progress → Complete · Result updated · Checkr update",
    );
    expect(rows[3]).toContain("Checkr adopted a background check report");
    expect(rows[3]).toContain(
      "Adopted the report an unfinished submission ordered · Pending",
    );
    expect(rows[4]).toContain("Bob submitted a background check");
    expect(rows[4]).toContain(
      "Signed the authorization and ordered the report · Pending",
    );
    for (const row of rows) expect(row).not.toContain("maintenance");
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
    expect(rows[0]).toContain(
      "Account user-9 · Requested by Root Admin (root admin) on",
    );
    expect(rows[1]).toContain(
      "Balebase maintenance permanently deleted an organization",
    );
    expect(rows[1]).toContain(
      "Organization org-9 · Deleted by Olive Owner (owner) on",
    );
  });

  it("summarizes Stripe's and Plaid's changes", async () => {
    const provider = (source: string, name: string): ActivityActor => ({
      ...maintenance,
      name,
      source,
      type: "provider",
    });
    const stripe = provider("stripe", "Stripe");
    const plaid = provider("plaid", "Plaid");
    const billing = { id: "org", label: "Acme", type: "organization_billing" };
    const bank = {
      id: "bank",
      label: "First Bank",
      type: "finance_connection",
    };
    const subscription = {
      cancelAtPeriodEnd: false,
      periodEnd: "2026-11-01T00:00:00.000Z",
      priceId: "price_pro",
      seats: 2,
      status: "active",
      subscriptionId: "sub_1",
    };
    respond(async () =>
      Response.json({
        events: [
          activity(
            6,
            "billing.subscription_changed",
            billing,
            {
              after: {
                ...subscription,
                cancelAtPeriodEnd: true,
                priceId: "price_pro_2",
                seats: 3,
              },
              before: subscription,
              subscriptionId: "sub_1",
            },
            stripe,
          ),
          activity(
            5,
            "billing.subscription_changed",
            billing,
            {
              after: { ...subscription, status: "canceled" },
              before: subscription,
              reason: "replaced",
              subscriptionId: "sub_1",
            },
            stripe,
          ),
          activity(
            4,
            "billing.seats_changed",
            billing,
            { after: 3, before: 2, source: "membership" },
            stripe,
          ),
          activity(
            3,
            "finance.connection_status_changed",
            bank,
            {
              after: { errorCode: "ITEM_LOGIN_REQUIRED", status: "error" },
              before: { errorCode: null, status: "active" },
            },
            plaid,
          ),
          activity(
            2,
            "finance.transactions_removed",
            bank,
            { count: 2, transactionIds: ["t1", "t2"] },
            plaid,
          ),
          activity(
            1,
            "finance.records_carried_over",
            bank,
            {
              accountCount: 1,
              fromConnectionId: "old",
              fromInstitutionName: "First Bank",
              transactionCount: 40,
            },
            plaid,
          ),
        ],
        nextCursor: null,
      }),
    );
    const paths: string[] = [];
    const { container } = await mount(
      <ActivityFeed onNavigate={(path) => paths.push(path)} />,
    );
    await settle();
    const rows = rowsOf(container);
    expect(rows[0]).toContain("Stripe updated the Pro subscription");
    expect(rows[0]).toContain("Provider update");
    expect(rows[0]).toContain(
      "Plan changed · 2 → 3 seats · Cancels at period end",
    );
    expect(rows[1]).toContain("Active → Canceled · Replaced by a new Checkout");
    expect(rows[2]).toContain("Stripe changed the subscription's seats");
    expect(rows[2]).toContain("2 → 3 seats · After a membership change");
    expect(rows[3]).toContain("Plaid changed the bank connection's status");
    expect(rows[3]).toContain("Active → Error (ITEM_LOGIN_REQUIRED)");
    expect(rows[4]).toContain("Plaid removed transactions");
    expect(rows[4]).toContain("2 transactions withdrawn by the bank");
    expect(rows[5]).toContain("1 account and 40 transactions from First Bank");
    for (const row of rows) expect(row).not.toContain("@");
    expect(container.textContent).toContain("Open billing");
    expect(container.textContent).toContain("Open connection");
  });
});
