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
const forms: ProjectForm[] = [
  { id: "walk", name: "Site walk", scope: "organization", version: 3 },
  { id: "nfpa", name: "NFPA 70E", scope: "global", version: 1 },
];

const edits: unknown[] = [];

/**
 * Serves one project, applying member and form changes, and records writes.
 * `elsewhere` is merged into the project when a member is added, as another
 * manager's saved edit would be.
 */
function stubApi(canManage: boolean, elsewhere: Partial<Project> = {}) {
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

function checkbox(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("label.check")]
    .find((entry) => entry.textContent?.startsWith(label))
    ?.querySelector("input") as HTMLInputElement | null;
}

describe("project detail", () => {
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

    const walk = checkbox(container, "Site walk · v3");
    expect(walk?.checked).toBe(false);
    expect(checkbox(container, "NFPA 70E · v1 · Global")).toBeTruthy();
    await click(walk);
    await settle();
    expect(checkbox(container, "Site walk")?.checked).toBe(true);
    expect(container.textContent).toContain("1 form on");
    await click(checkbox(container, "Site walk"));
    await settle();
    expect(checkbox(container, "Site walk")?.checked).toBe(false);

    await click(queryButton("Remove Sam", container));
    await settle();
    expect(writes).toEqual([
      "PUT /api/projects/project-1/members/sam",
      "PUT /api/projects/project-1/forms/walk",
      "DELETE /api/projects/project-1/forms/walk",
      "DELETE /api/projects/project-1/members/sam",
    ]);
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
    expect(container.textContent).toContain("No audit forms turned on");
    expect(writes).toEqual([]);
  });
});
