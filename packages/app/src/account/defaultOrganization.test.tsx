import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installFetch } from "../testing/fetch";
import { AccountSettings } from "./AccountSettings";
import { saveDefaultOrganizationPreference } from "./defaultOrganization";

const respond = installFetch();

describe("account settings", () => {
  it("saves the selected organization before refreshing the session", async () => {
    const events: string[] = [];
    const fetch = mock(async (_url: URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        organizationId: "org-two",
      });
      events.push("saved");
      return new Response(JSON.stringify({ defaultOrganizationId: "org-two" }));
    });
    respond(fetch);

    await saveDefaultOrganizationPreference("org-two", async () => {
      events.push("refreshed");
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["saved", "refreshed"]);
  });

  it("surfaces save errors without refreshing the session", async () => {
    respond(async () =>
      Response.json({ error: "Organization is unavailable." }, { status: 403 }),
    );
    const refresh = mock(async () => undefined);

    await expect(
      saveDefaultOrganizationPreference("org-two", refresh),
    ).rejects.toThrow("Organization is unavailable.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disables the selector and save button when no organizations exist", () => {
    const markup = renderToStaticMarkup(
      <AccountSettings
        defaultOrganizationId={null}
        onNavigate={() => undefined}
        onSessionChanged={async () => undefined}
        organizations={[]}
        pathname="/account"
        twoFactorEnabled={false}
      />,
    );

    expect(markup).toContain("No organizations available</option>");
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Save changes<\/button>/,
    );
  });
});
