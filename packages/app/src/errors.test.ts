import { describe, expect, it } from "bun:test";
import { ApiError } from "@balebase/api-client";
import { errorMessage, errorNotice, UpgradeRequiredError } from "./errors";

describe("error messages", () => {
  it("shows the API's message and falls back for non-errors", () => {
    const refused = new ApiError(new Response(null, { status: 409 }), {
      error: "Name already used.",
    });
    expect(errorMessage(refused, "Could not save.")).toBe("Name already used.");
    expect(errorMessage("boom", "Could not save.")).toBe("Could not save.");
    expect(errorMessage(new Error(""), "Could not save.")).toBe(
      "Could not save.",
    );
  });

  it("replaces browser network failures with readable text", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "The network connection was lost.",
    ]) {
      expect(errorMessage(new TypeError(message), "Could not load.")).toBe(
        "Could not connect. Check your connection and try again.",
      );
    }
    // Other type errors are not connection problems.
    expect(
      errorMessage(new TypeError("x is undefined"), "Could not load."),
    ).toBe("x is undefined");
  });

  it("explains timed-out and cancelled requests", () => {
    expect(
      errorMessage(
        new DOMException("The operation timed out.", "TimeoutError"),
        "Could not load.",
      ),
    ).toBe("The request took too long. Try again.");
    expect(
      errorMessage(
        new DOMException("signal is aborted without reason", "AbortError"),
        "Could not load.",
      ),
    ).toBe("The request was cancelled.");
  });

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
