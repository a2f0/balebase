import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Audits } from "./Audits";
import { formatRole } from "./organizationPeopleState";

describe("audit routes", () => {
  it("renders a malformed record path instead of throwing", () => {
    for (const pathname of ["/audits/runs/%E0", "/audits/templates/%E0"]) {
      expect(() =>
        renderToStaticMarkup(
          <Audits onNavigate={() => undefined} pathname={pathname} />,
        ),
      ).not.toThrow();
    }
  });
});

describe("role labels", () => {
  it("formats each of several comma-separated roles", () => {
    expect(formatRole("member")).toBe("Member");
    expect(formatRole("admin,owner")).toBe("Admin, Owner");
    expect(formatRole(" admin , ,owner ")).toBe("Admin, Owner");
  });
});
