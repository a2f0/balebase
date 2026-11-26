import { describe, expect, it } from "bun:test";
import { errorNotice, UpgradeRequiredError } from "./errors";

describe("error notices", () => {
  it("marks only upgrade errors as resolvable on Billing", () => {
    expect(
      errorNotice(new UpgradeRequiredError("Upgrade to Pro."), "Failed."),
    ).toEqual({ message: "Upgrade to Pro.", upgrade: true });
    expect(errorNotice(new TypeError("Failed to fetch"), "Failed.")).toEqual({
      message: "Could not connect. Check your connection and try again.",
      upgrade: false,
    });
    expect(errorNotice(undefined, "Failed.")).toEqual({
      message: "Failed.",
      upgrade: false,
    });
  });
});
