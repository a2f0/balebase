import { productName } from "@balebase/ui/brand";
import { Button, confirmDialog, Toast } from "@balebase/ui/react";
import { useEffect, useRef, useState } from "react";
import { ServiceWorkerUpdates, type UpdateState } from "./serviceWorkerUpdates";

export function WebUpdates() {
  const [state, setState] = useState<UpdateState>({
    available: false,
    busy: false,
  });
  const updates = useRef<ServiceWorkerUpdates | undefined>(undefined);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const current = new ServiceWorkerUpdates(setState);
    updates.current = current;
    return () => current.dispose();
  }, []);

  async function apply() {
    if (
      await confirmDialog({
        title: `Update ${productName}?`,
        message: `Save your changes before continuing. This tab will reload to use the new version. Close other ${productName} tabs and windows first.`,
        confirmLabel: "Update and reload",
        cancelLabel: "Keep working",
      })
    )
      updates.current?.apply();
  }

  if (!state.available) return null;
  return (
    <Toast
      title="Update available"
      tone={state.error ? "warning" : "info"}
      actions={
        <Button busy={state.busy} onClick={() => void apply()}>
          Update
        </Button>
      }
    >
      {state.error ??
        `A new version of ${productName} is ready. Save your changes, then update.`}
    </Toast>
  );
}
