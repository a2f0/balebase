import { beforeAll, describe, expect, it } from "bun:test";
import { productName } from "@balebase/ui/brand";
import { DialogHost } from "@balebase/ui/react";
import type {
  Project,
  ProjectSummary,
  ProjectTemplate,
} from "@balebase/validators/projects";
import { DeviceContext, type DeviceState } from "../offline/offlineContext";
import type { OfflineWorkspace } from "../offline/offlineStore";
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
function publishedTemplate(
  id: string,
  name: string,
  scope: ProjectTemplate["scope"],
  version: number,
): ProjectTemplate {
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

const templates: ProjectTemplate[] = [
  publishedTemplate("walk", "Site walk", "organization", 3),
  publishedTemplate("nfpa", "NFPA 70E", "global", 1),
];

const edits: unknown[] = [];

/**
 * Serves one project, applying member and template changes, and records writes.
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
    templateCount: 0,
    templates: [],
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
        availableTemplates: templates,
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
          ? [
              ...project.templates,
              ...templates.filter((template) => template.id === target),
            ]
          : project.templates.filter((template) => template.id !== target);
      project = {
        ...project,
        templateCount: enabled.length,
        templates: enabled,
      };
    }
    return Response.json({ project });
  });
  /** Saves another manager's edit on the server only. */
  const editElsewhere = (changes: Partial<Project>) => {
    project = { ...project, ...changes, revision: project.revision + 1 };
  };
  return { editElsewhere, writes };
}

async function render(
  device?: DeviceState,
  onNavigate: (pathname: string) => void = () => {},
) {
  const page = (
    <>
      <Projects onNavigate={onNavigate} pathname="/projects/project-1" />
      <DialogHost />
    </>
  );
  const { container } = await mount(
    device ? (
      <DeviceContext.Provider value={device}>{page}</DeviceContext.Provider>
    ) : (
      page
    ),
  );
  await settle();
  return container;
}

/** The panel of the tab named `label`, opened. */
async function openTab(container: HTMLElement, label: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (entry) => entry.textContent === label,
  );
  await click(tab as HTMLElement);
  return document.getElementById(
    tab?.getAttribute("aria-controls") ?? "",
  ) as HTMLElement;
}

/** A device workspace holding `forms`, with the jobs that sync them. */
function deviceWith(
  forms: OfflineWorkspace["forms"],
  jobs: OfflineWorkspace["jobs"] = [],
): DeviceState {
  return {
    error: undefined,
    online: true,
    workspace: {
      forms,
      templates: [],
      issues: [],
      jobs,
      key: "device",
      members: [],
      organizationName: "Org",
      projects: [],
      scope: { organizationId: "org", userId: owner.id },
      user: owner,
    },
  };
}

type Job = OfflineWorkspace["jobs"][number];

/** A sync job in `status`: the form `id`'s start, or else a photo. */
function job(
  id: string,
  status: Job["status"],
  { form = false, error }: { form?: boolean; error?: string } = {},
): Job {
  return {
    attempts: 1,
    dependsOn: [],
    id,
    operation: form
      ? {
          id,
          projectId: "project-1",
          answers: {},
          templateId: "walk",
          templateVersion: 3,
          type: "formStart",
        }
      : { id, type: "image", filename: "", issueId: "" },
    retryAt: 0,
    status,
    ...(error ? { error } : {}),
  };
}

/** No answers yet, here or on the server. */
const unanswered = {
  local: {},
  replaced: {},
  sending: [],
  server: { answers: {}, revision: 0, status: "in_progress" as const },
};

function toggle(container: HTMLElement, name: string) {
  return container.querySelector<HTMLInputElement>(
    `input[role="switch"][aria-label="Use ${name} in this project"]`,
  );
}

/** The collection a template is listed in, by the collection's heading. */
function collectionOf(container: HTMLElement, name: string) {
  return [...container.querySelectorAll(".formCollection")]
    .find((section) =>
      [...section.querySelectorAll(".formTemplateName, .rowTitle")].some(
        (title) => title.textContent === name,
      ),
    )
    ?.querySelector(".formCollectionTitle")?.firstChild?.textContent;
}

/** Chooses `item` from the menu of the row titled `name`. */
async function chooseFromRow(name: string, item: string) {
  await click(`Actions for ${name}`);
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (entry) => entry.textContent === item,
    ),
  );
}

/** A project as the list shows it. */
function listed(id: string, name: string): ProjectSummary {
  return {
    createdAt: "2026-10-01T00:00:00.000Z",
    description: "North wing",
    templateCount: 1,
    id,
    isMember: false,
    memberCount: 2,
    name,
    revision: 3,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** Mounts the project list beside the host its confirmations open in. */
async function renderList() {
  const { container } = await mount(
    <>
      <Projects onNavigate={() => {}} pathname="/projects" />
      <DialogHost />
    </>,
  );
  await settle();
  return container;
}

/** The row titles under the section headed `heading`. */
function rowTitles(container: HTMLElement, heading: string) {
  const section = [...container.querySelectorAll("section")].find(
    (entry) => entry.querySelector(".sectionTitle")?.textContent === heading,
  );
  return [...(section?.querySelectorAll(".rowTitle") ?? [])].map(
    (title) => title.textContent,
  );
}

describe("project detail", () => {
  it("shows members, forms, setup, and activity on separate tabs", async () => {
    const { writes } = stubApi(true);
    const container = await render();
    const strip = container.querySelector(
      '[role="tablist"][aria-label="Project sections"]',
    );
    const tabs = [...(strip?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Members",
      "Forms",
      "Project setup",
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
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("-1");
    await click(queryButton("Forms", container));
    expect(shown()).toEqual(["Forms"]);
    await click(queryButton("Project setup", container));
    expect(shown()).toEqual(["Project setup"]);
    await click(queryButton("Members", container));
    expect(shown()).toEqual(["Members"]);
    expect(choice()?.value).toBe("sam");
    await click(queryButton("Add member", container));
    await settle();
    expect(writes).toEqual(["PUT /api/projects/project-1/members/sam"]);
  });

  it("lets a manager add members and turn form templates on and off", async () => {
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
    expect(container.textContent).toContain("1 template on");
    await click(toggle(container, "Site walk"));
    await settle();
    expect(toggle(container, "Site walk")?.checked).toBe(false);

    await chooseFromRow("Sam", "Remove from project");
    await settle();
    expect(writes).toEqual([
      "PUT /api/projects/project-1/members/sam",
      "PUT /api/projects/project-1/templates/walk",
      "DELETE /api/projects/project-1/templates/walk",
      "DELETE /api/projects/project-1/members/sam",
    ]);
  });

  it("lists templates as the Forms page does, without editing them", async () => {
    stubApi(true);
    const container = await render();
    expect(collectionOf(container, "NFPA 70E")).toBe("Global templates");
    expect(collectionOf(container, "Site walk")).toBe("Organization templates");
    const card = toggle(container, "Site walk")?.closest(".formTemplateCard");
    expect(card?.textContent).toContain("Site walk checklist");
    expect(card?.textContent).toContain("Published");
    expect(card?.textContent).toContain("1 item");
    expect(card?.textContent).toContain("v3");
    for (const label of ["Edit", "Customize", "Start form"])
      expect(queryButton(label, card as HTMLElement)).toBeFalsy();

    const setup = toggle(container, "Site walk")?.closest('[role="tabpanel"]');
    await click(queryButton("List", setup as HTMLElement));
    const row = toggle(container, "Site walk")?.closest(".formTemplateRow");
    expect(row?.textContent).toContain("Site walk checklist");
    expect(collectionOf(container, "NFPA 70E")).toBe("Global templates");
  });

  it("starts forms from the templates turned on for the project", async () => {
    const walk = templates.filter((template) => template.id === "walk");
    stubApi(false, {}, { templateCount: 1, templates: walk });
    const container = await render();
    const panel = await openTab(container, "Forms");
    expect(collectionOf(panel, "Site walk")).toBe("Organization templates");
    expect(panel.textContent).not.toContain("NFPA 70E");
    expect(panel.querySelector('input[role="switch"]')).toBeNull();
    expect(panel.textContent).toContain("No forms on this device");
    // Without a device workspace (not yet prepared) nothing starts.
    await click(queryButton("Start form", panel));
    await settle();
    expect(panel.textContent).toContain(
      "This device is still getting ready for forms.",
    );
  });

  it("lists the forms this device started for the project", async () => {
    stubApi(false);
    const [walk] = templates;
    if (!walk) throw new Error("Missing template.");
    const started = (
      id: string,
      projectId: string,
      status: OfflineWorkspace["forms"][number]["status"],
    ) => ({
      id,
      projectId,
      ...unanswered,
      startedAt: `2026-10-0${id.length}T00:00:00.000Z`,
      status,
      template: walk,
    });
    const visited: string[] = [];
    const container = await render(
      deviceWith(
        [
          started("d", "project-1", "draft"),
          started("ww", "project-1", "completed"),
          started("sss", "project-1", "completed"),
          started("pppp", "project-1", "inProgress"),
          started("other", "project-2", "draft"),
        ],
        [
          job("ww", "blocked", { form: true, error: "Template gone" }),
          job("sss", "synced", { form: true }),
          job("pppp", "synced", { form: true }),
        ],
      ),
      (pathname) => visited.push(pathname),
    );
    const panel = await openTab(container, "Forms");
    const rows = [...panel.querySelectorAll(".rowList .row")].map(
      (row) => row.textContent,
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Up to date");
    expect(rows[1]).toContain("Synced");
    expect(rows[2]).toContain("Not synced");
    expect(rows[2]).toContain("Template gone");
    expect(rows[3]).toContain("Draft");
    for (const label of ["Open form", "View"])
      await click(queryButton(label, panel));
    for (const button of panel.querySelectorAll("button"))
      if (button.textContent === "Continue") await click(button);
    await settle();
    expect(visited).toEqual([
      "/forms/runs/sss",
      "/projects/project-1/forms/ww",
      "/projects/project-1/forms/pppp",
      "/projects/project-1/forms/d",
    ]);
  });

  it("counts a form synced only once its issues and photos are", async () => {
    stubApi(false);
    const [walk] = templates;
    if (!walk) throw new Error("Missing template.");
    const device = deviceWith(
      [
        {
          id: "form",
          projectId: "project-1",
          ...unanswered,
          startedAt: "2026-10-01T00:00:00.000Z",
          status: "completed",
          template: walk,
        },
      ],
      [
        job("form", "synced", { form: true }),
        job("issue", "synced"),
        job("photo", "blocked", { error: "Photo refused" }),
      ],
    );
    const workspace = device.workspace;
    if (!workspace) throw new Error("Missing workspace.");
    workspace.issues = [
      {
        images: [{ filename: "a.png", id: "photo" }],
        operation: {
          assignedTo: null,
          formId: "form",
          description: "",
          id: "issue",
          itemId: "item",
          priority: "medium",
          title: "Cracked cover",
          type: "issue",
        },
      },
    ];
    const visited: string[] = [];
    const container = await render(device, (pathname) =>
      visited.push(pathname),
    );
    const panel = await openTab(container, "Forms");
    const row = panel.querySelector(".rowList .row")?.textContent;
    expect(row).toContain("Not synced");
    expect(row).toContain("Photo refused");
    await click(queryButton("View", panel));
    expect(visited).toEqual(["/projects/project-1/forms/form"]);
  });

  it("shows the device's copy when the API cannot be reached", async () => {
    const [walk] = templates;
    if (!walk) throw new Error("Missing template.");
    respond(async () =>
      Response.json({ error: "Unavailable" }, { status: 503 }),
    );
    const device = deviceWith([]);
    const workspace = device.workspace;
    if (!workspace) throw new Error("Missing workspace.");
    workspace.projects = [
      { description: "", templateIds: ["walk"], id: "project-1", name: "Site" },
    ];
    workspace.templates = [walk];
    for (const pathname of ["/projects", "/projects/project-1"]) {
      const { container } = await mount(
        <DeviceContext.Provider value={device}>
          <Projects onNavigate={() => {}} pathname={pathname} />
        </DeviceContext.Provider>,
      );
      await settle();
      expect(container.textContent).toContain(
        `Could not reach ${productName}.`,
      );
      expect(container.textContent).toContain(
        pathname === "/projects" ? "Your projects" : "Site walk",
      );
      if (pathname !== "/projects")
        expect(queryButton("Start form", container)).toBeTruthy();
    }
  });

  it("keeps forms for projects the device no longer lists within reach", async () => {
    const [walk] = templates;
    if (!walk) throw new Error("Missing template.");
    respond(async () => Response.json({ canManage: false, projects: [] }));
    const visited: string[] = [];
    const device = deviceWith([
      {
        id: "left-behind",
        projectId: "deleted-project",
        ...unanswered,
        startedAt: "2026-10-01T00:00:00.000Z",
        status: "draft",
        template: walk,
      },
    ]);
    const { container } = await mount(
      <DeviceContext.Provider value={device}>
        <Projects
          onNavigate={(pathname) => visited.push(pathname)}
          pathname="/projects"
        />
      </DeviceContext.Provider>,
    );
    await settle();
    expect(container.textContent).toContain("Other forms on this device");
    await click(queryButton("Continue", container));
    expect(visited).toEqual(["/projects/deleted-project/forms/left-behind"]);
  });

  it("lists deleted projects and lets a manager restore one", async () => {
    const requests: string[] = [];
    const deleted = {
      deletedAt: "2026-10-20T00:00:00.000Z",
      deletedBy: owner,
      description: "",
      id: "old-site",
      name: "Old site",
    };
    respond(async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/projects/deleted")
        return Response.json({ canManage: true, projects: [deleted] });
      if (url.pathname === "/api/projects/old-site/restore")
        return Response.json({ project: {} });
      return Response.json({ canManage: true, projects: [] });
    });
    const visited: string[] = [];
    const { container } = await mount(
      <Projects
        onNavigate={(pathname) => visited.push(pathname)}
        pathname="/projects"
      />,
    );
    await settle();
    expect(container.textContent).toContain("Deleted projects");
    expect(container.textContent).toContain("Old site");
    expect(container.textContent).toContain(`by ${owner.name}`);
    await chooseFromRow("Old site", "Restore");
    await settle();
    expect(requests).toContain("POST /api/projects/old-site/restore");
    expect(visited).toEqual(["/projects/old-site"]);
  });

  it("stays put when a restore finishes after the page closed", async () => {
    const restore = Promise.withResolvers<void>();
    const requests: string[] = [];
    respond(async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/projects/deleted")
        return Response.json({
          canManage: true,
          projects: [
            {
              deletedAt: "2026-10-20T00:00:00.000Z",
              deletedBy: owner,
              description: "",
              id: "old-site",
              name: "Old site",
            },
          ],
        });
      if (url.pathname === "/api/projects/old-site/restore") {
        await restore.promise;
        return Response.json({ project: {} });
      }
      return Response.json({ canManage: true, projects: [] });
    });
    const visited: string[] = [];
    const { unmount } = await mount(
      <Projects
        onNavigate={(pathname) => visited.push(pathname)}
        pathname="/projects"
      />,
    );
    await settle();
    await chooseFromRow("Old site", "Restore");
    await unmount();
    restore.resolve();
    await settle();
    expect(requests).toContain("POST /api/projects/old-site/restore");
    expect(visited).toEqual([]);
  });

  it("lets a manager edit and delete projects from their rows' menus", async () => {
    let projects = [listed("site", "Site walk"), listed("clinic", "Clinic")];
    const deleted: (ProjectSummary & { deletedAt: string })[] = [];
    const changes: unknown[] = [];
    respond(async (url, init) => {
      const method = init?.method ?? "GET";
      const id = url.pathname.split("/")[3];
      if (method === "PATCH") {
        const change = JSON.parse(String(init?.body)) as { name: string };
        changes.push(change);
        projects = projects.map((project) =>
          project.id === id ? { ...project, name: change.name } : project,
        );
        return Response.json({ project: listed("site", change.name) });
      }
      if (method === "DELETE") {
        const gone = projects.find((project) => project.id === id);
        projects = projects.filter((project) => project !== gone);
        if (gone)
          deleted.push({ ...gone, deletedAt: "2026-10-20T00:00:00.000Z" });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/projects/deleted")
        return Response.json({ canManage: true, projects: deleted });
      return Response.json({ canManage: true, projects });
    });
    const container = await renderList();
    expect(rowTitles(container, "All projects")).toEqual([
      "Site walk",
      "Clinic",
    ]);
    expect(rowTitles(container, "Deleted projects")).toEqual([]);

    await chooseFromRow("Site walk", "Edit");
    expect(queryButton("New project", container)).toBeNull();
    await fill(container.querySelector("form input"), "Site survey");
    await click(queryButton("Save changes", container));
    await settle();
    // Only the name changed, from the revision the list showed.
    expect(changes).toEqual([{ expectedRevision: 3, name: "Site survey" }]);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Project updated.");
    expect(rowTitles(container, "All projects")).toEqual([
      "Site survey",
      "Clinic",
    ]);

    await chooseFromRow("Clinic", "Delete");
    await click("Delete project");
    await settle();
    // The project leaves the list for Deleted projects.
    expect(rowTitles(container, "All projects")).toEqual(["Site survey"]);
    expect(rowTitles(container, "Deleted projects")).toEqual(["Clinic"]);
  });

  it("keeps a form opened after cancelling an edit that was still saving", async () => {
    const save = Promise.withResolvers<void>();
    respond(async (url, init) => {
      if (init?.method === "PATCH") {
        await save.promise;
        return Response.json({ project: listed("site", "Site survey") });
      }
      if (url.pathname === "/api/projects/deleted")
        return Response.json({ canManage: true, projects: [] });
      return Response.json({
        canManage: true,
        projects: [listed("site", "Site walk")],
      });
    });
    const container = await renderList();
    await chooseFromRow("Site walk", "Edit");
    await fill(container.querySelector("form input"), "Site survey");
    await click(queryButton("Save changes", container));
    await click(queryButton("Cancel", container));
    await click(queryButton("New project", container));
    save.resolve();
    await settle();
    // The earlier save lands without closing the new project's form.
    expect(queryButton("Create project", container)).not.toBeNull();
  });

  it("says when Deleted projects cannot refresh after a deletion, and retries", async () => {
    let projects = [listed("site", "Site walk")];
    let deleted: ProjectSummary[] = [];
    let failing = false;
    respond(async (url, init) => {
      if (init?.method === "DELETE") {
        [deleted, projects, failing] = [projects, [], true];
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/projects/deleted")
        return failing
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({
              canManage: true,
              projects: deleted.map((project) => ({
                ...project,
                deletedAt: "2026-10-20T00:00:00.000Z",
              })),
            });
      return Response.json({ canManage: true, projects });
    });
    const container = await renderList();
    await chooseFromRow("Site walk", "Delete");
    await click("Delete project");
    await settle();
    // An earlier load found none, but the failed refresh still shows.
    expect(container.textContent).toContain("Deleted projects");
    expect(container.textContent).toContain("Unavailable");
    failing = false;
    await click(queryButton("Retry", container));
    await settle();
    expect(rowTitles(container, "Deleted projects")).toEqual(["Site walk"]);
  });

  it("says when deleted projects could not load, and retries", async () => {
    let failing = true;
    respond(async (url) => {
      if (url.pathname === "/api/projects/deleted")
        return failing
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({ canManage: true, projects: [] });
      return Response.json({ canManage: true, projects: [] });
    });
    const { container } = await mount(
      <Projects onNavigate={() => {}} pathname="/projects" />,
    );
    await settle();
    expect(container.textContent).toContain("Deleted projects");
    failing = false;
    await click(queryButton("Retry", container));
    await settle();
    expect(container.textContent).not.toContain("Deleted projects");
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
    expect(container.textContent).toContain("No global templates turned on");
    expect(container.textContent).toContain(
      "No organization templates turned on",
    );
    expect(writes).toEqual([]);
  });

  it("shows members the templates turned on, without switches", async () => {
    const walk = templates.filter((template) => template.id === "walk");
    stubApi(false, {}, { templateCount: 1, templates: walk });
    const container = await render();
    expect(collectionOf(container, "Site walk")).toBe("Organization templates");
    expect(container.textContent).not.toContain("NFPA 70E");
    expect(container.querySelector('input[role="switch"]')).toBeNull();
  });
});
