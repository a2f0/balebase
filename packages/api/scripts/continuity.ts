import { readFileSync } from "node:fs";
import path from "node:path";
import seed from "@a2f0/balebase-continuity/genesis/balebase/seed.json";

/**
 * The Balebase genesis of a2f0/balebase-continuity, pinned in this package's
 * devDependencies: one fictional electrical contractor whose people, records,
 * photos, and PDFs agree with one another. The contract is that repository's
 * `docs/balebase.md`; only the fields the screenshot seed uses are typed here.
 */
const seedPath = Bun.resolveSync(
  "@a2f0/balebase-continuity/genesis/balebase/seed.json",
  import.meta.dir,
);
// File values in the seed are paths under genesis/.
const genesisRoot = path.resolve(path.dirname(seedPath), "..");

type Day = string;

interface Person {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "owner" | null;
  joinedOn: Day | null;
}

interface Issue {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "low" | "medium";
  status: "open" | "resolved";
  createdBy: string;
  assignee: string | null;
  raisedOn: Day;
  resolvedOn: Day | null;
  audit: string | null;
  photo: string | null;
}

interface Document {
  file: string;
  filename: string;
}

interface Signer {
  person: string;
  name: string;
  email: string;
  routingOrder: number;
  status: "pending" | "sent" | "signed";
}

export interface ContinuitySeed {
  schemaVersion: number;
  asOf: Day;
  organization: { name: string; owner: string };
  people: Person[];
  groups: {
    name: string;
    builtIn: "finance" | null;
    capabilities: "finance"[];
    members: string[];
  }[];
  businesses: { name: string; incorporationDate: Day }[];
  equipment: {
    type: string;
    make: string;
    model: string;
    serialNumber: string;
    purchaseDate: Day;
    assignee: string | null;
  }[];
  projects: {
    id: string;
    name: string;
    description: string;
    startedOn: Day;
    members: string[];
    forms: string[];
  }[];
  audits: {
    id: string;
    project: string;
    form: string;
    startedBy: string;
    startedOn: Day;
    status: "completed" | "in_progress";
    completedOn: Day | null;
  }[];
  issues: Issue[];
  finance: {
    accounts: {
      id: string;
      institution: string;
      name: string;
      officialName: string;
      mask: string;
      type: string;
      subtype: string;
      currencyCode: string;
      currentBalance: number;
    }[];
    categories: { id: string; name: string }[];
    transactions: {
      id: string;
      account: string;
      date: Day;
      name: string;
      merchantName: string;
      amount: number;
      currencyCode: string;
      category: string;
      note: string;
      reviewed: boolean;
    }[];
  };
  contracts: {
    title: string;
    status: "completed" | "draft" | "sent";
    sentOn: Day | null;
    dueOn: Day | null;
    completedOn: Day | null;
    signers: Signer[];
    document: Document;
  }[];
  library: {
    folders: { id: string; name: string }[];
    documents: (Document & { folder: string })[];
  };
}

export type ContinuityIssue = Issue;

export const continuity = seed as unknown as ContinuitySeed;

// Version 1 is the only contract this seed understands; a later one may have
// removed a field or changed what one means.
if (continuity.schemaVersion !== 1)
  throw new Error(
    `The continuity seed has schema version ${continuity.schemaVersion}; the screenshot seed reads version 1.`,
  );

/** A file the seed names, such as a photo or a contract PDF. */
export function genesisFile(file: string) {
  const resolved = path.resolve(genesisRoot, file);
  if (!resolved.startsWith(`${genesisRoot}${path.sep}`))
    throw new Error(
      `The continuity seed names a file outside genesis: ${file}`,
    );
  return new Uint8Array(readFileSync(resolved));
}

/** The person with this canon ID, failing on an unknown one. */
export function person(id: string) {
  const found = continuity.people.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`The continuity seed has no person ${id}.`);
  return found;
}
