import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import { AccountSecurity } from "./AccountSecurity";
import { useDismissDialogsOnWorkspaceChange } from "./navigationGuard";
import { installDom } from "./testing/dom";

// Mounts the real security page with the app's dialog host, so the
// confirmations guard the actual MFA requests.
const { click, fill, mount, queryButton, respond, settle } = installDom({
  url: "http://localhost:5173/account/security",
});
let container: HTMLElement;

interface AuthRequest {
  body: unknown;
  path: string;
}

/** Answers the two MFA maintenance endpoints and records every request. */
function stubAuth() {
  const requests: AuthRequest[] = [];
  respond(async ({ pathname: path }, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ body, path });
    if (path.endsWith("/two-factor/generate-backup-codes")) {
      return Response.json({
        backupCodes: ["aaaa-bbbb", "cccc-dddd"],
        status: true,
      });
    }
    return Response.json({ status: true });
  });
  return requests;
}

/** Stands in for the app: the signed-in account and its organization. */
function Workspace({ identity }: { identity: string }) {
  const [userId = "", organizationId = ""] = identity.split(":");
  useDismissDialogsOnWorkspaceChange(
    { session: { activeOrganizationId: organizationId }, user: { id: userId } },
    organizationId,
  );
  return null;
}

async function mountPage(onSecurityChanged: () => Promise<unknown>) {
  const page = (identity: string) => (
    <>
      <AccountSecurity onSecurityChanged={onSecurityChanged} twoFactorEnabled />
      <Workspace identity={identity} />
      <DialogHost />
    </>
  );
  const view = await mount(page("user-1:org-1"));
  container = view.container;
  return { render: (identity: string) => view.render(page(identity)) };
}

const card = (title: string) =>
  [...container.querySelectorAll("form")].find((form) =>
    form.textContent?.startsWith(title),
  );
const openDialog = () => document.querySelector("dialog[open]");

/** Fills a card's current-password field and submits the card. */
async function submit(title: string, submitLabel: string) {
  await fill(
    card(title)?.querySelector<HTMLInputElement>('input[type="password"]'),
    "correct horse battery",
  );
  await click(queryButton(submitLabel, card(title)));
}

describe("recovery code regeneration", () => {
  it("asks first, sends nothing when cancelled, and regenerates once confirmed", async () => {
    const requests = stubAuth();
    await mountPage(async () => {});

    await submit("Recovery codes", "Generate new codes");
    expect(openDialog()?.textContent).toContain("Generate new recovery codes?");
    await click(queryButton("Cancel", openDialog()));
    expect(requests).toEqual([]);
    expect(container.textContent).not.toContain("aaaa-bbbb");

    await submit("Recovery codes", "Generate new codes");
    await click(queryButton("Generate new codes", openDialog()));
    expect(requests).toEqual([
      {
        body: { password: "correct horse battery" },
        path: "/api/auth/two-factor/generate-backup-codes",
      },
    ]);
    expect(container.textContent).toContain("aaaa-bbbb");
    expect(container.textContent).toContain("New recovery codes generated.");
  });
});

describe("disabling MFA", () => {
  it("asks first, sends nothing when cancelled, and disables once confirmed", async () => {
    const requests = stubAuth();
    let refreshed = 0;
    await mountPage(async () => {
      refreshed += 1;
    });

    await submit("Disable MFA", "Disable MFA");
    expect(openDialog()?.textContent).toContain("Disable MFA?");
    await click(queryButton("Cancel", openDialog()));
    expect(requests).toEqual([]);
    expect(refreshed).toBe(0);

    await submit("Disable MFA", "Disable MFA");
    await click(queryButton("Disable MFA", openDialog()));
    expect(requests).toEqual([
      {
        body: { password: "correct horse battery" },
        path: "/api/auth/two-factor/disable",
      },
    ]);
    expect(refreshed).toBe(1);
    expect(container.textContent).toContain("MFA disabled.");
  });
});

describe("a workspace change while a security question is open", () => {
  it("answers no, so neither request runs for the account now signed in", async () => {
    const requests = stubAuth();
    const { render } = await mountPage(async () => {});

    await submit("Disable MFA", "Disable MFA");
    expect(openDialog()).toBeTruthy();
    // Another tab switched accounts underneath the open question.
    await render("user-2:org-1");
    await settle();
    expect(openDialog()).toBeNull();

    await submit("Recovery codes", "Generate new codes");
    expect(openDialog()).toBeTruthy();
    await render("user-2:org-2");
    await settle();
    expect(openDialog()).toBeNull();

    expect(requests).toEqual([]);
    expect(container.textContent).not.toContain("MFA disabled.");
  });
});
