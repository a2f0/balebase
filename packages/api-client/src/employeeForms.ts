import type {
  EmployeeRequirementInput,
  EmployeeRequirementUpdate,
  employeeFormsRoutes,
  ScreeningSubmission,
} from "@balebase/validators/employeeForms";
import type { UsStateCode } from "@balebase/validators/rules";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof employeeFormsRoutes.list>({
    method: "GET",
    path: "/api/employee-forms",
    response: "json",
  }),
  create: endpoint<typeof employeeFormsRoutes.create>({
    method: "POST",
    path: "/api/employee-forms",
    body: "json",
    response: "json",
  }),
  update: endpoint<typeof employeeFormsRoutes.update>({
    method: "PATCH",
    path: "/api/employee-forms/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof employeeFormsRoutes.delete>({
    method: "DELETE",
    path: "/api/employee-forms/:id",
    response: "json",
  }),
  upload: endpoint<typeof employeeFormsRoutes.upload>({
    method: "POST",
    path: "/api/employee-forms/:id/document",
    body: "form",
    response: "json",
  }),
  document: endpoint<typeof employeeFormsRoutes.document>({
    method: "GET",
    path: "/api/employee-forms/:id/document",
    response: "file",
  }),
  requestScreening: endpoint<typeof employeeFormsRoutes.requestScreening>({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/request",
    body: "json",
    response: "json",
  }),
  screeningForm: endpoint<typeof employeeFormsRoutes.screeningForm>({
    method: "GET",
    path: "/api/employee-forms/:id/checkr/form",
    response: "json",
  }),
  submitScreening: endpoint<typeof employeeFormsRoutes.submitScreening>({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/submit",
    body: "json",
    response: "json",
  }),
  refreshScreening: endpoint<typeof employeeFormsRoutes.refreshScreening>({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/refresh",
    response: "json",
  }),
  screeningConsent: endpoint<typeof employeeFormsRoutes.screeningConsent>({
    method: "GET",
    path: "/api/employee-forms/:id/checkr/consent",
    response: "file",
  }),
};

export function employeeFormsApi(transport: Transport) {
  return {
    /**
     * Requests visible to the signed-in person. `own` keeps only those sent
     * to them, as they see them, for My documents.
     */
    list({ own = false } = {}) {
      return transport.call(endpoints.list, {
        query: { for: own ? "me" : undefined },
      });
    },
    create(
      target: { invitationId: string } | { memberId: string },
      requirements: EmployeeRequirementInput[],
    ) {
      return transport.call(endpoints.create, {
        body: { ...target, requirements },
      });
    },
    update(id: string, update: EmployeeRequirementUpdate) {
      return transport.call(endpoints.update, {
        body: update,
        params: { id },
      });
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
    upload(id: string, file: File) {
      const body = new FormData();
      body.set("file", file);
      return transport.call(endpoints.upload, {
        body,
        params: { id },
      });
    },
    /** The submitted form; X-Document-Revision names its revision. */
    document(id: string) {
      return transport.call(endpoints.document, { params: { id } });
    },
    requestScreening(id: string, state: UsStateCode, city: string) {
      return transport.call(endpoints.requestScreening, {
        body: { city, state },
        params: { id },
      });
    },
    screeningForm(id: string) {
      return transport.call(endpoints.screeningForm, {
        params: { id },
      });
    },
    submitScreening(id: string, submission: ScreeningSubmission) {
      return transport.call(endpoints.submitScreening, {
        body: submission,
        params: { id },
      });
    },
    refreshScreening(id: string) {
      return transport.call(endpoints.refreshScreening, {
        params: { id },
      });
    },
    /** The signed background check authorization behind a report. */
    screeningConsent(id: string) {
      return transport.call(endpoints.screeningConsent, {
        params: { id },
      });
    },
  };
}
