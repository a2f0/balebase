import { expect, it } from "bun:test";
import { installDom } from "../testing/dom";
import { AccountSecurityHistory } from "./AccountSecurityHistory";

const { mount, respond, settle } = installDom({
  url: "http://localhost:5173/account/security",
});

it("lists the person's security changes and refreshes in place when two-factor changes", async () => {
  const paths: string[] = [];
  let release: ((response: Response) => void) | undefined;
  const page = (events: { action: string; occurredAt: string }[]) =>
    Response.json({ events });
  respond(async ({ pathname }) => {
    paths.push(pathname);
    if (paths.length === 1)
      return page([
        { action: "password_changed", occurredAt: "2026-10-30T12:00:00.000Z" },
      ]);
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const view = await mount(<AccountSecurityHistory twoFactorEnabled={false} />);
  await settle();
  expect(paths).toEqual(["/api/account-settings/security-events"]);
  expect(view.container.textContent).toContain("Password changed");

  await view.render(<AccountSecurityHistory twoFactorEnabled />);
  await settle();
  expect(paths).toHaveLength(2);
  // The saved list stays on screen while the refresh is pending.
  expect(view.container.textContent).toContain("Password changed");
  expect(view.container.textContent).not.toContain("Loading");
  release?.(
    page([
      {
        action: "two_factor_enabled",
        occurredAt: "2026-10-31T12:00:00.000Z",
      },
      { action: "password_changed", occurredAt: "2026-10-30T12:00:00.000Z" },
    ]),
  );
  await settle();
  expect(view.container.textContent).toContain(
    "Two-factor authentication turned on",
  );
  // Re-rendering with the same setting does not reload.
  await view.render(<AccountSecurityHistory twoFactorEnabled />);
  await settle();
  expect(paths).toHaveLength(2);
});

it("says when nothing has been recorded", async () => {
  respond(async () => Response.json({ events: [] }));
  const view = await mount(<AccountSecurityHistory twoFactorEnabled />);
  await settle();
  expect(view.container.textContent).toContain("No changes recorded yet.");
});
