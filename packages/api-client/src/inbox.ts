import type {
  InboundEmailLinkTarget,
  InboxFolder,
  inboxRoutes,
} from "@balebase/validators/inbox";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof inboxRoutes.list>({
    method: "GET",
    path: "/api/inbox",
    response: "json",
  }),
  get: endpoint<typeof inboxRoutes.get>({
    method: "GET",
    path: "/api/inbox/:id",
    response: "json",
  }),
  activity: endpoint<typeof inboxRoutes.activity>({
    method: "GET",
    path: "/api/inbox/:id/activity",
    response: "json",
  }),
  link: endpoint<typeof inboxRoutes.link>({
    method: "POST",
    path: "/api/inbox/:id/links",
    body: "json",
    response: "json",
  }),
  unlink: endpoint<typeof inboxRoutes.unlink>({
    method: "DELETE",
    path: "/api/inbox/:id/links/:linkId",
    response: "empty",
  }),
  attachment: endpoint<typeof inboxRoutes.attachment>({
    method: "GET",
    path: "/api/inbox/:emailId/attachments/:attachmentId",
    response: "file",
  }),
  delete: endpoint<typeof inboxRoutes.delete>({
    method: "DELETE",
    path: "/api/inbox/:id",
    response: "json",
  }),
  archive: endpoint<typeof inboxRoutes.archive>({
    method: "POST",
    path: "/api/inbox/:id/archive",
    response: "json",
  }),
  restore: endpoint<typeof inboxRoutes.restore>({
    method: "POST",
    path: "/api/inbox/:id/restore",
    response: "json",
  }),
};

export function inboxApi(transport: Transport) {
  return {
    /** A folder's emails and the address that delivers to the inbox. */
    list(folder: InboxFolder = "inbox") {
      return transport.call(endpoints.list, { query: folderQuery(folder) });
    },
    async get(id: string, folder: InboxFolder = "inbox") {
      const { email } = await transport.call(endpoints.get, {
        params: { id },
        query: folderQuery(folder),
      });
      return email;
    },
    attachmentUrl(
      emailId: string,
      attachmentId: string,
      folder: InboxFolder = "inbox",
    ) {
      return transport.url(endpoints.attachment, {
        params: { attachmentId, emailId },
        query: folderQuery(folder),
      });
    },
    /** The email's history, including its links, newest first. */
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    /** Moves an email to Trash. */
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
    /** Returns an email from Trash or Archived to the inbox. */
    restore(id: string) {
      return transport.call(endpoints.restore, { params: { id } });
    },
    archive(id: string) {
      return transport.call(endpoints.archive, { params: { id } });
    },
    async link(emailId: string, target: InboundEmailLinkTarget) {
      const { link } = await transport.call(endpoints.link, {
        body: target,
        params: { id: emailId },
      });
      return link;
    },
    unlink(emailId: string, linkId: string) {
      return transport.call(endpoints.unlink, {
        params: { id: emailId, linkId },
      });
    },
  };
}

/** The inbox is the default, so its URLs carry no folder. */
function folderQuery(folder: InboxFolder) {
  return { folder: folder === "inbox" ? undefined : folder };
}
