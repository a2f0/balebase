import { afterAll, beforeAll, expect, test } from "bun:test";
import { continuity } from "./continuity";
import { seededScreenshotApi } from "./screenshotApi";

// The seed that screenshot capture runs, replayed in-process: capture itself
// runs outside every suite, so this is what notices a route or canon change
// that breaks it or leaves a record out.
let api: Awaited<ReturnType<typeof seededScreenshotApi>>;

beforeAll(async () => {
  api = await seededScreenshotApi({
    api: "http://127.0.0.1:34010",
    app: "http://127.0.0.1:34020",
  });
}, 60_000);

afterAll(() => api?.restore());

function rows<T>(sql: string, ...params: string[]) {
  return api.database.query(sql).all(...params) as T[];
}

test("the canon's seated people are members with their roles", () => {
  const members = rows<{ email: string; role: string }>(
    `SELECT user.email, member.role FROM member
     JOIN user ON user.id = member.userId ORDER BY user.email`,
  );
  expect(members).toEqual(
    continuity.people
      .filter((person) => person.role)
      .map(({ email, role }) => ({ email, role: role ?? "" }))
      .toSorted((a, b) => a.email.localeCompare(b.email)),
  );
  const groups = rows<{ name: string; members: string }>(
    `SELECT team.name, group_concat(user.email, ',') AS members
     FROM team JOIN teamMember ON teamMember.teamId = team.id
     JOIN user ON user.id = teamMember.userId
     GROUP BY team.id ORDER BY team.name`,
  );
  expect(groups.map(({ name }) => name)).toEqual(["Field crew", "Finance"]);
  expect(groups[1]?.members.split(",").toSorted()).toEqual([
    "dana@harborline.example.com",
    "jordan@harborline.example.com",
  ]);
});

test("records happen on their canon day, sent by the person canon names", () => {
  const [project] = rows<{ created_at: string; name: string }>(
    "SELECT name, created_at FROM projects ORDER BY created_at LIMIT 1",
  );
  expect(project?.name).toBe("Riverside Clinic retrofit");
  // Noon in Merrow Bay on the canon's start day, after the owner signs in.
  expect(project?.created_at).toStartWith("2026-08-24T19:0");
  const issues = rows<{ creator: string; title: string }>(
    `SELECT issues.title, user.name AS creator FROM issues
     JOIN user ON user.id = issues.created_by ORDER BY issues.title`,
  );
  expect(issues).toHaveLength(continuity.issues.length);
  expect(issues).toContainEqual({
    creator: "Luis Ferreira",
    title: "Replace corroded breaker in panel 2B",
  });
});

test("audits fail the items their issues name and carry the site photos", () => {
  const audits = rows<{ status: string; template_name: string }>(
    "SELECT template_name, status FROM audits ORDER BY created_at",
  );
  expect(audits.map(({ status }) => status)).toEqual([
    "completed",
    "in_progress",
  ]);
  const findings = rows<{ item_id: string; photos: number; status: string }>(
    `SELECT issues.item_id, issues.status, COUNT(audit_issue_images.id) AS photos
     FROM issues LEFT JOIN audit_issue_images
       ON audit_issue_images.issue_id = issues.id
     WHERE issues.target_type = 'audit_run'
     GROUP BY issues.id ORDER BY issues.item_id`,
  );
  expect(findings).toEqual([
    { item_id: "protection-3", photos: 1, status: "open" },
    { item_id: "res-elec-011", photos: 1, status: "open" },
    { item_id: "review-1", photos: 1, status: "open" },
  ]);
  for (const { responses } of rows<{ responses: string }>(
    "SELECT responses FROM audits",
  ))
    expect(Object.values(JSON.parse(responses))).toContain("fail");
});

test("the bank feed is synced, filed under its categories, and reviewed", () => {
  const { transactions } = continuity.finance;
  const filed = rows<{ category: string; note: string; reviewed: number }>(
    `SELECT category.name AS category, annotation.note, annotation.reviewed
     FROM plaid_transactions AS txn
     JOIN finance_transaction_annotations AS annotation
       ON annotation.transaction_id = txn.id
     JOIN finance_expense_categories AS category
       ON category.id = annotation.expense_category_id`,
  );
  expect(filed).toHaveLength(transactions.length);
  expect(filed.filter(({ reviewed }) => reviewed)).toHaveLength(
    transactions.filter(({ reviewed }) => reviewed).length,
  );
  expect(filed.map(({ note }) => note)).toContain(
    "Riverside panel breakers and arc-flash label stock",
  );
});

test("contracts reach their canon status through the signing links", () => {
  const contracts = rows<{ signed: number; status: string; title: string }>(
    `SELECT contracts.title, contracts.status,
       SUM(contract_recipients.status = 'signed') AS signed
     FROM contracts JOIN contract_recipients
       ON contract_recipients.contract_id = contracts.id
     GROUP BY contracts.id ORDER BY contracts.title`,
  );
  expect(contracts).toEqual([
    { signed: 1, status: "sent", title: "Oak Street inspection services" },
    {
      signed: 2,
      status: "completed",
      title: "Riverside Clinic retrofit agreement",
    },
    {
      signed: 0,
      status: "draft",
      title: "Warehouse 7 LED conversion proposal",
    },
  ]);
});

test("the library holds each canon document in its folder", () => {
  const documents = rows<{ filename: string; folder: string }>(
    `SELECT objects.filename, library_folders.name AS folder FROM objects
     JOIN library_folders ON library_folders.id = objects.folder_id
     WHERE objects.kind = 'library' ORDER BY objects.filename`,
  );
  expect(documents).toEqual([
    { filename: "certificate-of-insurance-2026.pdf", folder: "Insurance" },
    { filename: "electrical-safety-program.pdf", folder: "Safety" },
    { filename: "vehicle-inspection-checklist.pdf", folder: "Fleet" },
  ]);
});
