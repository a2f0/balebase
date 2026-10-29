import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { act } from "react";
import { apiUrl } from "../shared/config";
import { installDom } from "../testing/dom";

const { button, mount, respond, settle } = installDom({
  url: "http://localhost:5173/root/global-audits",
  globals: (window) => ({
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  }),
});
let AdminGlobalAudits: typeof import("./AdminGlobalAudits").AdminGlobalAudits;
let container: HTMLElement;

beforeAll(async () => {
  ({ AdminGlobalAudits } = await import("./AdminGlobalAudits"));
});

const globalForm: AuditTemplate = {
  createdAt: "2026-10-01T09:00:00.000Z",
  currentVersion: 1,
  definition: {
    sections: [
      {
        id: "s1",
        items: [
          {
            id: "q1",
            prompt: "Exits clear",
            required: true,
            responseType: "check",
          },
        ],
        title: "Exits",
      },
    ],
    version: 1,
  },
  description: "Shared with every organization.",
  id: "fire/safety",
  name: "Fire safety",
  savedAt: "2026-10-01T09:00:00.000Z",
  savedBy: { email: "root@example.com", id: "u1", name: "Root" },
  scope: "global",
  status: "published",
  updatedAt: "2026-10-01T09:00:00.000Z",
  version: 1,
};

const admin = `${apiUrl}/api/admin/audit-templates`;

/** Answers like the root admin API, recording every request. */
function stubApi(form = globalForm, failure?: string) {
  const requests: string[] = [];
  respond(async ({ href: url }, init) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "DELETE") {
      return failure
        ? Response.json({ error: failure }, { status: 409 })
        : Response.json({ discarded: true });
    }
    if (method === "POST") {
      return Response.json(
        { template: { ...globalForm, id: "new/form" } },
        { status: 201 },
      );
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      return Response.json({
        template: { ...form, ...body, currentVersion: 2, version: 2 },
      });
    }
    if (url === admin) {
      return Response.json({ templates: [{ ...globalForm, auditCount: 3 }] });
    }
    if (url.endsWith("/versions")) return Response.json({ versions: [] });
    if (url.includes("/activity")) {
      return Response.json({ events: [], nextCursor: null });
    }
    return Response.json({ template: form });
  });
  return requests;
}

async function render(pathname: string) {
  const paths: string[] = [];
  ({ container } = await mount(
    <>
      <AdminGlobalAudits
        onNavigate={(path) => paths.push(path)}
        pathname={pathname}
      />
      <DialogHost />
    </>,
  ));
  await settle(30);
  return paths;
}

describe("Global Audits", () => {
  it("unpublishes and republishes a form, offering to discard it only while unpublished", async () => {
    const requests = stubApi();
    await render("/root/global-audits/fire%2Fsafety");
    expect(container.textContent).not.toContain("Discard");
    await act(async () => button("Unpublish").click());
    await settle(30);
    expect(container.textContent).toContain("Form unpublished.");
    expect(container.textContent).toContain("Discard form");
    expect(container.textContent).not.toContain("Discard draft");
    await act(async () => button("Publish").click());
    await settle(30);
    expect(container.textContent).toContain("Form published.");
    expect(container.textContent).not.toContain("Discard");
    expect(
      requests.filter((request) => request.startsWith("PUT")),
    ).toHaveLength(2);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
      false,
    );
  });

  it("confirms discarding a draft and returns to Global Audits", async () => {
    const requests = stubApi({ ...globalForm, status: "draft" });
    const paths = await render("/root/global-audits/fire%2Fsafety");
    await act(async () => button("Discard draft").click());
    await act(async () => button("Cancel").click());
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
      false,
    );
    await act(async () => button("Discard draft").click());
    const confirm = document.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] .buttonDanger',
    );
    expect(confirm).not.toBeNull();
    await act(async () => confirm?.click());
    await settle(30);
    expect(requests).toContain(`DELETE ${admin}/fire%2Fsafety`);
    expect(paths).toEqual(["/root/global-audits"]);
  });

  it("confirms discarding an unpublished form and returns to Global Audits", async () => {
    const requests = stubApi({ ...globalForm, status: "unpublished" });
    const paths = await render("/root/global-audits/fire%2Fsafety");
    await act(async () => button("Discard form").click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(
      "This unpublished form will be removed from Global Audits.",
    );
    await act(async () =>
      dialog?.querySelector<HTMLButtonElement>(".buttonDanger")?.click(),
    );
    await settle(30);
    expect(requests).toContain(`DELETE ${admin}/fire%2Fsafety`);
    expect(paths).toEqual(["/root/global-audits"]);
  });

  it("keeps a draft open when discarding fails", async () => {
    stubApi(
      { ...globalForm, status: "draft" },
      "This template has a newer version. Reload it before saving.",
    );
    const paths = await render("/root/global-audits/fire%2Fsafety");
    await act(async () => button("Discard draft").click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="alertdialog"] .buttonDanger')
        ?.click(),
    );
    await settle(30);
    expect(paths).toEqual([]);
    expect(container.textContent).toContain(
      "This template has a newer version.",
    );
  });

  it("lists global forms from the root admin API and opens one to manage", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits");

    expect(container.querySelector("h1")?.textContent).toBe("Global Audits");
    const row = container.querySelector(".auditTemplateRow");
    expect(row?.textContent).toContain("Fire safety");
    expect(row?.textContent).toContain("3 audits");
    expect(row?.textContent).not.toContain("Start audit");
    const manage = row?.querySelector<HTMLAnchorElement>("a");
    expect(manage?.textContent).toBe("Manage");
    expect(manage?.getAttribute("href")).toBe(
      "/root/global-audits/fire%2Fsafety",
    );
    await act(async () => manage?.click());
    expect(paths).toEqual(["/root/global-audits/fire%2Fsafety"]);
    expect(requests).toEqual([`GET ${admin}`]);
  });

  it("creates new global checklists through the root admin API", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits");

    await act(async () => button("New global checklist").click());
    await settle(30);
    expect(requests).toEqual([`GET ${admin}`, `POST ${admin}`]);
    expect(paths).toEqual(["/root/global-audits/new%2Fform"]);
  });

  it("edits a global form without going through the active organization", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-audits/fire%2Fsafety");

    expect(container.textContent).toContain(
      "You are managing the shared global form",
    );
    await act(async () => button("Save as version 2").click());
    await settle(30);
    expect(container.textContent).toContain("Version 2 saved.");
    expect(requests).toContain(`PUT ${admin}/fire%2Fsafety`);
    expect(requests).toContain(`GET ${admin}/fire%2Fsafety/activity`);
    expect(
      requests.filter((request) => request.includes("/api/audits")),
    ).toEqual([]);

    await act(async () => button("Global Audits").click());
    expect(paths).toEqual(["/root/global-audits"]);
  });
});
