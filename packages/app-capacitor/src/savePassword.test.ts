import { describe, expect, it } from "bun:test";
import { nativePasswordSaver } from "./savePassword";

describe("native password saving", () => {
  it("saves the credentials for the hosted app's domain", async () => {
    const saved: unknown[] = [];
    const save = nativePasswordSaver("https://app-staging.balebase.com", {
      save: async (options) => {
        saved.push(options);
      },
    });
    await save("owner@example.com", "correct horse battery");
    expect(saved).toEqual([
      {
        domain: "app-staging.balebase.com",
        password: "correct horse battery",
        username: "owner@example.com",
      },
    ]);
  });
});
