import { id, type McpTool, nullable, oneOf, text } from "./mcpToolSchema";

const folderName = text("Folder name, unique in the library.", {
  maxLength: 80,
  minLength: 1,
});

const inboxFolder = oneOf(
  "Which mailbox to read; defaults to inbox. Archived and trashed email is only found in its own folder.",
  ["inbox", "archived", "trash"],
);

const emailId = id("Email id from list_inbox_emails.");

export const libraryTools: McpTool[] = [
  {
    description:
      "Lists library folders with their file and linked email counts.",
    method: "GET",
    name: "list_library_folders",
    path: "/api/library/folders",
    title: "List library folders",
  },
  {
    description: "Gets a library folder and the inbox emails linked to it.",
    method: "GET",
    name: "get_library_folder",
    params: { id: id("Folder id from list_library_folders.") },
    path: "/api/library/folders/{id}",
    title: "Get library folder",
  },
  {
    body: { properties: { name: folderName }, required: ["name"] },
    description: "Creates a library folder.",
    method: "POST",
    name: "create_library_folder",
    path: "/api/library/folders",
    title: "Create library folder",
  },
  {
    body: { properties: { name: folderName }, required: ["name"] },
    description: "Renames a library folder.",
    method: "PATCH",
    name: "rename_library_folder",
    params: { id: id("Folder id from list_library_folders.") },
    path: "/api/library/folders/{id}",
    title: "Rename library folder",
  },
  {
    description:
      "Deletes a library folder. Its files move to the library root and its email links are removed.",
    destructive: true,
    method: "DELETE",
    name: "delete_library_folder",
    params: { id: id("Folder id from list_library_folders.") },
    path: "/api/library/folders/{id}",
    title: "Delete library folder",
  },
  {
    description:
      "Lists up to 100 of the newest library files in one folder, or at the library root when folder is omitted. File contents are not returned.",
    method: "GET",
    name: "list_library_files",
    path: "/api/objects",
    query: { folder: id("Folder id from list_library_folders.") },
    title: "List library files",
  },
  {
    body: {
      properties: {
        folderId: nullable(
          text("Destination folder id, or null for the library root.", {
            maxLength: 100,
            minLength: 1,
          }),
        ),
      },
      required: ["folderId"],
    },
    description: "Moves a library file into a folder or back to the root.",
    method: "PATCH",
    name: "move_library_file",
    params: { id: id("File id from list_library_files.") },
    path: "/api/objects/{id}",
    title: "Move library file",
  },
  {
    description: "Permanently deletes a library file.",
    destructive: true,
    method: "DELETE",
    name: "delete_library_file",
    params: { id: id("File id from list_library_files.") },
    path: "/api/objects/{id}",
    title: "Delete library file",
  },
  {
    description:
      "Lists up to 100 emails in the organization's shared inbox, archive, or trash, newest first, with the inbox's upload address.",
    method: "GET",
    name: "list_inbox_emails",
    path: "/api/inbox",
    query: { folder: inboxFolder },
    title: "List inbox emails",
  },
  {
    description:
      "Reads one email: its text and HTML bodies, attachment list, and links to folders, equipment, and finance transactions.",
    method: "GET",
    name: "get_inbox_email",
    params: { id: emailId },
    path: "/api/inbox/{id}",
    query: { folder: inboxFolder },
    title: "Get inbox email",
  },
  {
    body: {
      properties: {
        targetId: text("Id of the folder, equipment, or transaction.", {
          maxLength: 100,
          minLength: 1,
        }),
        targetType: oneOf(
          "What to link the email to. Finance transactions need the Finance capability.",
          ["library_folder", "equipment", "finance_transaction"],
        ),
      },
      required: ["targetType", "targetId"],
    },
    description:
      "Links an email to a library folder, item of equipment, or finance transaction. Linking twice is harmless.",
    method: "POST",
    name: "link_inbox_email",
    params: { id: emailId },
    path: "/api/inbox/{id}/links",
    title: "Link inbox email",
  },
  {
    description: "Removes one link from an email.",
    method: "DELETE",
    name: "unlink_inbox_email",
    params: {
      id: emailId,
      linkId: id("Link id from get_inbox_email."),
    },
    path: "/api/inbox/{id}/links/{linkId}",
    title: "Unlink inbox email",
  },
  {
    description:
      "Archives an inbox email. Archived email keeps its attachments and links.",
    method: "POST",
    name: "archive_inbox_email",
    params: { id: emailId },
    path: "/api/inbox/{id}/archive",
    title: "Archive inbox email",
  },
  {
    description:
      "Moves an email to Trash, where it can be restored for 30 days. Linked email cannot be trashed; archive it instead.",
    method: "DELETE",
    name: "trash_inbox_email",
    params: { id: emailId },
    path: "/api/inbox/{id}",
    title: "Trash inbox email",
  },
  {
    description: "Moves an archived or trashed email back to the inbox.",
    method: "POST",
    name: "restore_inbox_email",
    params: { id: emailId },
    path: "/api/inbox/{id}/restore",
    title: "Restore inbox email",
  },
];
