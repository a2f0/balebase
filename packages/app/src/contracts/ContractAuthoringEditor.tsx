import { Button, Card, LoadingState, Toast } from "@balebase/ui/react";
import type { ContractDetail } from "@balebase/validators/contracts";
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  confirmDiscardChanges,
  useUnsavedChanges,
} from "../workspace/unsavedChanges";
import { ContractAuthoringContent } from "./ContractAuthoringContent";
import { ContractAuthoringDetails } from "./ContractAuthoringDetails";
import { boxStyle, ContractPages, type PageSize } from "./ContractDocument";
import { useAuthoringRequests } from "./contractAuthoringRequests";
import {
  type AuthoringEvent,
  type AuthoringState,
  authoringBusy,
  authoringDirty,
  authoringInitialState,
  authoringReducer,
} from "./contractAuthoringState";
import { confirmContractDeletion, fieldTypeLabel } from "./contractFields";

export function ContractAuthoringEditor({
  contract,
  onChanged,
  onDeleted,
  onClose,
}: {
  contract?: ContractDetail;
  onChanged: (contract: ContractDetail | null) => void;
  onDeleted: () => void;
  onClose?: () => void;
}) {
  const [state, dispatch] = useReducer(
    authoringReducer,
    contract,
    authoringInitialState,
  );
  const requests = useRef(0);
  const busy = authoringBusy(state);
  const dirty = authoringDirty(state);
  useUnsavedChanges(
    dirty || busy,
    "Your written contract changes have not been saved. Leaving during a request may leave its outcome unknown.",
  );
  useAuthoringRequests(state, dispatch);
  useEffect(() => {
    if (state.status === "sent") onChanged(state.result);
    if (state.status === "deleted") onDeleted();
  }, [onChanged, onDeleted, state]);
  const request = (type: "save" | "preview" | "send" | "delete") =>
    dispatch({ request: ++requests.current, type });
  const preview = "bytes" in state;
  return (
    <div className="stack stackLg">
      {state.status === "editing" && state.error && (
        <Toast tone="danger">{state.error}</Toast>
      )}
      <div className="contractAuthoringLayout">
        <fieldset className="contractAuthoringSettings" disabled={busy}>
          <legend className="srOnly">Contract settings</legend>
          <ContractAuthoringDetails
            draft={state.draft}
            onChange={(draft) => dispatch({ draft, type: "edit" })}
          />
        </fieldset>
        <Card title="Written contract">
          <ContractAuthoringContent
            draft={state.draft}
            disabled={busy}
            onChange={(source) =>
              dispatch({ draft: { ...state.draft, source }, type: "edit" })
            }
          />
        </Card>
      </div>
      <AuthoringActions state={state} request={request} onClose={onClose} />
      <p className="contractHint" role="status">
        {dirty
          ? "Unsaved changes. Save and review the generated PDF before sending."
          : `Saved revision ${state.saved?.authoring?.revision ?? ""}. Any edit requires saving and reviewing again.`}
      </p>
      {state.status === "loadingPreview" && (
        <LoadingState label="Loading saved PDF…" />
      )}
      {preview && state.saved?.authoring && (
        <section aria-label="Exact PDF preview" className="stack stackMd">
          <h2>Saved PDF · revision {state.saved.authoring.revision}</h2>
          <p className="contractHint">
            This is the saved document signers will receive. Review every page
            and signer field before sending.
          </p>
          <AuthoredPdfPreview
            key={`${state.saved.id}:${state.saved.authoring.revision}`}
            bytes={state.bytes}
            contract={state.saved}
            dispatch={dispatch}
            request={state.request}
          />
          <label className="contractAuthoringReview">
            <input
              type="checkbox"
              checked={
                state.status === "reviewed" || state.status === "sending"
              }
              disabled={state.status !== "preview"}
              onChange={() =>
                dispatch({ request: state.request, type: "review" })
              }
            />{" "}
            I reviewed every page of this saved PDF and its signer assignments.
          </label>
        </section>
      )}
    </div>
  );
}

function AuthoringActions({
  state,
  request,
  onClose,
}: {
  state: AuthoringState;
  request: (type: "save" | "preview" | "send" | "delete") => void;
  onClose: (() => void) | undefined;
}) {
  const busy = authoringBusy(state);
  const dirty = authoringDirty(state);
  return (
    <div className="contractEditorActions">
      {onClose && (
        <Button
          disabled={busy}
          onClick={async () => {
            if (
              dirty &&
              !(await confirmDiscardChanges(
                "Your written contract changes have not been saved.",
              ))
            )
              return;
            onClose();
          }}
        >
          Back to contracts
        </Button>
      )}
      <Button
        disabled={busy}
        variant="ghost"
        onClick={async () => {
          if (await confirmContractDeletion(state.draft.title))
            request("delete");
        }}
      >
        {state.saved ? "Delete draft" : "Discard draft"}
      </Button>
      <Button
        disabled={busy}
        onClick={() => request(dirty ? "save" : "preview")}
      >
        {state.status === "saving"
          ? "Saving…"
          : dirty
            ? "Save and preview"
            : "Preview saved PDF"}
      </Button>
      <Button
        disabled={state.status !== "reviewed"}
        busy={state.status === "sending"}
        icon="send"
        onClick={() => request("send")}
        variant="primary"
      >
        Send for signature
      </Button>
    </div>
  );
}

function AuthoredPdfPreview({
  bytes,
  contract,
  dispatch,
  request,
}: {
  bytes: ArrayBuffer;
  contract: ContractDetail;
  dispatch: (event: AuthoringEvent) => void;
  request: number;
}) {
  // PDF.js may transfer its buffer. Keep the saved bytes and loader identity
  // stable while review and send transition without changing the document.
  const load = useCallback(() => Promise.resolve(bytes.slice(0)), [bytes]);
  const onDisplayed = useCallback(
    () => dispatch({ request, type: "displayed" }),
    [dispatch, request],
  );
  return (
    <ContractPages
      load={load}
      renderOverlay={(page) => (
        <AuthoredPreviewFields
          contract={contract}
          page={page}
          onDisplayed={onDisplayed}
        />
      )}
    />
  );
}

function AuthoredPreviewFields({
  contract,
  page,
  onDisplayed,
}: {
  contract: ContractDetail;
  page: PageSize;
  onDisplayed: () => void;
}) {
  useEffect(() => {
    onDisplayed();
  }, [onDisplayed]);
  return (
    <>
      {contract.fields
        .filter((field) => field.page === page.number)
        .map((field) => {
          const recipient = contract.recipients.find(
            ({ id }) => id === field.recipientId,
          );
          return (
            <div
              className="contractField contractFieldStatic"
              key={field.id}
              style={boxStyle(field)}
            >
              <span className="contractFieldLabel">
                {recipient?.name || recipient?.email || "Signer"}:{" "}
                {field.label || fieldTypeLabel(field.type)}
              </span>
            </div>
          );
        })}
    </>
  );
}
