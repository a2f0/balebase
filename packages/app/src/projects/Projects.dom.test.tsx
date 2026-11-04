import { beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { Project, ProjectForm } from "@balebase/validators/projects";
import { installDom } from "../testing/dom";

const { click, fill, mount, queryButton, respond, settle } = installDom({
  url: "http://localhost:5173/projects/project-1",
});
let Projects: typeof import("./Projects").Projects;

beforeAll(async () => {
  ({ Projects } = await import("./Projects"));
});

const owner = { email: "owner@example.com", id: "owner", name: "Olivia" };
const member = { email: "sam@example.com", id: "sam", name: "Sam" };
function publishedForm(
  id: string,
  name: string,
  scope: ProjectForm["scope"],
  version: number,
): ProjectForm {
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    currentVersion: version,
    definition: {
      sections: [
        {
          id: "exits",
          items: [
            {
              id: "exits-clear",
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
    description: `${name} checklist`,
    id,
    name,
    savedAt: "2026-09-01T00:00:00.000Z",
    savedBy: owner,
    scope,
    status: "published",
    updatedAt: "2026-09-01T00:00:00.000Z",
    version,
  };
}

const forms: ProjectForm[] = [
  publishedForm("walk", "Site walk", "organization", 3),
  publishedForm("nfpa", "NFPA 70E", "global", 1),
];

const edits: unknown[] = [];

/**
 * Serves one project, applying member and form changes, and records writes.
 * `elsewhere` is merged into the project when a member is added, as another
 * manager's saved edit would be; `initial` into the project as first served.
 */
function stubApi(
  canManage: boolean,
  elsewhere: Partial<Project> = {},
  initial: Partial<Project> = {},
) {
  const writes: string[] = [];
  edits.length = 0;
  let project: Project = {
    createdAt: "2026-10-01T00:00:00.000Z",
    description: "North wing",
    formCount: 0,
    forms: [],
    id: "project-1",
    isMember: false,
    memberCount: 0,
    members: [],
    name: "Hospital renovation",
    revision: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...initial,
  };
  respond(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/activity"))
      return Response.json({ events: [], nextCursor: null });
    if (method === "GET")
      return Response.json({
        availableForms: forms,
        canManage,
        directory: [owner, member],
        project,
      });
    writes.push(`${method} ${url.pathname}`);
    if (method === "PATCH") {
      const { expectedRevision, ...changes } = JSON.parse(
        String(init?.body),
      ) as Partial<Project> & { expectedRevision: number };
      edits.push({ expectedRevision, ...changes });
      if (expectedRevision !== project.revision)
        return Response.json(
          { error: "This project changed. Reload it before saving." },
          { status: 409 },
        );
      project = { ...project, ...changes, revision: project.revision + 1 };
      return Response.json({ project });
    }
    const [, , , , kind, target] = url.pathname.split("/");
    if (kind === "members") {
      const members =
        method === "PUT"
          ? [...project.members, member]
          : project.members.filter((person) => person.id !== target);
      project = {
        ...project,
        ...(method === "PUT" ? elsewhere : {}),
        memberCount: members.length,
        members,
      };
    } else {
      const enabled =
        method === "PUT"
          ? [...project.forms, ...forms.filter((form) => form.id === target)]
          : project.forms.filter((form) => form.id !== target);
      project = { ...project, formCount: enabled.length, forms: enabled };
    }
    return Response.json({ project });
  });
  /** Saves another manager's edit on the server only. */
  const editElsewhere = (changes: Partial<Project>) => {
    project = { ...project, ...changes, revision: project.revision + 1 };
  };
  return { editElsewhere, writes };
}

async function render() {
  const { container } = await mount(
    <>
      <Projects onNavigate={() => {}} pathname="/projects/project-1" />
      <DialogHost />
    </>,
  );
  await settle();
  return container;
}

function toggle(container: HTMLElement, name: string) {
  return container.querySelector<HTMLInputElement>(
    `input[role="switch"][aria-label="Use ${name} in this project"]`,
  );
}

/** The collection a form is listed in, by the collection's heading. */
function collectionOf(container: HTMLElement, name: string) {
  return [...container.querySelectorAll(".auditCollection")]
    .find((section) =>
      [...section.querySelectorAll(".auditTemplateName, .rowTitle")].some(
        (title) => title.textContent === name,
      ),
    )
    ?.querySelector(".auditCollectionTitle")?.firstChild?.textContent;
}

describe("project detail", () => {
  it("shows members, audit forms, and activity on separate tabs", async () => {
    const { writes } = stubApi(true);
    const container = await render();
    const strip = container.querySelector(
      '[role="tablist"][aria-label="Project sections"]',
    );
    const tabs = [...(strip?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Members",
      "Audit forms",
      "Activity",
    ]);
    const shown = () =>
      [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
        .filter((panel) => !panel.hidden)
        .map(
          (panel) =>
            document.getElementById(panel.getAttribute("aria-labelledby") ?? "")
              ?.textContent,
        );
    expect(shown()).toEqual(["Members"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    // A choice left unsaved on one tab survives a visit to another.
    const choice = () =>
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Add a member"]',
      );
    await fill(choice(), "sam");
    await click(queryButton("Activity", container));
    expect(shown()).toEqual(["Activity"]);
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("-1");
    await click(queryButton("Audit forms", container));
    expect(shown()).toEqual(["Audit forms"]);
    await click(queryButton("Members", container));
    expect(shown()).toEqual(["Members"]);
    expect(choice()?.value).toBe("sam");
    await click(queryButton("Add member", container));
    await settle();
    expect(writes).toEqual(["PUT /api/projects/project-1/members/sam"]);
  });

  it("lets a manager add members and turn audit forms on and off", async () => {
    const { writes } = stubApi(true);
    const container = await render();
    expect(container.textContent).toContain("Hospital renovation");
    expect(container.textContent).toContain("No members yet");

    await fill(
      container.querySelector('select[aria-label="Add a member"]'),
      "sam",
    );
    await click(queryButton("Add member", container));
    await settle();
    expect(container.textContent).toContain("sam@example.com");

    const walk = toggle(container, "Site walk");
    expect(walk?.checked).toBe(false);
    expect(toggle(container, "NFPA 70E")?.checked).toBe(false);
    await click(walk);
    await settle();
    expect(toggle(container, "Site walk")?.checked).toBe(true);
    expect(container.textContent).toContain("1 form on");
    await click(toggle(container, "Site walk"));
    await settle();
    expect(toggle(container, "Site walk")?.checked).toBe(false);

    await click(queryButton("Remove Sam", container));
    await settle();
    expect(writes).toEqual([
      "PUT /api/projects/project-1/members/sam",
      "PUT /api/projects/project-1/forms/walk",
      "DELETE /api/projects/project-1/forms/walk",
      "DELETE /api/projects/project-1/members/sam",
    ]);
  });

  it("lists forms as the Audits page does, without editing them", async () => {
    stubApi(true);
    const container = await render();
    expect(collectionOf(container, "NFPA 70E")).toBe("Global forms");
    expect(collectionOf(container, "Site walk")).toBe("Organization forms");
    const card = toggle(container, "Site walk")?.closest(".auditTemplateCard");
    expect(card?.textContent).toContain("Site walk checklist");
    expect(card?.textContent).toContain("Published");
    expect(card?.textContent).toContain("1 item");
    expect(card?.textContent).toContain("v3");
    for (const label of ["Edit", "Customize", "Start audit"])
      expect(queryButton(label, card as HTMLElement)).toBeFalsy();

    await click(queryButton("List", container));
    const row = toggle(container, "Site walk")?.closest(".auditTemplateRow");
    expect(row?.textContent).toContain("Site walk checklist");
    expect(collectionOf(container, "NFPA 70E")).toBe("Global forms");
  });

  it("saves only the edited fields from the revision it loaded", async () => {
    stubApi(true);
    const container = await render();
    await click(queryButton("Edit", container));
    await fill(container.querySelector("form input"), "Clinic renovation");
    await click(queryButton("Save changes", container));
    await settle();
    expect(edits).toEqual([{ expectedRevision: 0, name: "Clinic renovation" }]);
    expect(container.textContent).toContain("Clinic renovation");
    expect(container.textContent).toContain("North wing");
  });

  it("keeps an open edit on the revision it showed after the project refreshes", async () => {
    stubApi(true, { description: "Changed elsewhere", revision: 4 });
    const container = await render();
    await click(queryButton("Edit", container));
    // Adding a member refreshes the project with another manager's edit.
    await fill(
      container.querySelector('select[aria-label="Add a member"]'),
      "sam",
    );
    await click(queryButton("Add member", container));
    await settle();
    expect(container.textContent).toContain("Changed elsewhere");
    await fill(container.querySelector("form input"), "Clinic renovation");
    await click(queryButton("Save changes", container));
    await settle();
    expect(edits).toEqual([{ expectedRevision: 0, name: "Clinic renovation" }]);
    expect(container.textContent).toContain("Reload it before saving");
    // The refusal reloads the project, so the next edit starts from it.
    await click(queryButton("Cancel", container));
    await click(queryButton("Edit", container));
    await fill(container.querySelector("form input"), "Clinic renovation");
    await click(queryButton("Save changes", container));
    await settle();
    expect(edits.at(-1)).toEqual({
      expectedRevision: 4,
      name: "Clinic renovation",
    });
    expect(container.textContent).toContain("Project updated.");
  });

  it("reloads a project whose edit was refused so the next edit can save", async () => {
    const { editElsewhere } = stubApi(true);
    const container = await render();
    await click(queryButton("Edit", container));
    editElsewhere({ description: "Their notes" });
    await fill(container.querySelector("form input"), "Clinic renovation");
    await click(queryButton("Save changes", container));
    await settle();
    expect(container.textContent).toContain("Reload it before saving");
    expect(container.textContent).toContain("Their notes");
    await click(queryButton("Cancel", container));
    await click(queryButton("Edit", container));
    await fill(container.querySelector("form input"), "Clinic renovation");
    await click(queryButton("Save changes", container));
    await settle();
    expect(edits).toEqual([
      { expectedRevision: 0, name: "Clinic renovation" },
      { expectedRevision: 1, name: "Clinic renovation" },
    ]);
  });

  it("shows members a read-only view", async () => {
    const { writes } = stubApi(false);
    const container = await render();
    expect(container.textContent).toContain("Hospital renovation");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(queryButton("Edit", container)).toBeFalsy();
    expect(container.textContent).toContain("No global forms turned on");
    expect(container.textContent).toContain("No organization forms turned on");
    expect(writes).toEqual([]);
  });

  it("shows members the forms turned on, without switches", async () => {
    const walk = forms.filter((form) => form.id === "walk");
    stubApi(false, {}, { formCount: 1, forms: walk });
    const container = await render();
    expect(collectionOf(container, "Site walk")).toBe("Organization forms");
    expect(container.textContent).not.toContain("NFPA 70E");
    expect(container.querySelector('input[role="switch"]')).toBeNull();
  });
});
