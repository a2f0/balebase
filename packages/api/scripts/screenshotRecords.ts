import path from "node:path";
import {
  type ContinuityIssue,
  continuity,
  genesisFile,
  person,
} from "./continuity";
import { plaidPublicToken, type SentMessage } from "./screenshotServices";

/**
 * The continuity records, as dated steps the seed runs in canon order. Each
 * step acts through the API as the person canon names.
 */

/** Sends JSON, a form, or a file as one person, failing on any refusal. */
export type Sender = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

export interface StepContext {
  /** A sender signed in as the person with this canon ID. */
  as: (personId: string) => Promise<Sender>;
  /** A sender with no session, for public signing links. */
  anonymous: Sender;
  /** The API's user ID for a canon person. */
  userId: (personId: string) => string;
  /** IDs the API gave records, by `<kind>:<canon id>`. */
  ids: Map<string, string>;
  outbox: SentMessage[];
}

export interface Step {
  day: string;
  run: (context: StepContext) => Promise<void>;
}

const { asOf, organization, people } = continuity;
// The office manager keeps the books, the equipment, and the library.
const officeManager =
  people.find((candidate) => candidate.role === "admin")?.id ??
  organization.owner;

export function recordSteps(): Step[] {
  return [
    ...groupSteps(),
    ...businessSteps(),
    ...equipmentSteps(),
    ...projectSteps(),
    ...auditSteps(),
    ...issueSteps(),
    ...financeSteps(),
    ...contractSteps(),
    ...librarySteps(),
  ];
}

function latest(days: (string | null | undefined)[]) {
  return (
    days
      .filter((day): day is string => Boolean(day))
      .sort()
      .at(-1) ?? asOf
  );
}

function idOf(context: StepContext, key: string) {
  const id = context.ids.get(key);
  if (!id) throw new Error(`The seed has not created ${key} yet.`);
  return id;
}

/** Groups form once their last member has joined. */
function groupSteps(): Step[] {
  return continuity.groups.map((group) => ({
    day: latest(group.members.map((id) => person(id).joinedOn)),
    run: async (context) => {
      const send = await context.as(organization.owner);
      const body = {
        capabilities: group.capabilities,
        name: group.name,
        userIds: group.members.map(context.userId),
      };
      if (!group.builtIn) {
        await send("POST", "/api/organization-groups", body);
        return;
      }
      const { groups } = await send<{
        groups: { builtIn: string | null; id: string }[];
      }>("GET", "/api/organization-groups");
      const builtIn = groups.find(({ builtIn }) => builtIn === group.builtIn);
      if (!builtIn) throw new Error(`No built-in ${group.builtIn} group.`);
      await send("PATCH", `/api/organization-groups/${builtIn.id}`, body);
    },
  }));
}

function businessSteps(): Step[] {
  return continuity.businesses.map((business) => ({
    day: latest([
      business.incorporationDate,
      person(organization.owner).joinedOn,
    ]),
    run: async (context) => {
      const send = await context.as(organization.owner);
      await send("POST", "/api/businesses", business);
    },
  }));
}

function equipmentSteps(): Step[] {
  return continuity.equipment.map(({ assignee, ...item }) => ({
    day: item.purchaseDate,
    run: async (context) => {
      const send = await context.as(officeManager);
      await send("POST", "/api/equipment", {
        assigneeId: assignee ? context.userId(assignee) : null,
        make: item.make,
        model: item.model,
        purchaseDate: item.purchaseDate,
        serialNumber: item.serialNumber,
        type: item.type,
      });
    },
  }));
}

function projectSteps(): Step[] {
  return continuity.projects.map((project) => ({
    day: project.startedOn,
    run: async (context) => {
      const send = await context.as(organization.owner);
      const { project: created } = await send<{ project: { id: string } }>(
        "POST",
        "/api/projects",
        { description: project.description, name: project.name },
      );
      context.ids.set(`project:${project.id}`, created.id);
      for (const member of project.members)
        await send(
          "PUT",
          `/api/projects/${created.id}/members/${context.userId(member)}`,
        );
      for (const form of project.forms)
        await send("PUT", `/api/projects/${created.id}/forms/${form}`);
    },
  }));
}

interface AuditRun {
  audit: {
    definition: {
      sections: {
        items: { id: string; responseType: "check" | "text" }[];
      }[];
    };
    revision: number;
  };
}

/** The issues an audit raised, each on its own checklist item. */
function auditIssues(auditId: string) {
  return continuity.issues.filter((issue) => issue.audit === auditId);
}

function checkItems(run: AuditRun) {
  return run.audit.definition.sections.flatMap((section) =>
    section.items.filter((item) => item.responseType === "check"),
  );
}

/**
 * Starts each audit, answers it, and completes the finished ones. Answers
 * fail the items its issues are about and pass the rest; an audit still in
 * progress has only its first section answered.
 */
function auditSteps(): Step[] {
  return continuity.audits.flatMap((audit) => {
    const answer = async (context: StepContext, complete: boolean) => {
      const send = await context.as(audit.startedBy);
      const id = idOf(context, `audit:${audit.id}`);
      const run = await send<AuditRun>("GET", `/api/audits/runs/${id}`);
      const failed = new Set(
        checkItems(run)
          .slice(0, auditIssues(audit.id).length)
          .map((item) => item.id),
      );
      const sections = run.audit.definition.sections;
      const answered = complete ? sections : sections.slice(0, 1);
      const responses = Object.fromEntries(
        answered.flatMap((section) =>
          section.items.map((item) => [
            item.id,
            item.responseType === "text"
              ? "Checked on site."
              : failed.has(item.id)
                ? "fail"
                : "pass",
          ]),
        ),
      );
      await send("PATCH", `/api/audits/runs/${id}`, {
        expectedRevision: run.audit.revision,
        responses,
        ...(complete ? { status: "completed" } : {}),
      });
    };
    const start: Step = {
      day: audit.startedOn,
      run: async (context) => {
        const send = await context.as(audit.startedBy);
        const { auditId } = await send<{ auditId: string }>(
          "POST",
          `/api/audits/templates/${audit.form}/runs`,
        );
        context.ids.set(`audit:${audit.id}`, auditId);
        if (audit.status === "in_progress") await answer(context, false);
      },
    };
    if (audit.status !== "completed") return [start];
    return [
      start,
      {
        day: audit.completedOn ?? asOf,
        run: (context) => answer(context, true),
      },
    ];
  });
}

/**
 * Raises each issue on its day: audit issues on their checklist item with
 * their site photo, workspace issues on the issue list. Resolved ones are
 * resolved by their assignee on the day canon gives.
 */
function issueSteps(): Step[] {
  // Listed after the audits, so an issue raised on its audit's first or last
  // day comes after the start and before the completion.
  return continuity.issues.flatMap((issue) => {
    const raise: Step = {
      day: issue.raisedOn,
      run: (context) =>
        issue.audit
          ? raiseAuditIssue(context, issue)
          : raiseIssue(context, issue),
    };
    if (issue.status !== "resolved") return [raise];
    return [
      raise,
      {
        day: issue.resolvedOn ?? asOf,
        run: (context) => resolveIssue(context, issue),
      },
    ];
  });
}

function issueFields(context: StepContext, issue: ContinuityIssue) {
  return {
    assignedTo: issue.assignee ? context.userId(issue.assignee) : null,
    description: issue.description,
    priority: issue.priority,
    title: issue.title,
  };
}

async function raiseIssue(context: StepContext, issue: ContinuityIssue) {
  const send = await context.as(issue.createdBy);
  const { issueId } = await send<{ issueId: string }>(
    "POST",
    "/api/issues",
    issueFields(context, issue),
  );
  context.ids.set(`issue:${issue.title}`, issueId);
}

async function raiseAuditIssue(context: StepContext, issue: ContinuityIssue) {
  const send = await context.as(issue.createdBy);
  const auditId = idOf(context, `audit:${issue.audit}`);
  const run = await send<AuditRun>("GET", `/api/audits/runs/${auditId}`);
  const position = auditIssues(issue.audit ?? "").indexOf(issue);
  const item = checkItems(run)[position];
  if (!item)
    throw new Error(`The audit has no checklist item for ${issue.title}.`);
  const { issueId } = await send<{ issueId: string }>(
    "POST",
    `/api/audits/runs/${auditId}/issues`,
    { ...issueFields(context, issue), itemId: item.id },
  );
  context.ids.set(`issue:${issue.title}`, issueId);
  if (!issue.photo) return;
  const filename = path.basename(issue.photo);
  await send(
    "POST",
    `/api/audits/issues/${issueId}/images?filename=${encodeURIComponent(filename)}`,
    new Blob([genesisFile(issue.photo)], { type: "image/jpeg" }),
  );
}

async function resolveIssue(context: StepContext, issue: ContinuityIssue) {
  const send = await context.as(issue.assignee ?? issue.createdBy);
  const id = idOf(context, `issue:${issue.title}`);
  if (issue.audit) {
    await send("PATCH", `/api/audits/issues/${id}`, { status: "resolved" });
    return;
  }
  const { issue: current } = await send<{ issue: { revision: number } }>(
    "GET",
    `/api/issues/${id}`,
  );
  await send("PATCH", `/api/issues/${id}`, {
    expectedRevision: current.revision,
    status: "resolved",
  });
}

/**
 * Connects the bank through Plaid Link's exchange (answered by the fake Plaid
 * in screenshotServices.ts), syncs its feed, then files each transaction under
 * its category with its note and review mark, as the office manager would.
 */
function financeSteps(): Step[] {
  const { accounts, categories, transactions } = continuity.finance;
  return [
    {
      day: asOf,
      run: async (context) => {
        const send = await context.as(organization.owner);
        const { connectionId } = await send<{ connectionId: string }>(
          "POST",
          "/api/finance/exchange",
          {
            institutionName: accounts[0]?.institution ?? null,
            publicToken: plaidPublicToken,
          },
        );
        await send("POST", `/api/finance/connections/${connectionId}/sync`);
      },
    },
    {
      day: asOf,
      run: async (context) => {
        const send = await context.as(officeManager);
        const categoryIds = new Map<string, string>();
        for (const category of categories) {
          const { category: created } = await send<{
            category: { id: string };
          }>("POST", "/api/finance/categories", { name: category.name });
          categoryIds.set(category.id, created.id);
        }
        const listed = await listTransactions(send);
        for (const transaction of transactions) {
          const record = listed.find(
            (candidate) =>
              candidate.transactionDate === transaction.date &&
              candidate.name === transaction.name &&
              candidate.amount === transaction.amount,
          );
          if (!record) throw new Error(`No synced ${transaction.id}.`);
          await send("PUT", `/api/finance/transactions/${record.id}/category`, {
            categoryId: categoryIds.get(transaction.category) ?? null,
          });
          if (transaction.note || transaction.reviewed)
            await send(
              "PATCH",
              `/api/finance/transactions/${record.id}/annotation`,
              {
                labels: [],
                note: transaction.note,
                reviewed: transaction.reviewed,
              },
            );
        }
      },
    },
  ];
}

interface ListedTransaction {
  amount: number;
  transactionDate: string;
  id: string;
  name: string;
}

async function listTransactions(send: Sender) {
  const listed: ListedTransaction[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page: {
      nextCursor: string | null;
      transactions: ListedTransaction[];
    } = await send("GET", `/api/finance${query}`);
    listed.push(...page.transactions);
    cursor = page.nextCursor;
  } while (cursor);
  return listed;
}

// A tiny transparent PNG stands in for each adopted signature.
const signatureImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0ABQHsHwEAAAAASUVORK5CYII=";

/**
 * Uploads each contract's PDF, places one signature and date per signer, and
 * sends the ones canon sent. Signers who signed follow the link the API
 * emailed them, in routing order.
 */
function contractSteps(): Step[] {
  return continuity.contracts.flatMap((contract) => {
    const sentOn = contract.sentOn ?? asOf;
    const prepare: Step = {
      day: sentOn,
      run: async (context) => {
        const send = await context.as(organization.owner);
        const form = new FormData();
        form.set(
          "file",
          new File(
            [genesisFile(contract.document.file)],
            contract.document.filename,
            { type: "application/pdf" },
          ),
        );
        const { contract: created } = await send<{ contract: { id: string } }>(
          "POST",
          "/api/contracts",
          form,
        );
        context.ids.set(`contract:${contract.title}`, created.id);
        await send("PUT", `/api/contracts/${created.id}/draft`, {
          dueDate: contract.dueOn,
          fields: contract.signers.flatMap((signer, index) => [
            signatureField(signer.person, index, "signature"),
            signatureField(signer.person, index, "date_signed"),
          ]),
          message: "",
          recipients: contract.signers.map((signer) => ({
            email: signer.email,
            key: signer.person,
            name: signer.name,
            routingOrder: signer.routingOrder,
          })),
          reminderIntervalDays: null,
          signingOrder: "sequential",
          title: contract.title,
        });
        if (contract.status !== "draft")
          await send("POST", `/api/contracts/${created.id}/send`);
      },
    };
    const signatures: Step[] = contract.signers
      .filter((signer) => signer.status === "signed")
      .sort((a, b) => a.routingOrder - b.routingOrder)
      .map((signer) => ({
        day:
          signer.routingOrder === 1 ? sentOn : (contract.completedOn ?? sentOn),
        run: async (context) => {
          const token = signingToken(context.outbox, signer.email);
          await context.anonymous("POST", `/api/signing/${token}/sign`, {
            consent: true,
            signature: signatureImage,
          });
        },
      }));
    return [prepare, ...signatures];
  });
}

/** A field near the foot of page one, one row per signer. */
function signatureField(
  recipientKey: string,
  row: number,
  type: "date_signed" | "signature",
) {
  const signature = type === "signature";
  return {
    height: 0.04,
    page: 1,
    recipientKey,
    type,
    width: signature ? 0.3 : 0.2,
    x: signature ? 0.1 : 0.5,
    y: 0.8 + row * 0.06,
  };
}

/** The token in the newest signing link emailed to this address. */
function signingToken(outbox: SentMessage[], email: string) {
  for (const message of [...outbox].reverse()) {
    if (message.to !== email) continue;
    const match = message.text.match(/\/sign\/([^\s/?#]+)/);
    if (match?.[1]) return match[1];
  }
  throw new Error(`No signing link was emailed to ${email}.`);
}

/** The office manager files the shared documents in their folders. */
function librarySteps(): Step[] {
  const { documents, folders } = continuity.library;
  return [
    {
      day: asOf,
      run: async (context) => {
        const send = await context.as(officeManager);
        for (const folder of folders) {
          const { folder: created } = await send<{ folder: { id: string } }>(
            "POST",
            "/api/library/folders",
            { name: folder.name },
          );
          for (const document of documents.filter(
            ({ folder: id }) => id === folder.id,
          )) {
            const form = new FormData();
            form.set(
              "file",
              new File([genesisFile(document.file)], document.filename, {
                type: "application/pdf",
              }),
            );
            form.set("folderId", created.id);
            await send("POST", "/api/objects", form);
          }
        }
      },
    },
  ];
}
