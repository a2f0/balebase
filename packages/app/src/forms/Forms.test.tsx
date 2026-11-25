import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Forms } from "./Forms";

describe("form routes", () => {
  it("renders a malformed record path instead of throwing", () => {
    for (const pathname of ["/forms/runs/%E0", "/forms/templates/%E0"]) {
      expect(() =>
        renderToStaticMarkup(
          <Forms canPublish onNavigate={() => undefined} pathname={pathname} />,
        ),
      ).not.toThrow();
    }
  });
});
