import { describe, expect, it } from "bun:test";
import { libraryFixture } from "../testing/libraryFixture";

interface Page {
  events: Array<{ action: string; root: { label: string; type: string } }>;
}

const acme = {
  city: "Austin",
  duns: "123456789",
  ein: "987654321",
  incorporationDate: "2020-01-02",
  name: "Acme",
  state: "TX",
  streetAddress: "1 Main St",
  zip: "78701",
};

async function createAcme(fixture: ReturnType<typeof libraryFixture>) {
  const created = await fixture.as("owner-user")<{ business: { id: string } }>(
    "POST",
    "/api/businesses",
    acme,
  );
  expect(created.status).toBe(201);
  return created.body.business.id;
}

describe("business activity", () => {
  it("records creation, edits, and deletion without full identifiers", async () => {
    const fixture = libraryFixture();
    const owner = fixture.as("owner-user");
    const id = await createAcme(fixture);
    const path = `/api/businesses/${id}`;

    expect(fixture.events("root_type = 'business'")).toEqual([
      {
        action: "business.created",
        actor_api_key_channel: null,
        actor_api_key_name: null,
        actor_user_id: "owner-user",
        details: {
          city: "Austin",
          duns: "•••6789",
          ein: "•••4321",
          incorporationDate: "2020-01-02",
          name: "Acme",
          state: "TX",
          streetAddress: "1 Main St",
          zip: "78701",
        },
        root_id: id,
        root_label: "Acme",
        root_type: "business",
        subject_id: id,
        subject_type: "business",
      },
    ]);

    // An unchanged save writes and records nothing.
    const unchanged = await owner<{ business: { updatedAt: string } }>(
      "PATCH",
      path,
      { ...acme },
    );
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.business.updatedAt).toBe(
      (
        fixture.database
          .query("SELECT updated_at FROM businesses WHERE id = ?")
          .get(id) as { updated_at: string }
      ).updated_at,
    );

    fixture.useApiKey("mcp");
    const updated = await owner("PATCH", path, {
      city: null,
      ein: "111114321",
      name: "Acme Holdings",
    });
    expect(updated.status).toBe(200);
    fixture.state.apiKey = undefined;
    expect(fixture.events("action = 'business.updated'")).toEqual([
      expect.objectContaining({
        actor_api_key_channel: "mcp",
        actor_api_key_name: "Automation",
        actor_user_id: "owner-user",
        details: {
          changes: [
            { after: "Acme Holdings", before: "Acme", field: "name" },
            { after: "•••4321", before: "•••4321", field: "ein" },
            { after: null, before: "Austin", field: "city" },
          ],
        },
        root_label: "Acme Holdings",
      }),
    ]);

    const history = await fixture.as("member-user")<Page>(
      "GET",
      `${path}/activity`,
    );
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "business.updated",
      "business.created",
    ]);
    expect(
      (await fixture.as("other-user")("GET", `${path}/activity`)).status,
    ).toBe(404);

    expect((await owner("DELETE", path)).status).toBe(204);
    expect((await owner("DELETE", path)).status).toBe(404);
    expect(fixture.events("action = 'business.deleted'")).toMatchObject([
      {
        actor_user_id: "owner-user",
        details: {
          city: null,
          duns: "•••6789",
          ein: "•••4321",
          name: "Acme Holdings",
        },
        root_label: "Acme Holdings",
      },
    ]);

    // The history outlives the business, for members of its organization.
    const feed = await fixture.as("member-user")<Page>(
      "GET",
      "/api/activity?resourceType=business",
    );
    expect(feed.body.events.map(({ action }) => action)).toEqual([
      "business.deleted",
      "business.updated",
      "business.created",
    ]);
    expect(
      (
        await fixture.as("other-user")<Page>(
          "GET",
          "/api/activity?resourceType=business",
        )
      ).body.events,
    ).toEqual([]);
    const stored = JSON.stringify(fixture.events());
    for (const identifier of ["123456789", "987654321", "111114321"])
      expect(stored).not.toContain(identifier);
  });

  it("records nothing for refused or stale saves", async () => {
    const fixture = libraryFixture();
    const owner = fixture.as("owner-user");
    const id = await createAcme(fixture);
    const path = `/api/businesses/${id}`;
    const other = await owner<{ business: { id: string } }>(
      "POST",
      "/api/businesses",
      { ein: "222222222", name: "Other" },
    );
    const before = fixture.events().length;

    expect(
      (await owner("POST", "/api/businesses", { ein: acme.ein, name: "Dup" }))
        .status,
    ).toBe(409);
    expect(
      (await owner("PATCH", path, { ein: "222222222", name: "Acme" })).status,
    ).toBe(409);
    expect(
      (await owner("PATCH", path, { duns: null, ein: null, name: "Acme" }))
        .status,
    ).toBe(200);
    expect(
      (
        await owner("PATCH", `/api/businesses/${other.body.business.id}`, {
          duns: acme.duns,
          name: "Other",
        })
      ).status,
    ).toBe(200);
    const after = fixture.events().length;
    expect(after).toBe(before + 2);

    const member = fixture.as("member-user");
    expect((await member("PATCH", path, { name: "Mine" })).status).toBe(403);
    expect((await member("DELETE", path)).status).toBe(403);
    expect(
      (await owner("PATCH", "/api/businesses/missing", { name: "X" })).status,
    ).toBe(404);
    expect((await owner("DELETE", "/api/businesses/missing")).status).toBe(404);
    expect(
      (await fixture.as("other-user")("PATCH", path, { name: "X" })).status,
    ).toBe(404);

    // Another manager's change lands between this save's read and write.
    fixture.hooks.before("UPDATE OR IGNORE businesses", () => {
      fixture.database
        .query("UPDATE businesses SET city = 'Dallas' WHERE id = ?")
        .run(id);
    });
    expect(await owner("PATCH", path, { name: "Acme Renamed" })).toMatchObject({
      status: 409,
    });
    expect(fixture.events().length).toBe(after);
    expect(
      fixture.database
        .query("SELECT name, city FROM businesses WHERE id = ?")
        .get(id),
    ).toEqual({ city: "Dallas", name: "Acme" });
  });

  it("rolls the change back when its event cannot be recorded", async () => {
    const fixture = libraryFixture();
    const owner = fixture.as("owner-user");
    const id = await createAcme(fixture);
    fixture.failActivity();

    expect(
      (await owner("POST", "/api/businesses", { name: "Beta" })).status,
    ).toBe(500);
    expect(
      (await owner("PATCH", `/api/businesses/${id}`, { name: "Renamed" }))
        .status,
    ).toBe(500);
    expect((await owner("DELETE", `/api/businesses/${id}`)).status).toBe(500);
    expect(fixture.database.query("SELECT name FROM businesses").all()).toEqual(
      [{ name: "Acme" }],
    );
  });
});
