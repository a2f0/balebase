import type {
  OfflineOperation,
  OfflineScope,
  offlineRoutes,
} from "@balebase/validators/offline";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const apply = endpoint<typeof offlineRoutes.apply>({
  method: "POST",
  path: "/api/offline/operations",
  body: "json",
  response: "json",
});
const sync = endpoint<typeof offlineRoutes.sync>({
  method: "GET",
  path: "/api/offline/sync",
  response: "json",
});
const images = endpoint<typeof offlineRoutes.images>({
  method: "GET",
  path: "/api/offline/issues/:issueId/images",
  response: "json",
});
const audit = endpoint<typeof offlineRoutes.audit>({
  method: "GET",
  path: "/api/offline/audits/:auditId",
  response: "json",
});
const uploadImage = endpoint<typeof offlineRoutes.uploadImage>({
  method: "PUT",
  path: "/api/offline/issues/:issueId/images/:imageId",
  body: "file",
  response: "json",
});

export function offlineApi(transport: Transport) {
  return {
    images(issueId: string) {
      return transport.call(images, { params: { issueId } });
    },
    sync(scope: OfflineScope, after?: string) {
      return transport.call(sync, {
        query: after === undefined ? scope : { ...scope, after },
      });
    },
    audit(scope: OfflineScope, auditId: string) {
      return transport.call(audit, { params: { auditId }, query: scope });
    },
    apply(scope: OfflineScope, operation: OfflineOperation) {
      return transport.call(apply, { body: { ...scope, operation } });
    },
    uploadImage(
      scope: OfflineScope,
      issueId: string,
      imageId: string,
      file: File,
    ) {
      return transport.call(uploadImage, {
        params: { issueId, imageId },
        body: file,
        query: { ...scope, filename: file.name },
      });
    },
  };
}
