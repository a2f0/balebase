import { expect, it } from "bun:test";
import { adminUsers } from "./adminUsers";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { seedUser } from "./testing/seed";
import { testApp } from "./testing/session";

function fixture() {
  const database = createTestDatabase();
  seedUser(database, { id: "admin-1", role: "admin" });
  seedUser(database, { email: "person@example.com", id: "person-1" });
  const send = requester(
    testApp({ "/": adminUsers }, { role: "admin", userId: "admin-1" }),
    testBindings({ DB: toD1(database) }),
    { headers: { Origin: "https://app.test" } },
  );
  return { database, send };
}

it("refuses a deletion request without the user's email typed in", async () => {
  const { database, send } = fixture();
  for (const body of ["not json", {}, { confirm: "someone@example.com" }]) {
    expect(await send("POST", "/person-1/deletion", body)).toMatchObject({
      body: {
        error: "Confirm the user's email to mark this account for deletion.",
      },
      status: 400,
    });
  }
  expect(
    database
      .query("SELECT COUNT(*) AS count FROM user_deletion_requests")
      .get(),
  ).toEqual({ count: 0 });
});

it("refuses pagination outside the contract", async () => {
  const { send } = fixture();
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=many"]) {
    expect(await send("GET", `/?${query}`)).toMatchObject({
      body: { error: "Invalid user pagination." },
      status: 400,
    });
  }
  expect(await send("GET", "/?limit=1")).toMatchObject({
    body: { total: 2 },
    status: 200,
  });
});
