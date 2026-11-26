import { expect, it } from "bun:test";
import { Balebase } from "../../Balebase";

it("binds every member, so screens can pass them on as callbacks", () => {
  const { offline } = new Balebase({ apiBaseUrl: "https://api.test" });
  const { scopeKey } = offline;
  expect(scopeKey({ organizationId: "org", userId: "user" })).toBe(
    JSON.stringify(["https://api.test", "user", "org"]),
  );
  for (const [name, member] of Object.entries(offline)) {
    expect([name, typeof member]).toEqual([name, "function"]);
  }
  // A method on the prototype would lose `this` when passed on.
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(offline))).toEqual([
    "constructor",
  ]);
  expect(Object.keys(offline)).toContain("sync");
  expect(Object.keys(offline)).not.toContain("change");
});
