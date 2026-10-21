import type { Signature, signingRoutes } from "@balebase/validators/signing";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  get: endpoint<typeof signingRoutes.get>({
    method: "GET",
    path: "/api/signing/:token",
    credentials: "omit",
    response: "json",
  }),
  document: endpoint<typeof signingRoutes.document>({
    method: "GET",
    path: "/api/signing/:token/document",
    credentials: "omit",
    response: "file",
  }),
  final: endpoint<typeof signingRoutes.final>({
    method: "GET",
    path: "/api/signing/:token/final",
    credentials: "omit",
    response: "file",
  }),
  sign: endpoint<typeof signingRoutes.sign>({
    method: "POST",
    path: "/api/signing/:token/sign",
    credentials: "omit",
    body: "json",
    response: "json",
  }),
  decline: endpoint<typeof signingRoutes.decline>({
    method: "POST",
    path: "/api/signing/:token/decline",
    credentials: "omit",
    body: "json",
    response: "json",
  }),
};

export function signingApi(transport: Transport) {
  return {
    get(token: string) {
      return transport.call(endpoints.get, { params: { token } });
    },
    sign(token: string, signature: Signature) {
      return transport.call(endpoints.sign, {
        body: signature,
        params: { token },
      });
    },
    decline(token: string, reason: string) {
      return transport.call(endpoints.decline, {
        body: { reason },
        params: { token },
      });
    },
    /** The PDF to sign. */
    document(token: string) {
      return transport.call(endpoints.document, { params: { token } });
    },
    documentUrl(token: string) {
      return transport.url(endpoints.document, { params: { token } });
    },
    /** The signed PDF, once everyone has signed. */
    finalUrl(token: string) {
      return transport.url(endpoints.final, { params: { token } });
    },
  };
}
