import type { ActivityEvent } from "@balebase/validators/activity";
import { textValue } from "./activityLabels";

/** Library, inbox, and business events, whatever record they are on. */
export function isLibraryActivity({ action }: ActivityEvent) {
  return (
    action.startsWith("library.") ||
    action.startsWith("inbox.") ||
    action.startsWith("business.")
  );
}

const businessFieldLabels: Record<string, string> = {
  city: "City",
  duns: "DUNS",
  ein: "EIN",
  incorporationDate: "Incorporation date",
  name: "Name",
  state: "State",
  streetAddress: "Street address",
  zip: "ZIP",
};

const linkTargetLabels: Record<string, string> = {
  equipment: "Equipment",
  finance_transaction: "Transaction",
  library_folder: "Folder",
};

const emailStatusLabels: Record<string, string> = {
  archived: "Archive",
  inbox: "Inbox",
  trash: "Trash",
};

/** What a library, inbox, or business event changed, on one line. */
export function libraryActivitySummary(event: ActivityEvent) {
  const { action, details, root } = event;
  switch (action) {
    case "library.file_uploaded":
    case "library.file_deleted":
      return `${textValue(details.filename)} · ${folderLabel(details.folderId, details.folderName)}`;
    case "library.file_moved":
      return `${textValue(details.filename)} · ${folderLabel(details.fromFolderId, details.fromFolderName)} → ${folderLabel(details.toFolderId, details.toFolderName)}`;
    case "library.folder_renamed":
      return `${textValue(details.before)} → ${textValue(details.after)}`;
    case "library.folder_deleted":
      return `${textValue(details.name)} · ${count(details.fileCount, "file")} returned to the library · ${count(details.emailLinkCount, "email link")} removed`;
    case "inbox.email_trashed":
    case "inbox.email_archived":
    case "inbox.email_restored":
      return `${textValue(details.from)} · from ${emailStatusLabels[textValue(details.fromStatus)] ?? "Inbox"}`;
    case "inbox.email_linked":
    case "inbox.email_unlinked":
      return `${textValue(details.subject)} · ${linkTargetLabels[root.type] ?? "Record"}: ${root.label}`;
    case "business.created":
    case "business.deleted":
      return businessSnapshot(details);
    case "business.updated":
      return businessChanges(details.changes);
    default:
      return textValue(details.name) || root.label;
  }
}

function folderLabel(id: unknown, name: unknown) {
  if (id == null) return "Library (no folder)";
  return textValue(name) || "Deleted folder";
}

function count(value: unknown, noun: string) {
  const amount = typeof value === "number" ? value : 0;
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

function businessSnapshot(details: ActivityEvent["details"]) {
  return [
    textValue(details.name),
    details.ein ? `EIN ${textValue(details.ein)}` : "",
    details.duns ? `DUNS ${textValue(details.duns)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function businessChanges(changes: unknown) {
  return (Array.isArray(changes) ? changes : [])
    .map((change: unknown) => {
      const field = textValue(Reflect.get(Object(change), "field"));
      const before = textValue(Reflect.get(Object(change), "before"));
      const after = textValue(Reflect.get(Object(change), "after"));
      return `${businessFieldLabels[field] ?? field}: ${before || "None"} → ${after || "None"}`;
    })
    .join(" · ");
}
