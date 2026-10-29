import { expect, it } from "bun:test";
import { adminJobs } from "./adminJobs";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { testApp } from "./testing/session";

function fixture() {
  return requester(
    testApp({ "/": adminJobs }, { role: "admin" }),
    testBindings({ DB: toD1(createTestDatabase()) }),
    { headers: { Origin: "https://app.test" } },
  );
}

it("refuses a job run without the job's ID typed in", async () => {
  const send = fixture();
  for (const path of [
    "/purgeDeletedOrganizations/runs",
    "/purgeDeletedOrganizations/run",
  ]) {
    for (const body of ["not json", { confirm: 7 }, { confirm: "wrong" }]) {
      expect(await send("POST", path, body)).toMatchObject({
        body: { error: "Confirm the job ID to run this job." },
        status: 400,
      });
    }
  }
});

it("refuses history filters and log cursors outside the contract", async () => {
  const send = fixture();
  expect(await send("GET", "/runs?status=stuck")).toMatchObject({
    body: { error: "Invalid history filter." },
    status: 400,
  });
  expect(await send("GET", "/runs?status=failed")).toMatchObject({
    body: { nextCursor: null, runs: [] },
    status: 200,
  });
  expect(await send("GET", "/runs/run-1?before=latest")).toMatchObject({
    body: { error: "Invalid log cursor." },
    status: 400,
  });
});
