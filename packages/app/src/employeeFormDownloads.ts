import { api } from "./shared/apiClient";
import { saveFile } from "./shared/saveFile";

/** Saves the signed background check authorization behind a report. */
export async function downloadScreeningConsent(id: string) {
  const response = await api.employeeForms.screeningConsent(id);
  if (
    !(await saveFile(
      await response.blob(),
      "background-check-authorization.pdf",
    ))
  ) {
    throw new Error("Saving the authorization was canceled.");
  }
}

/** Saves a submitted form, and returns the revision the manager saw. */
export async function downloadEmployeeForm(id: string, filename: string) {
  const response = await api.employeeForms.document(id);
  const revision = Number(response.headers.get("X-Document-Revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("The downloaded form has no review version.");
  }
  if (!(await saveFile(await response.blob(), filename))) {
    throw new Error("Saving the form was canceled.");
  }
  return revision;
}
