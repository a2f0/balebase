import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { IntersectionObserverFixture } from "../testing/intersectionObserver";
import { AdminMaintenanceRequests } from "./AdminMaintenanceRequests";

const { mount, respond } = installDom({
  url: "http://localhost:5173/root/jobs",
  globals: () => ({ IntersectionObserver: IntersectionObserverFixture }),
});

afterEach(() => {
  IntersectionObserverFixture.instances.length = 0;
});

const request = (id: string, joinedActiveRun: boolean, name: string) => ({
  actor: { email: `${id}@example.com`, id, name },
  id,
  jobId: "purgeRequestedUsers",
  joinedActiveRun,
  requestedAt: "2026-10-26T12:00:00.000Z",
  runId: "run-1",
});

it("lists who requested each manual maintenance run, page by page", async () => {
  const requests: string[] = [];
  respond(async (url) => {
    requests.push(`${url.pathname}${url.search}`);
    return Response.json(
      url.searchParams.get("cursor")
        ? { nextCursor: null, requests: [request("third", false, "Third")] }
        : {
            nextCursor: "next",
            requests: [
              request("second", true, "Second Admin"),
              request("first", false, "First Admin"),
            ],
          },
    );
  });
  const { container } = await mount(
    <AdminMaintenanceRequests
      jobs={[
        {
          description: "",
          id: "purgeRequestedUsers",
          manual: true,
          name: "Purge requested users",
          runSchedule: "",
        },
      ]}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const rows = () =>
    [...container.querySelectorAll(".rowList .row")].map(
      (row) => row.textContent ?? "",
    );
  expect(rows()).toHaveLength(2);
  expect(rows()[0]).toContain("Purge requested users");
  expect(rows()[0]).toContain("Second Admin");
  expect(rows()[0]).toContain("Joined a run in progress");
  expect(rows()[1]).toContain("First Admin");
  expect(rows()[1]).not.toContain("Joined a run in progress");
  await act(async () => IntersectionObserverFixture.intersect());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rows()).toHaveLength(3);
  expect(requests).toEqual([
    "/api/admin/jobs/requests",
    "/api/admin/jobs/requests?cursor=next",
  ]);
});
