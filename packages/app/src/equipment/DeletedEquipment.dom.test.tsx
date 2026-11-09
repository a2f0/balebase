import { beforeAll, describe, expect, it } from "bun:test";
import type { DeletedEquipment as DeletedItem } from "@balebase/validators/equipment";
import { installDom } from "../testing/dom";

const { click, mount, respond, settle } = installDom({
  url: "http://localhost:5173/equipment",
});
let DeletedEquipment: typeof import("./DeletedEquipment").DeletedEquipment;

beforeAll(async () => {
  // Loaded once the window is installed: React DOM checks for it on load.
  ({ DeletedEquipment } = await import("./DeletedEquipment"));
});

const owner = { email: "owner@example.com", id: "owner", name: "Olivia" };
const laptop: DeletedItem = {
  assignee: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  deletedAt: "2026-10-20T00:00:00.000Z",
  deletedBy: owner,
  emailCount: 1,
  id: "laptop",
  make: "Apple",
  model: "MacBook Pro",
  purchaseDate: null,
  serialNumber: null,
  type: "computer",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** Serves the deleted list, holding each restore until `finish` runs. */
function serve() {
  const restore = Promise.withResolvers<void>();
  const requests: string[] = [];
  respond(async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/equipment/laptop/restore") {
      await restore.promise;
      const { deletedAt: _at, deletedBy: _by, ...equipment } = laptop;
      return Response.json({ equipment });
    }
    return Response.json({ canManage: true, equipment: [laptop] });
  });
  return { finish: restore.resolve, requests };
}

async function chooseRestore() {
  await click("Actions for Apple MacBook Pro");
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (entry) => entry.textContent === "Restore",
    ),
  );
}

describe("DeletedEquipment", () => {
  it("restores an item and opens it", async () => {
    const { finish, requests } = serve();
    const visited: string[] = [];
    const { container } = await mount(
      <DeletedEquipment onNavigate={(pathname) => visited.push(pathname)} />,
    );
    await settle();
    expect(container.textContent).toContain(`by ${owner.name}`);
    await chooseRestore();
    expect(visited).toEqual([]);
    finish();
    await settle();
    expect(requests).toContain("POST /api/equipment/laptop/restore");
    expect(visited).toEqual(["/equipment/laptop"]);
  });

  it("stays put when a restore finishes after the section closed", async () => {
    const { finish, requests } = serve();
    const visited: string[] = [];
    const { unmount } = await mount(
      <DeletedEquipment onNavigate={(pathname) => visited.push(pathname)} />,
    );
    await settle();
    await chooseRestore();
    await unmount();
    finish();
    await settle();
    expect(requests).toContain("POST /api/equipment/laptop/restore");
    expect(visited).toEqual([]);
  });
});
