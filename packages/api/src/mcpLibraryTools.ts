import { inboxRoutes } from "@balebase/validators/inbox";
import { libraryFoldersRoutes } from "@balebase/validators/libraryFolders";
import { objectsRoutes } from "@balebase/validators/objects";
import type { McpTool } from "./mcpToolSchema";

const folderId = { id: "Folder id from list_library_folders." };
const folderName = { name: "Folder name, unique in the library." };
const fileId = { id: "File id from list_library_files." };

const inboxFolder = {
  folder:
    "Which mailbox to read; defaults to inbox. Archived and trashed email is only found in its own folder.",
};

const emailId = { id: "Email id from list_inbox_emails." };

export const libraryTools: McpTool[] = [
  {
    description:
      "Lists library folders with their file and linked email counts.",
    name: "list_library_folders",
    route: libraryFoldersRoutes.list,
    title: "List library folders",
  },
  {
    description: "Gets a library folder and the inbox emails linked to it.",
    descriptions: folderId,
    name: "get_library_folder",
    route: libraryFoldersRoutes.get,
    title: "Get library folder",
  },
  {
    description: "Creates a library folder.",
    descriptions: folderName,
    name: "create_library_folder",
    route: libraryFoldersRoutes.create,
    title: "Create library folder",
  },
  {
    description: "Renames a library folder.",
    descriptions: { ...folderId, ...folderName },
    name: "rename_library_folder",
    route: libraryFoldersRoutes.rename,
    title: "Rename library folder",
  },
  {
    description:
      "Deletes a library folder. Its files move to the library root and its email links are removed.",
    descriptions: folderId,
    destructive: true,
    name: "delete_library_folder",
    route: libraryFoldersRoutes.delete,
    title: "Delete library folder",
  },
  {
    description:
      "Lists up to 100 of the newest library files in one folder, or at the library root when folder is omitted. File contents are not returned.",
    descriptions: { folder: folderId.id },
    name: "list_library_files",
    route: objectsRoutes.list,
    title: "List library files",
  },
  {
    description: "Moves a library file into a folder or back to the root.",
    descriptions: {
      ...fileId,
      folderId: "Destination folder id, or null for the library root.",
    },
    name: "move_library_file",
    route: objectsRoutes.move,
    title: "Move library file",
  },
  {
    description: "Permanently deletes a library file.",
    descriptions: fileId,
    destructive: true,
    name: "delete_library_file",
    route: objectsRoutes.delete,
    title: "Delete library file",
  },
  {
    description:
      "Lists up to 100 emails in the organization's shared inbox, archive, or trash, newest first, with the inbox's upload address.",
    descriptions: inboxFolder,
    name: "list_inbox_emails",
    route: inboxRoutes.list,
    title: "List inbox emails",
  },
  {
    description:
      "Reads one email: its text and HTML bodies, attachment list, and links to folders, equipment, and finance transactions.",
    descriptions: { ...emailId, ...inboxFolder },
    name: "get_inbox_email",
    route: inboxRoutes.get,
    title: "Get inbox email",
  },
  {
    description:
      "Links an email to a library folder, item of equipment, or finance transaction. Linking twice is harmless.",
    descriptions: {
      ...emailId,
      targetId: "Id of the folder, equipment, or transaction.",
      targetType:
        "What to link the email to. Finance transactions need the Finance capability.",
    },
    name: "link_inbox_email",
    route: inboxRoutes.link,
    title: "Link inbox email",
  },
  {
    description: "Removes one link from an email.",
    descriptions: { ...emailId, linkId: "Link id from get_inbox_email." },
    name: "unlink_inbox_email",
    route: inboxRoutes.unlink,
    title: "Unlink inbox email",
  },
  {
    description:
      "Archives an inbox email. Archived email keeps its attachments and links.",
    descriptions: emailId,
    name: "archive_inbox_email",
    route: inboxRoutes.archive,
    title: "Archive inbox email",
  },
  {
    description:
      "Moves an email to Trash, where it can be restored for 30 days. Linked email cannot be trashed; archive it instead.",
    descriptions: emailId,
    name: "trash_inbox_email",
    route: inboxRoutes.delete,
    title: "Trash inbox email",
  },
  {
    description: "Moves an archived or trashed email back to the inbox.",
    descriptions: emailId,
    name: "restore_inbox_email",
    route: inboxRoutes.restore,
    title: "Restore inbox email",
  },
];
