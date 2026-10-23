import { describe, expect, it } from "bun:test";
import { chooseNativeSavedSignIn, nativePasswordSaver } from "./savePassword";

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

describe("choosing a saved sign-in", () => {
  it("returns the selected email and password together", async () => {
    const credential = {
      username: "owner@example.com",
      password: "a saved password",
    };
    expect(
      await chooseNativeSavedSignIn({ choose: async () => ({ credential }) }),
    ).toEqual(credential);
  });

  it("returns no credential on cancellation", async () => {
    expect(
      await chooseNativeSavedSignIn({ choose: async () => ({}) }),
    ).toBeUndefined();
  });

  it("replaces native failures with safe, actionable guidance", async () => {
    await expect(
      chooseNativeSavedSignIn({
        choose: async () => {
          throw new Error("private native details");
        },
      }),
    ).rejects.toThrow(
      "Couldn’t open saved sign-ins. You can still enter your email and password.",
    );
  });
});
