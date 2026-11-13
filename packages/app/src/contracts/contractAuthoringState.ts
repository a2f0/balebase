import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import type { ContractDetail } from "@balebase/validators/contracts";

type DraftState = {
  draft: ContractAuthoringInput;
  saved: ContractDetail | undefined;
};

export type AuthoringRequestState = DraftState &
  (
    | { status: "saving" | "loadingPreview" | "deleting"; request: number }
    | { status: "sending"; request: number; bytes: ArrayBuffer }
  );

export type AuthoringState =
  | AuthoringRequestState
  | (DraftState &
      (
        | { status: "editing"; error?: string }
        | {
            status: "renderingPreview" | "preview" | "reviewed";
            request: number;
            bytes: ArrayBuffer;
          }
        | { status: "sent"; result: ContractDetail }
        | { status: "deleted" }
      ));

export type AuthoringEvent =
  | { type: "edit"; draft: ContractAuthoringInput }
  | { type: "save" | "preview" | "send" | "delete"; request: number }
  | { type: "saved"; request: number; contract: ContractDetail }
  | { type: "loadedPreview"; request: number; bytes: ArrayBuffer }
  | { type: "displayed" | "review"; request: number }
  | { type: "failed"; request: number; message: string }
  | { type: "sent"; request: number; contract: ContractDetail }
  | { type: "deleted"; request: number };

export function newAuthoredDraft(): ContractAuthoringInput {
  return {
    dueDate: null,
    formatVersion: 1,
    message: "",
    recipients: [{ email: "", key: "client", name: "", routingOrder: 1 }],
    reminderIntervalDays: null,
    signingOrder: "parallel",
    source:
      '# Agreement\n\nWrite your agreement here.\n\n:signature{#client-signature role="client"}\n',
    title: "Untitled agreement",
    values: {},
  };
}

export function authoringInitialState(
  contract?: ContractDetail,
): AuthoringState {
  return {
    draft: contract?.authoring ?? newAuthoredDraft(),
    saved: contract,
    status: "editing",
  };
}

export function authoringBusy(
  state: AuthoringState,
): state is AuthoringRequestState {
  return (
    state.status === "saving" ||
    state.status === "loadingPreview" ||
    state.status === "sending" ||
    state.status === "deleting"
  );
}

export function authoringDirty(state: AuthoringState) {
  return (
    state.status !== "sent" &&
    state.status !== "deleted" &&
    state.draft !== state.saved?.authoring
  );
}

function canChange(state: AuthoringState) {
  return (
    !authoringBusy(state) &&
    state.status !== "sent" &&
    state.status !== "deleted"
  );
}

function canPreview(state: AuthoringState) {
  return (
    canChange(state) &&
    !authoringDirty(state) &&
    Boolean(state.saved?.authoring)
  );
}

function isCurrentRequest(state: AuthoringState, event: AuthoringEvent) {
  return (
    "request" in state && "request" in event && state.request === event.request
  );
}

function inRequest<Status extends AuthoringState["status"]>(
  state: AuthoringState,
  event: AuthoringEvent,
  status: Status,
): state is AuthoringState & { status: Status } {
  return state.status === status && isCurrentRequest(state, event);
}

/** Guards are separate from transitions so illegal and stale events remain inert. */
function acceptsEvent(state: AuthoringState, event: AuthoringEvent) {
  switch (event.type) {
    case "edit":
    case "save":
    case "delete":
      return canChange(state);
    case "preview":
      return canPreview(state);
    case "saved":
      return inRequest(state, event, "saving");
    case "loadedPreview":
      return inRequest(state, event, "loadingPreview");
    case "displayed":
      return inRequest(state, event, "renderingPreview");
    case "review":
      return inRequest(state, event, "preview");
    case "send":
      return state.status === "reviewed" && !authoringDirty(state);
    case "sent":
      return inRequest(state, event, "sending");
    case "deleted":
      return inRequest(state, event, "deleting");
    case "failed":
      return isCurrentRequest(state, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** Editing invalidates review. Only the current request and exact saved revision may advance. */
export function authoringReducer(
  state: AuthoringState,
  event: AuthoringEvent,
): AuthoringState {
  if (!acceptsEvent(state, event)) return state;
  const base: DraftState = { draft: state.draft, saved: state.saved };
  switch (event.type) {
    case "edit":
      return { ...base, draft: event.draft, status: "editing" };
    case "save":
      return { ...base, request: event.request, status: "saving" };
    case "preview":
      return { ...base, request: event.request, status: "loadingPreview" };
    case "saved":
      return event.contract.authoring
        ? {
            draft: event.contract.authoring,
            saved: event.contract,
            request: event.request,
            status: "loadingPreview",
          }
        : state;
    case "loadedPreview":
      return {
        ...base,
        bytes: event.bytes,
        request: event.request,
        status: "renderingPreview",
      };
    case "displayed":
      return state.status === "renderingPreview"
        ? { ...state, status: "preview" }
        : state;
    case "review":
      return state.status === "preview"
        ? { ...state, status: "reviewed" }
        : state;
    case "send":
      return state.status === "reviewed"
        ? { ...state, request: event.request, status: "sending" }
        : state;
    case "sent":
      return { ...base, result: event.contract, status: "sent" };
    case "delete":
      return { ...base, request: event.request, status: "deleting" };
    case "deleted":
      return { ...base, status: "deleted" };
    case "failed":
      return { ...base, error: event.message, status: "editing" };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
