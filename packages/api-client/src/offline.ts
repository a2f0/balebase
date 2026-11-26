import type {
  OfflineOperation,
  OfflineScope,
  offlineRoutes,
} from "@balebase/validators/offline";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

// A stalled request would hold the offline queue indefinitely; slow
// connections and image uploads still get a minute and a half.
const offlineTimeoutMs = 90_000;

const apply = endpoint<typeof offlineRoutes.apply>({
  method: "POST",
  path: "/api/offline/operations",
  body: "json",
  response: "json",
  timeoutMs: offlineTimeoutMs,
});
const sync = endpoint<typeof offlineRoutes.sync>({
  method: "GET",
  path: "/api/offline/sync",
  response: "json",
  timeoutMs: offlineTimeoutMs,
});
const images = endpoint<typeof offlineRoutes.images>({
  method: "GET",
  path: "/api/offline/issues/:issueId/images",
  response: "json",
  timeoutMs: offlineTimeoutMs,
});
const form = endpoint<typeof offlineRoutes.form>({
  method: "GET",
  path: "/api/offline/forms/:formId",
  response: "json",
  timeoutMs: offlineTimeoutMs,
});
const uploadImage = endpoint<typeof offlineRoutes.uploadImage>({
  method: "PUT",
  path: "/api/offline/issues/:issueId/images/:imageId",
  body: "file",
  response: "json",
  timeoutMs: offlineTimeoutMs,
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
    form(scope: OfflineScope, formId: string) {
      return transport.call(form, { params: { formId }, query: scope });
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
