import type { ContractDetail } from "@balebase/validators/contracts";
import { useEffect, useRef } from "react";
import { api } from "../shared/apiClient";
import {
  type AuthoringEvent,
  type AuthoringRequestState,
  type AuthoringState,
  authoringBusy,
} from "./contractAuthoringState";

export function useAuthoringRequests(
  state: AuthoringState,
  dispatch: (event: AuthoringEvent) => void,
) {
  const pending = useRef<{
    state: AuthoringRequestState;
    promise: Promise<AuthoringEvent>;
  } | null>(null);
  useEffect(() => {
    if (!authoringBusy(state)) return;
    // Replayed effects resubscribe to the same work, including its completion.
    // State identity, not the request number, distinguishes save from preview.
    if (pending.current?.state !== state) {
      pending.current = { state, promise: performRequest(state) };
    }
    let active = true;
    const send = (event: AuthoringEvent) => {
      if (active) dispatch(event);
    };
    void pending.current.promise.then(send, (cause: unknown) =>
      send({
        message:
          cause instanceof Error
            ? cause.message
            : "Could not update the written contract.",
        request: state.request,
        type: "failed",
      }),
    );
    return () => {
      active = false;
    };
  }, [dispatch, state]);
}

async function performRequest(
  state: AuthoringRequestState,
): Promise<AuthoringEvent> {
  const request = state.request;
  switch (state.status) {
    case "saving":
      return {
        contract: await saveWrittenContract(state),
        request,
        type: "saved",
      };
    case "loadingPreview":
      return {
        bytes: await loadSavedPdf(state.saved),
        request,
        type: "loadedPreview",
      };
    case "sending": {
      if (!state.saved?.authoring)
        throw new Error("Save and review this contract first.");
      const contract = await api.contracts.send(
        state.saved.id,
        state.saved.authoring.revision,
      );
      if (!contract) throw new Error("This contract is no longer available.");
      return { contract, request, type: "sent" };
    }
    case "deleting":
      if (state.saved) await api.contracts.delete(state.saved.id);
      return { request, type: "deleted" };
  }
}

async function saveWrittenContract(state: AuthoringRequestState) {
  const contract = state.saved?.authoring
    ? await api.contracts.saveAuthored(
        state.saved.id,
        state.draft,
        state.saved.authoring.revision,
      )
    : await api.contracts.createAuthored(state.draft);
  if (!contract?.authoring)
    throw new Error(
      "The written contract could not be saved. Your source is still here.",
    );
  return contract;
}

async function loadSavedPdf(saved: ContractDetail | undefined) {
  if (!saved?.authoring)
    throw new Error("Save this contract before previewing.");
  const response = await api.contracts.document(saved.id);
  const bytes = await response.arrayBuffer();
  // Check after fetching so another tab's newer PDF cannot be reviewed as this revision.
  const latest = await api.contracts.get(saved.id);
  if (latest?.authoring?.revision !== saved.authoring.revision) {
    throw new Error(
      "This contract changed elsewhere. Reopen it to review the latest revision; your local source has been kept.",
    );
  }
  return bytes;
}
