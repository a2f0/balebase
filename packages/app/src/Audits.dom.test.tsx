import { describe, expect, it } from "bun:test";
import type { AuditDetail, AuditTemplate } from "@balebase/validators/audits";
import { Audits } from "./Audits";
import { installDom } from "./testing/dom";

const { render, respond, settle } = installDom({
  url: "http://localhost:5173/audits",
});
let container: HTMLElement;

async function show(pathname: string) {
  ({ container } = await render(
    <Audits onNavigate={() => {}} pathname={pathname} />,
  ));
  await settle(30);
}

/** Holds a record's response until the test releases it. */
function deferredResponses() {
  const pending = new Map<string, (response: Response) => void>();
  return {
    hold(id: string) {
      return new Promise<Response>((resolve) => pending.set(id, resolve));
    },
    async release(id: string, response: Response) {
      pending.get(id)?.(response);
      await settle(30);
    },
  };
}

function run(id: string, templateName: string): AuditDetail {
  return {
    audit: {
      answerActivity: {},
      completedAt: null,
      createdAt: "2026-10-02T12:00:00.000Z",
      createdBy: { email: "sam@example.com", id: "user-1", name: "Sam" },
      deletedAt: null,
      deletedBy: null,
      definition: { sections: [], version: 1 },
      id,
      responses: {},
      revision: 1,
      status: "in_progress",
      templateId: null,
      templateName,
      templateVersion: 1,
      updatedAt: "2026-10-02T12:00:00.000Z",
    },
    issues: [],
    members: [],
  };
}

function template(id: string, name: string): AuditTemplate {
  return {
    createdAt: "2026-10-01T09:00:00.000Z",
    currentVersion: 1,
    definition: { sections: [], version: 1 },
    description: "",
    id,
    name,
    savedAt: "2026-10-01T09:00:00.000Z",
    savedBy: { email: "olivia@example.com", id: "u1", name: "Olivia" },
    scope: "organization",
    status: "draft",
    updatedAt: "2026-10-01T09:00:00.000Z",
    version: 1,
  };
}

describe("audit record navigation, mounted", () => {
  it("keeps the current run when an earlier run answers late", async () => {
    const responses = deferredResponses();
    respond(async ({ pathname: path }) => {
      if (path === "/api/audits/runs/run-1") return responses.hold("run-1");
      if (path === "/api/audits/runs/run-2") {
        return Response.json(run("run-2", "Electrical panel"));
      }
      return Response.json({ events: [], nextCursor: null });
    });

    await show("/audits/runs/run-1");
    await show("/audits/runs/run-2");
    expect(container.textContent).toContain("Electrical panel");
    await responses.release("run-1", Response.json(run("run-1", "Fire exits")));

    expect(container.textContent).toContain("Electrical panel");
    expect(container.textContent).not.toContain("Fire exits");
  });

  it("keeps the current template when an earlier template answers late", async () => {
    const responses = deferredResponses();
    respond(async ({ pathname: path }) => {
      if (path === "/api/audits/templates/t1") return responses.hold("t1");
      if (path === "/api/audits/templates/t2") {
        return Response.json({ template: template("t2", "Closing checklist") });
      }
      if (path.endsWith("/versions")) return Response.json({ versions: [] });
      return Response.json({ events: [], nextCursor: null });
    });
    const names = () =>
      [...container.querySelectorAll("input")].map((input) => input.value);

    await show("/audits/templates/t1");
    await show("/audits/templates/t2");
    expect(names()).toContain("Closing checklist");
    await responses.release(
      "t1",
      Response.json({ template: template("t1", "Opening checklist") }),
    );

    expect(names()).toContain("Closing checklist");
    expect(names()).not.toContain("Opening checklist");
  });
});
