import { expect, it } from "bun:test";
import {
  createActivityAudit,
  createFixture,
  type IssueResponse,
  imageActivation,
  imageUpload,
  jsonRequest,
  pngBytes,
} from "../testing/auditFixture";

it("replays offline image uploads after lost responses and removal without duplicate storage or history", async () => {
  const f = createFixture();
  const issueId = crypto.randomUUID();
  const scope = { userId: "user-1", organizationId: "org_user-1" };
  const created = await jsonRequest(f, "/offline/operations", "POST", {
    ...scope,
    operation: {
      id: issueId,
      type: "issue",
      title: "Offline gate",
      description: "",
      priority: "medium",
      assignedTo: null,
    },
  });
  expect(created.status).toBe(201);
  const imageId = crypto.randomUUID();
  const path = `/offline/issues/${issueId}/images/${imageId}?userId=user-1&organizationId=org_user-1&filename=gate.png`;
  const upload = () =>
    f.request(path, { ...imageUpload(pngBytes()), method: "PUT" });
  f.hooks.after(imageActivation, () => {
    throw new Error("D1 activation response was lost after commit");
  });
  const first = await upload();
  expect(first.status).toBe(201);
  const body = await first.json();
  const second = await upload();
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual(body);
  expect(f.stored.size).toBe(1);
  expect(
    f.database
      .query(
        "SELECT action FROM activity_events WHERE action = 'audit.image_uploaded'",
      )
      .all(),
  ).toHaveLength(1);
  const list = await f.request(`/offline/issues/${issueId}/images`, {});
  expect(((await list.json()) as { images: unknown[] }).images).toHaveLength(1);
  const wrongScope = await f.request(
    path.replace("userId=user-1", "userId=user-2"),
    { ...imageUpload(pngBytes()), method: "PUT" },
  );
  expect(wrongScope.status).toBe(403);
  const removed = await f.request(`/issues/${issueId}/images/${imageId}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(204);
  expect((await upload()).status).toBe(200);
  expect(f.database.query("SELECT id FROM audit_issue_images").all()).toEqual(
    [],
  );
  expect(f.stored.size).toBe(0);
  f.database.close();
});

it("acknowledges an uploaded offline image after its audit and issue are purged", async () => {
  const fixture = createFixture();
  const { auditId } = await createActivityAudit(fixture);
  const issue = await jsonRequest<IssueResponse>(
    fixture,
    `/runs/${auditId}/issues`,
    "POST",
    { title: "Rail", itemId: "check" },
  );
  expect(issue.status).toBe(201);
  const imageId = crypto.randomUUID();
  const path = `/offline/issues/${issue.body.issueId}/images/${imageId}?userId=user-1&organizationId=org_user-1&filename=rail.png`;
  const upload = () =>
    fixture.request(path, { ...imageUpload(pngBytes()), method: "PUT" });
  const first = await upload();
  expect(first.status).toBe(201);
  const image = await first.json();
  fixture.database.query("DELETE FROM audits WHERE id = ?").run(auditId);
  expect(
    fixture.database
      .query("SELECT id FROM issues WHERE id = ?")
      .get(issue.body.issueId),
  ).toBeNull();
  const replay = await upload();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(image);
  expect(
    fixture.database.query("SELECT id FROM audit_issue_images").all(),
  ).toEqual([]);
  expect(fixture.stored.size).toBe(1); // The existing tombstone cleanup owns deletion; no new upload occurred.
  fixture.database.close();
});
