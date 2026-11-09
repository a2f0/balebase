import { beforeAll, describe, expect, it } from "bun:test";
import { productName } from "@balebase/ui/brand";
import { DialogHost } from "@balebase/ui/react";
import type {
  Project,
  ProjectForm,
  ProjectSummary,
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

/** A device workspace holding `audits`, with the jobs that sync them. */
function deviceWith(
  audits: OfflineWorkspace["audits"],
  jobs: OfflineWorkspace["jobs"] = [],
): DeviceState {
  return {
    error: undefined,
    online: true,
    workspace: {
      audits,
      forms: [],
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

/** Chooses `item` from the menu of the row titled `name`. */
async function chooseFromRow(name: string, item: string) {
  await click(`Actions for ${name}`);
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (entry) => entry.textContent === item,
    ),
  );
}

describe("project detail", () => {
  it("shows members, audit forms, setup, and activity on separate tabs", async () => {
    const { writes } = stubApi(true);
    const container = await render();
    const strip = container.querySelector(
      '[role="tablist"][aria-label="Project sections"]',
    );
    const tabs = [...(strip?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Members",
      "Audit forms",
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
    await click(queryButton("Audit forms", container));
    expect(shown()).toEqual(["Audit forms"]);
    await click(queryButton("Project setup", container));
    expect(shown()).toEqual(["Project setup"]);
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

    await chooseFromRow("Sam", "Remove from project");
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

    const setup = toggle(container, "Site walk")?.closest('[role="tabpanel"]');
    await click(queryButton("List", setup as HTMLElement));
    const row = toggle(container, "Site walk")?.closest(".auditTemplateRow");
    expect(row?.textContent).toContain("Site walk checklist");
    expect(collectionOf(container, "NFPA 70E")).toBe("Global forms");
  });

  it("starts audits from the forms turned on for the project", async () => {
    const walk = forms.filter((form) => form.id === "walk");
    stubApi(false, {}, { formCount: 1, forms: walk });
    const container = await render();
    const panel = await openTab(container, "Audit forms");
    expect(collectionOf(panel, "Site walk")).toBe("Organization forms");
    expect(panel.textContent).not.toContain("NFPA 70E");
    expect(panel.querySelector('input[role="switch"]')).toBeNull();
    expect(panel.textContent).toContain("No audits on this device");
    // Without a device workspace (not yet prepared) nothing starts.
    await click(queryButton("Start audit", panel));
    await settle();
    expect(panel.textContent).toContain(
      "This device is still getting ready for audits.",
    );
  });

  it("lists the audits this device started for the project", async () => {
    stubApi(false);
    const [walk] = forms;
    if (!walk) throw new Error("Missing form.");
    const started = (id: string, projectId: string, queued: boolean) => ({
      id,
      projectId,
      queued,
      responses: {},
      startedAt: `2026-10-0${id.length}T00:00:00.000Z`,
      template: walk,
    });
    const job = (
      id: string,
      status: OfflineWorkspace["jobs"][number]["status"],
      error?: string,
    ) => ({
      attempts: 1,
      dependsOn: [],
      id,
      operation: { id, type: "image" as const, filename: "", issueId: "" },
      retryAt: 0,
      status,
      ...(error ? { error } : {}),
    });
    const visited: string[] = [];
    const container = await render(
      deviceWith(
        [
          started("d", "project-1", false),
          started("ww", "project-1", true),
          started("sss", "project-1", true),
          started("other", "project-2", false),
        ],
        [job("ww", "blocked", "Form gone"), job("sss", "synced")],
      ),
      (pathname) => visited.push(pathname),
    );
    const panel = await openTab(container, "Audit forms");
    const rows = [...panel.querySelectorAll(".rowList .row")].map(
      (row) => row.textContent,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Synced");
    expect(rows[1]).toContain("Not synced");
    expect(rows[1]).toContain("Form gone");
    expect(rows[2]).toContain("Draft");
    for (const label of ["Open audit", "View", "Continue"])
      await click(queryButton(label, panel));
    await settle();
    expect(visited).toEqual([
      "/audits/runs/sss",
      "/projects/project-1/audits/ww",
      "/projects/project-1/audits/d",
    ]);
  });

  it("counts an audit synced only once its issues and photos are", async () => {
    stubApi(false);
    const [walk] = forms;
    if (!walk) throw new Error("Missing form.");
    const job = (
      id: string,
      status: OfflineWorkspace["jobs"][number]["status"],
      error?: string,
    ) => ({
      attempts: 1,
      dependsOn: [],
      id,
      operation: { id, type: "image" as const, filename: "", issueId: "" },
      retryAt: 0,
      status,
      ...(error ? { error } : {}),
    });
    const device = deviceWith(
      [
        {
          id: "audit",
          projectId: "project-1",
          queued: true,
          responses: {},
          startedAt: "2026-10-01T00:00:00.000Z",
          template: walk,
        },
      ],
      [
        job("audit", "synced"),
        job("issue", "synced"),
        job("photo", "blocked", "Photo refused"),
      ],
    );
    const workspace = device.workspace;
    if (!workspace) throw new Error("Missing workspace.");
    workspace.issues = [
      {
        images: [{ filename: "a.png", id: "photo" }],
        operation: {
          assignedTo: null,
          auditId: "audit",
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
    const panel = await openTab(container, "Audit forms");
    const row = panel.querySelector(".rowList .row")?.textContent;
    expect(row).toContain("Not synced");
    expect(row).toContain("Photo refused");
    await click(queryButton("View", panel));
    expect(visited).toEqual(["/projects/project-1/audits/audit"]);
  });

  it("shows the device's copy when the API cannot be reached", async () => {
    const [walk] = forms;
    if (!walk) throw new Error("Missing form.");
    respond(async () =>
      Response.json({ error: "Unavailable" }, { status: 503 }),
    );
    const device = deviceWith([]);
    const workspace = device.workspace;
    if (!workspace) throw new Error("Missing workspace.");
    workspace.projects = [
      { description: "", formIds: ["walk"], id: "project-1", name: "Site" },
    ];
    workspace.forms = [walk];
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
        expect(queryButton("Start audit", container)).toBeTruthy();
    }
  });

  it("keeps audits for projects the device no longer lists within reach", async () => {
    const [walk] = forms;
    if (!walk) throw new Error("Missing form.");
    respond(async () => Response.json({ canManage: false, projects: [] }));
    const visited: string[] = [];
    const device = deviceWith([
      {
        id: "left-behind",
        projectId: "deleted-project",
        queued: false,
        responses: {},
        startedAt: "2026-10-01T00:00:00.000Z",
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
    expect(container.textContent).toContain("Other audits on this device");
    await click(queryButton("Continue", container));
    expect(visited).toEqual(["/projects/deleted-project/audits/left-behind"]);
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

  it("lets a manager edit and delete projects from their rows' menus", async () => {
    const summary = (id: string, name: string): ProjectSummary => ({
      createdAt: "2026-10-01T00:00:00.000Z",
      description: "North wing",
      formCount: 1,
      id,
      isMember: false,
      memberCount: 2,
      name,
      revision: 3,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    let projects = [summary("site", "Site walk"), summary("clinic", "Clinic")];
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
        return Response.json({ project: summary("site", change.name) });
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
    const { container } = await mount(
      <>
        <Projects onNavigate={() => {}} pathname="/projects" />
        <DialogHost />
      </>,
    );
    await settle();
    /** The row titles under the section headed `heading`. */
    const titles = (heading: string) =>
      [
        ...([...container.querySelectorAll("section")]
          .find(
            (section) =>
              section.querySelector(".sectionTitle")?.textContent === heading,
          )
          ?.querySelectorAll(".rowTitle") ?? []),
      ].map((title) => title.textContent);
    expect(titles("All projects")).toEqual(["Site walk", "Clinic"]);
    expect(titles("Deleted projects")).toEqual([]);

    await chooseFromRow("Site walk", "Edit");
    expect(queryButton("New project", container)).toBeNull();
    await fill(container.querySelector("form input"), "Site survey");
    await click(queryButton("Save changes", container));
    await settle();
    // Only the name changed, from the revision the list showed.
    expect(changes).toEqual([{ expectedRevision: 3, name: "Site survey" }]);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Project updated.");
    expect(titles("All projects")).toEqual(["Site survey", "Clinic"]);

    await chooseFromRow("Clinic", "Delete");
    await click("Delete project");
    await settle();
    // The project leaves the list for Deleted projects.
    expect(titles("All projects")).toEqual(["Site survey"]);
    expect(titles("Deleted projects")).toEqual(["Clinic"]);
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
