import type { Database } from "bun:sqlite";
import { seedMember, seedUser } from "../src/testing/seed";

/**
 * The organization screenshot capture shows. Records go through the API's own
 * routes, so they carry the activity a real workspace would; only the
 * teammates, who never sign in, are written directly.
 */
const { SCREENSHOT_EMAIL, SCREENSHOT_PASSWORD } = process.env;
// The capture's config passes the owner's placeholder credentials.
const screenshotOwner = {
  email: SCREENSHOT_EMAIL ?? "jordan@harborline.example",
  name: "Jordan Avery",
  password: SCREENSHOT_PASSWORD ?? "screenshot capture password",
};

const organizationName = "Harborline Electric";

const teammates = [
  { id: "screenshot_priya", name: "Priya Natarajan", role: "admin" },
  { id: "screenshot_marcus", name: "Marcus Bell", role: "member" },
  { id: "screenshot_elena", name: "Elena Ruiz", role: "member" },
] as const;

const projects = [
  {
    name: "Riverside Clinic retrofit",
    description:
      "Panel upgrades and arc-flash labeling across the clinic's three floors.",
    members: ["screenshot_priya", "screenshot_marcus"],
    forms: ["nfpa70e_global"],
  },
  {
    name: "Oak Street apartments",
    description: "Residential inspections for the 24-unit renovation.",
    members: ["screenshot_elena"],
    forms: ["us_residential_core_global"],
  },
  {
    name: "Warehouse 7 lighting",
    description: "LED conversion and emergency lighting tests.",
    members: [],
    forms: [],
  },
] as const;

const issues = [
  {
    title: "Replace corroded breaker in panel 2B",
    priority: "critical",
    assignedTo: "screenshot_marcus",
    description: "Found during the second-floor walkthrough; panel tagged out.",
  },
  {
    title: "Missing arc-flash labels on east switchgear",
    priority: "high",
    assignedTo: "screenshot_priya",
    description: "Labels need the updated incident energy values.",
  },
  {
    title: "Confirm GFCI coverage in unit 14 kitchen",
    priority: "medium",
    assignedTo: "screenshot_elena",
    description: "",
  },
  {
    title: "Order spare emergency ballast kits",
    priority: "low",
    assignedTo: null,
    description: "Six kits for the warehouse aisle fixtures.",
  },
] as const;

const equipment = [
  {
    type: "computer",
    make: "Lenovo",
    model: "ThinkPad X1 Carbon Gen 13",
    serialNumber: "PF4KX2Q9",
    purchaseDate: "2026-02-14",
    assigneeId: "screenshot_priya",
  },
  {
    type: "cell_phone",
    make: "Apple",
    model: "iPhone 17 Pro",
    serialNumber: "F2LZQ8H1N7",
    purchaseDate: "2026-09-22",
    assigneeId: "screenshot_marcus",
  },
  {
    type: "monitor",
    make: "Dell",
    model: "UltraSharp U2725QE",
    serialNumber: "CN-0X7G2M",
    purchaseDate: "2025-11-03",
    assigneeId: null,
  },
  {
    type: "cell_phone",
    make: "Samsung",
    model: "Galaxy S26",
    serialNumber: "R5CY31KQ8ZT",
    purchaseDate: "2026-05-30",
    assigneeId: "screenshot_elena",
  },
] as const;

const businesses = [
  {
    name: "Harborline Electric LLC",
    ein: "84-2917365",
    streetAddress: "410 Wharf Road",
    city: "Portland",
    state: "ME",
    zip: "04101",
    incorporationDate: "2019-04-08",
  },
  {
    name: "Harborline Field Services Inc.",
    ein: "87-5520194",
    streetAddress: "18 Commercial Street",
    city: "Portland",
    state: "ME",
    zip: "04101",
    incorporationDate: "2023-01-17",
  },
] as const;

type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** Seeds the capture's organization, failing on any refused request. */
export async function seedScreenshotData({
  database,
  request,
}: {
  database: Database;
  request: Request;
}) {
  const send = sender(request);
  await send("POST", "/api/auth/sign-up/email", {
    ...screenshotOwner,
    termsAccepted: true,
  });
  const owner = database
    .query(
      `SELECT user.id AS userId, member.organizationId
       FROM user JOIN member ON member.userId = user.id
       WHERE user.email = ?`,
    )
    .get(screenshotOwner.email) as { organizationId: string; userId: string };
  database
    .query("UPDATE user SET emailVerified = 1 WHERE id = ?")
    .run(owner.userId);
  database
    .query("UPDATE organization SET name = ? WHERE id = ?")
    .run(organizationName, owner.organizationId);
  for (const teammate of teammates) {
    seedUser(database, {
      id: teammate.id,
      name: teammate.name,
      email: `${teammate.id.replace("screenshot_", "")}@harborline.example`,
      defaultOrganizationId: owner.organizationId,
    });
    seedMember(database, {
      organizationId: owner.organizationId,
      userId: teammate.id,
      role: teammate.role,
    });
  }
  await send("POST", "/api/auth/sign-in/email", {
    email: screenshotOwner.email,
    password: screenshotOwner.password,
  });
  await seedRecords(send);
}

async function seedRecords(send: Sender) {
  for (const project of projects) {
    const { project: created } = await send<{ project: { id: string } }>(
      "POST",
      "/api/projects",
      { name: project.name, description: project.description },
    );
    for (const userId of project.members)
      await send("PUT", `/api/projects/${created.id}/members/${userId}`);
    for (const templateId of project.forms)
      await send("PUT", `/api/projects/${created.id}/forms/${templateId}`);
  }
  for (const issue of issues) await send("POST", "/api/issues", issue);
  for (const item of equipment) await send("POST", "/api/equipment", item);
  for (const business of businesses)
    await send("POST", "/api/businesses", business);
  await send("POST", "/api/audits/templates/nfpa70e_global/runs");
}

type Sender = ReturnType<typeof sender>;

/** Sends JSON requests with the session the sign-in set. */
function sender(request: Request) {
  let cookie = "";
  return async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length)
      cookie = setCookie.map((value) => value.split(";", 1)[0]).join("; ");
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}
