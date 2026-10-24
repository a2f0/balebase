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
const forms = endpoint<typeof offlineRoutes.forms>({
  method: "GET",
  path: "/api/offline/forms",
  response: "json",
});
const images = endpoint<typeof offlineRoutes.images>({
  method: "GET",
  path: "/api/offline/issues/:issueId/images",
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
    forms(scope: OfflineScope) {
      return transport.call(forms, { query: scope });
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
