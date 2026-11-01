import { describe, expect, it } from "bun:test";
import type { ActivityEvent } from "@balebase/validators/activity";
import { installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { Activity } from "./Activity";
import { ActivityFeed } from "./ActivityFeed";

const { mount, respond, settle } = installDom({
  url: "http://localhost:5173/activity",
  globals: () => ({ IntersectionObserver: IntersectionObserverFixture }),
});

const sam = { email: "sam@example.com", id: "sam-user", name: "Sam" };

function activity(
  id: number,
  action: string,
  root: ActivityEvent["root"],
  details: ActivityEvent["details"],
): ActivityEvent {
  return {
    action,
    actor: sam,
    details,
    historical: false,
    id,
    occurredAt: "2026-10-02T12:00:00.000Z",
    root,
    subject: { id: root.id, type: root.type },
  };
}

const bobMember = {
  id: "bob-member",
  label: "Bob",
  type: "organization_member",
};

function events(): ActivityEvent[] {
  return [
    activity(
      8,
      "equipment.assigned",
      { id: "laptop", label: "Apple MacBook", type: "equipment" },
      {
        after: null,
        afterEmail: null,
        afterName: null,
        before: "bob-user",
        beforeEmail: "bob@example.com",
        beforeName: "Bob",
        reason: "member_removed",
      },
    ),
    activity(
      7,
      "organization.group_updated",
      { id: "finance", label: "Finance", type: "organization_group" },
      {
        addedCapabilities: [],
        addedMembers: [],
        capabilities: ["finance"],
        name: "Finance",
        reason: "member_removed",
        removedCapabilities: [],
        removedMembers: [{ email: "bob@example.com", name: "Bob" }],
      },
    ),
    activity(6, "organization.member_removed", bobMember, {
      apiKeys: [{ id: "key-1", name: "Reporting" }],
      role: "member",
      userEmail: "bob@example.com",
      userName: "Bob",
    }),
    activity(5, "organization.member_joined", bobMember, {
      inviterName: "Alice",
      role: "admin",
      userName: "Bob",
    }),
    activity(
      4,
      "organization.invitation_canceled",
      {
        id: "invite-1",
        label: "dana@example.com",
        type: "organization_invitation",
      },
      {
        after: "canceled",
        before: "pending",
        email: "dana@example.com",
        role: "admin",
      },
    ),
    activity(
      3,
      "organization.updated",
      { id: "org-1", label: "Renamed", type: "organization" },
      {
        changes: [
          { after: "Renamed", before: "Original", field: "name" },
          { after: "renamed", before: "original", field: "slug" },
        ],
      },
    ),
    activity(
      2,
      "organization.restored",
      { id: "org-1", label: "Renamed", type: "organization" },
      { deletedByName: "Alice", via: "root_admin" },
    ),
    activity(
      1,
      "organization.deletion_requested",
      { id: "org-1", label: "Renamed", type: "organization" },
      { canceledInvitations: 1, via: "owner" },
    ),
  ];
}

describe("organization membership activity", () => {
  it("shows joins, removals, invitations and organization changes", async () => {
    respond(async () => Response.json({ events: events(), nextCursor: null }));
    const navigations: string[] = [];
    const { container } = await mount(
      <ActivityFeed onNavigate={(path) => navigations.push(path)} />,
    );
    await settle();
    const rows = [...container.querySelectorAll(".activityRow")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("Sam changed the equipment assignee");
    expect(rows[0]).toContain(
      "Bob → Unassigned · Removed from the organization",
    );
    expect(rows[1]).toContain(
      "Removed: Bob · Removed from the organization · Access lost: Finance",
    );
    expect(rows[2]).toContain("Sam removed a member");
    expect(rows[2]).toContain("Bob · Member · API keys stopped: Reporting");
    // A removed member has no page to open.
    expect(rows[2]).not.toContain("Open member");
    expect(rows[3]).toContain("Sam joined the organization");
    expect(rows[3]).toContain("Bob · Admin · Invited by Alice");
    expect(rows[3]).toContain("Open member");
    expect(rows[4]).toContain("Sam canceled an invitation");
    expect(rows[4]).toContain("dana@example.com · Admin");
    expect(rows[5]).toContain("Sam changed the organization");
    expect(rows[5]).toContain(
      "Name: Original → Renamed · URL name: original → renamed",
    );
    expect(rows[6]).toContain("Sam restored the organization");
    expect(rows[6]).toContain("By a root admin · Deleted by Alice");
    expect(rows[7]).toContain("Sam deleted the organization");
    expect(rows[7]).toContain("By an owner · Pending invitations canceled: 1");
  });

  it("offers the Invitations filter only to organization managers", async () => {
    respond(async () => Response.json({ events: [], nextCursor: null }));
    const view = await mount(<Activity canManage onNavigate={() => {}} />);
    await settle();
    const options = () =>
      [...view.container.querySelectorAll("option")].map(
        (option) => option.textContent,
      );
    expect(options()).toContain("Invitations");
    expect(options()).toContain("Organization");
    await view.render(<Activity onNavigate={() => {}} />);
    await settle();
    expect(options()).not.toContain("Invitations");
    expect(options()).toContain("Organization");
  });
});
