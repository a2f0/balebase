import { describe, expect, it } from "bun:test";
import { selectEmailId } from "./inboxSelection";

const listed = [{ id: "newest" }, { id: "older" }];

describe("selectEmailId", () => {
  it("keeps a linked message selected across refreshes", () => {
    expect(selectEmailId(listed, "archived", undefined, "archived")).toBe(
      "archived",
    );
  });

  it("keeps a listed selection and replaces one that disappeared", () => {
    expect(selectEmailId(listed, "older", undefined, undefined)).toBe("older");
    expect(selectEmailId(listed, "trashed", undefined, undefined)).toBe(
      "newest",
    );
    expect(selectEmailId([], undefined, undefined, undefined)).toBeUndefined();
  });
});
