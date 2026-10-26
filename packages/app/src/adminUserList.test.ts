import { describe, expect, it } from "bun:test";
import { adminUserListQuery } from "./adminUserList";

describe("admin user listing", () => {
  it("requests the selected page", () => {
    expect(adminUserListQuery(2)).toEqual({
      limit: 25,
      offset: 50,
    });
  });
});
