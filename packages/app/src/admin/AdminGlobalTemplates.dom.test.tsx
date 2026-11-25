import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { FormTemplate } from "@balebase/validators/forms";
import { act } from "react";
import { apiUrl } from "../shared/config";
import { installDom } from "../testing/dom";

const { button, mount, respond, settle } = installDom({
  url: "http://localhost:5173/root/global-templates",
  globals: (window) => ({
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  }),
});
let AdminGlobalTemplates: typeof import("./AdminGlobalTemplates").AdminGlobalTemplates;
let container: HTMLElement;

beforeAll(async () => {
  ({ AdminGlobalTemplates } = await import("./AdminGlobalTemplates"));
});

const globalTemplate: FormTemplate = {
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

const admin = `${apiUrl}/api/admin/form-templates`;

const discardedTemplate = {
  ...globalTemplate,
  formCount: 0,
  currentVersion: 2,
  id: "old/template",
  name: "Old checklist",
  savedAt: "2026-10-05T09:00:00.000Z",
  savedBy: { email: "other@example.com", id: "u2", name: "Other Root" },
  status: "discarded",
  version: 2,
};

/** Answers like the root admin API, recording every request. */
function stubApi(
  template = globalTemplate,
  failure?: string,
  discarded: (typeof discardedTemplate)[] = [],
) {
  const requests: string[] = [];
  respond(async ({ href: url }, init) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url === `${admin}?view=discarded`) {
      return Response.json({ templates: discarded });
    }
    if (method === "POST" && url.endsWith("/restore")) {
      if (failure) return Response.json({ error: failure }, { status: 409 });
      const restored = discarded.shift();
      return Response.json({
        template: { ...restored, currentVersion: 3, status: "unpublished" },
      });
    }
    if (method === "DELETE") {
      return failure
        ? Response.json({ error: failure }, { status: 409 })
        : Response.json({ discarded: true });
    }
    if (method === "POST") {
      return Response.json(
        { template: { ...globalTemplate, id: "new/template" } },
        { status: 201 },
      );
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      return Response.json({
        template: { ...template, ...body, currentVersion: 2, version: 2 },
      });
    }
    if (url === admin) {
      return Response.json({
        templates: [{ ...globalTemplate, formCount: 3 }],
      });
    }
    if (url.endsWith("/versions")) return Response.json({ versions: [] });
    if (url.includes("/activity")) {
      return Response.json({ events: [], nextCursor: null });
    }
    return Response.json({ template: template });
  });
  return requests;
}

async function render(pathname: string) {
  const paths: string[] = [];
  ({ container } = await mount(
    <>
      <AdminGlobalTemplates
        onNavigate={(path) => paths.push(path)}
        pathname={pathname}
      />
      <DialogHost />
    </>,
  ));
  await settle(30);
  return paths;
}

describe("Global templates", () => {
  it("unpublishes and republishes a template, offering to discard it only while unpublished", async () => {
    const requests = stubApi();
    await render("/root/global-templates/fire%2Fsafety");
    expect(container.textContent).not.toContain("Discard");
    await act(async () => button("Unpublish").click());
    await settle(30);
    expect(container.textContent).toContain("Template unpublished.");
    expect(container.textContent).toContain("Discard template");
    expect(container.textContent).not.toContain("Discard draft");
    await act(async () => button("Publish").click());
    await settle(30);
    expect(container.textContent).toContain("Template published.");
    expect(container.textContent).not.toContain("Discard");
    expect(
      requests.filter((request) => request.startsWith("PUT")),
    ).toHaveLength(2);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(
      false,
    );
  });

  it("confirms discarding a draft and returns to Global templates", async () => {
    const requests = stubApi({ ...globalTemplate, status: "draft" });
    const paths = await render("/root/global-templates/fire%2Fsafety");
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
    expect(paths).toEqual(["/root/global-templates"]);
  });

  it("confirms discarding an unpublished template and returns to Global templates", async () => {
    const requests = stubApi({ ...globalTemplate, status: "unpublished" });
    const paths = await render("/root/global-templates/fire%2Fsafety");
    await act(async () => button("Discard template").click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(
      "This unpublished template will be removed from Global templates. You can restore it from Discarded templates for 30 days",
    );
    await act(async () =>
      dialog?.querySelector<HTMLButtonElement>(".buttonDanger")?.click(),
    );
    await settle(30);
    expect(requests).toContain(`DELETE ${admin}/fire%2Fsafety`);
    expect(paths).toEqual(["/root/global-templates"]);
  });

  it("keeps a draft open when discarding fails", async () => {
    stubApi(
      { ...globalTemplate, status: "draft" },
      "This template has a newer version. Reload it before saving.",
    );
    const paths = await render("/root/global-templates/fire%2Fsafety");
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

  it("lists global templates from the root admin API and opens one to manage", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-templates");

    expect(container.querySelector("h1")?.textContent).toBe("Global templates");
    const row = container.querySelector(".formTemplateRow");
    expect(row?.textContent).toContain("Fire safety");
    expect(row?.textContent).toContain("3 forms");
    expect(row?.textContent).not.toContain("Start form");
    const manage = row?.querySelector<HTMLAnchorElement>("a");
    expect(manage?.textContent).toBe("Manage");
    expect(manage?.getAttribute("href")).toBe(
      "/root/global-templates/fire%2Fsafety",
    );
    await act(async () => manage?.click());
    expect(paths).toEqual(["/root/global-templates/fire%2Fsafety"]);
    expect(requests).toEqual([`GET ${admin}`, `GET ${admin}?view=discarded`]);
    expect(container.textContent).toContain("No discarded templates");
  });

  it("lists discarded templates with their purge date and restores one", async () => {
    const requests = stubApi(globalTemplate, undefined, [discardedTemplate]);
    await render("/root/global-templates");
    const rows = container.querySelectorAll(".formTemplateRow");
    const discarded = rows[1];
    expect(discarded?.textContent).toContain("Old checklist");
    expect(discarded?.textContent).toContain(
      "Discarded Oct 5, 2026 by Other Root",
    );
    expect(discarded?.textContent).toContain("Deleted after Nov 4, 2026");
    await act(async () => button("Restore").click());
    await settle(30);
    expect(requests).toContain(`POST ${admin}/old%2Ftemplate/restore`);
    expect(container.textContent).toContain(
      "“Old checklist” restored as an unpublished template.",
    );
    expect(container.textContent).toContain("No discarded templates");
    expect(
      requests.filter((request) => request === `GET ${admin}?view=discarded`),
    ).toHaveLength(2);
  });

  it("shows a discarded template's history before it is restored or purged", async () => {
    const requests = stubApi(globalTemplate, undefined, [discardedTemplate]);
    await render("/root/global-templates");
    const history = () =>
      container.querySelector('[aria-label="History of Old checklist"]');
    expect(history()).toBeNull();
    await act(async () => button("History").click());
    await settle(30);
    expect(history()?.textContent).toContain("Activity");
    expect(requests).toContain(`GET ${admin}/old%2Ftemplate/activity`);
    // Reading history changes nothing.
    expect(requests.filter((request) => !request.startsWith("GET"))).toEqual(
      [],
    );
    await act(async () => button("History").click());
    expect(history()).toBeNull();
  });

  it("shows a refused restore and reloads the discarded templates", async () => {
    const requests = stubApi(
      globalTemplate,
      "This template has a newer version. Reload it before saving.",
      [discardedTemplate],
    );
    await render("/root/global-templates");
    await act(async () => button("Restore").click());
    await settle(30);
    expect(container.textContent).toContain(
      "This template has a newer version.",
    );
    expect(
      requests.filter((request) => request === `GET ${admin}?view=discarded`),
    ).toHaveLength(2);
  });

  it("creates new global templates through the root admin API", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-templates");

    await act(async () => button("New global template").click());
    await settle(30);
    expect(requests).toEqual([
      `GET ${admin}`,
      `GET ${admin}?view=discarded`,
      `POST ${admin}`,
    ]);
    expect(paths).toEqual(["/root/global-templates/new%2Ftemplate"]);
  });

  it("edits a global template without going through the active organization", async () => {
    const requests = stubApi();
    const paths = await render("/root/global-templates/fire%2Fsafety");

    expect(container.textContent).toContain(
      "You are managing the shared global template",
    );
    await act(async () => button("Save as version 2").click());
    await settle(30);
    expect(container.textContent).toContain("Version 2 saved.");
    expect(requests).toContain(`PUT ${admin}/fire%2Fsafety`);
    expect(requests).toContain(`GET ${admin}/fire%2Fsafety/activity`);
    expect(
      requests.filter((request) => request.includes("/api/forms")),
    ).toEqual([]);

    await act(async () => button("Global templates").click());
    expect(paths).toEqual(["/root/global-templates"]);
  });
});
