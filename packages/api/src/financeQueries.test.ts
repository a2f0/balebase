import { expect, it } from "bun:test";
import { finance } from "./finance";
import { testBindings } from "./testing/bindings";
import { toD1 } from "./testing/d1";
import { createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { seedAccount } from "./testing/seed";
import { testApp } from "./testing/session";

function fixture() {
  const database = createTestDatabase();
  const { organizationId, userId } = seedAccount(database, { id: "user-1" });
  return requester(
    testApp(
      { "/": finance },
      { organizationId, organizationRole: "owner", userId },
    ),
    testBindings({ DB: toD1(database) }),
  );
}

it("reports expenses only for a real, ordered date range", async () => {
  const send = fixture();
  for (const range of [
    "from=2026-02-30",
    "to=26-01-01",
    "from=2026-03-01&to=2026-02-01",
  ]) {
    expect(await send("GET", `/reports/expenses?${range}`)).toMatchObject({
      body: { error: "Use YYYY-MM-DD dates with from on or before to." },
      status: 400,
    });
  }
  for (const range of [
    "",
    "from=&to=2026-02-01",
    "from=2026-02-01&to=2026-02-01",
  ]) {
    expect((await send("GET", `/reports/expenses?${range}`)).status).toBe(200);
  }
});

it("limits transaction searches to 100 characters after trimming", async () => {
  const send = fixture();
  expect(await send("GET", `/transactions?q=${"a".repeat(101)}`)).toMatchObject(
    {
      body: { error: "Searches need 100 characters or fewer." },
      status: 400,
    },
  );
  const padded = encodeURIComponent(` ${"a".repeat(100)} `);
  expect(await send("GET", `/transactions?q=${padded}`)).toMatchObject({
    body: { transactions: [] },
    status: 200,
  });
});
