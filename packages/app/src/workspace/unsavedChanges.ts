import { confirmDialog } from "@balebase/ui/react";
import { useEffect } from "react";
import { addNavigationGuard } from "./navigationGuard";

export function confirmDiscardChanges(
  message = "Your template changes have not been saved.",
) {
  return confirmDialog({
    cancelLabel: "Keep editing",
    confirmLabel: "Discard changes",
    message,
    title: "Discard unsaved changes?",
    tone: "danger",
  });
}

export function useUnsavedChanges(dirty: boolean, message?: string) {
  useEffect(() => {
    if (!dirty) return;
    const removeGuard = addNavigationGuard(() =>
      confirmDiscardChanges(message),
    );
    // Closing the tab can only use the browser's own prompt.
    const close = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", close);
    return () => {
      removeGuard();
      window.removeEventListener("beforeunload", close);
    };
  }, [dirty, message]);
}
