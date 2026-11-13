import { describe, expect, it } from "bun:test";
import type { ContractDetail } from "@balebase/validators/contracts";
import { act, StrictMode, useReducer } from "react";
import { installDom } from "../testing/dom";
import { useAuthoringRequests } from "./contractAuthoringRequests";
import {
  type AuthoringState,
  authoringInitialState,
  authoringReducer,
} from "./contractAuthoringState";

const { click, mount, respond } = installDom();
const request = 41;
const pdfBytes = new TextEncoder().encode("%PDF-1.7\npreview response\n%%EOF");

function contract(
  id: string,
  revision: number,
  title = "Consulting agreement",
): ContractDetail {
  return {
    authoring: {
      dueDate: null,
      formatVersion: 1,
      message: "Please review and sign.",
      recipients: [
        {
          email: "client@example.com",
          key: "client",
          name: "Alex Client",
          routingOrder: 1,
        },
      ],
      reminderIntervalDays: null,
      revision,
      signingOrder: "parallel",
      source:
        '# Consulting agreement\n\nServices for :value[client.name].\n\n:signature{#client-signature role="client"}\n',
      title,
      values: {},
    },
    completedAt: null,
    createdAt: "2026-11-01T12:00:00.000Z",
    createdByName: "Sam Consultant",
    document: {
      filename: "consulting-agreement.pdf",
      pageCount: 1,
      sha256: "a".repeat(64),
      size: pdfBytes.byteLength,
    },
    dueDate: null,
    events: [
      {
        actorName: "Sam Consultant",
        apiKey: null,
        createdAt: "2026-11-01T12:00:00.000Z",
        detail: null,
        id: `${id}-created`,
        ip: null,
        recipientId: null,
        type: "created",
      },
    ],
    fields: [
      {
        height: 0.04,
        id: "client-signature",
        label: null,
        page: 1,
        recipientId: `${id}-client`,
        required: true,
        type: "signature",
        value: null,
        width: 0.3,
        x: 0.1,
        y: 0.3,
      },
    ],
    finalSha256: null,
    id,
    message: "Please review and sign.",
    recipients: [
      {
        declineReason: null,
        declinedAt: null,
        email: "client@example.com",
        id: `${id}-client`,
        lastRemindedAt: null,
        name: "Alex Client",
        notifiedAt: null,
        routingOrder: 1,
        signedAt: null,
        status: "pending",
        viewedAt: null,
      },
    ],
    reminderIntervalDays: null,
    sentAt: null,
    sentByName: null,
    signingOrder: "parallel",
    status: "draft",
    template: null,
    title,
    updatedAt: "2026-11-01T12:05:00.000Z",
    voidReason: null,
    voidedAt: null,
  };
}

function saving(saved?: ContractDetail) {
  const editing = authoringInitialState(saved);
  const draft = authoringInitialState(contract("new", 0)).draft;
  return authoringReducer(authoringReducer(editing, { draft, type: "edit" }), {
    request,
    type: "save",
  });
}

function AuthoringHarness({ initial }: { initial: AuthoringState }) {
  const [state, dispatch] = useReducer(authoringReducer, initial);
  useAuthoringRequests(state, dispatch);
  return (
    <section>
      <h1>{state.draft.title}</h1>
      <p data-status>{state.status}</p>
      <p data-request>{"request" in state ? state.request : "none"}</p>
      <p data-saved>
        {state.saved
          ? `${state.saved.id} revision ${state.saved.authoring?.revision}`
          : "Not saved"}
      </p>
      {"bytes" in state && <p>PDF bytes: {state.bytes.byteLength}</p>}
      {state.status === "editing" && state.error && (
        <p role="alert">{state.error}</p>
      )}
      <button
        onClick={() => {
          dispatch({ message: "Replaced", request, type: "failed" });
          dispatch({
            draft: { ...state.draft, title: "Replacement agreement" },
            type: "edit",
          });
          dispatch({ request, type: "save" });
        }}
        type="button"
      >
        Replace pending draft
      </button>
    </section>
  );
}

function status(container: HTMLElement) {
  return container.querySelector("[data-status]")?.textContent;
}

async function complete(
  pending: PromiseWithResolvers<Response>,
  response: Response,
) {
  await act(async () => {
    pending.resolve(response);
    await pending.promise;
  });
}

describe("authoring request effect subscriptions", () => {
  for (const operation of ["create", "save"] as const) {
    it(`reuses an initially in-flight ${operation} during StrictMode replay and retains its result`, async () => {
      const previous =
        operation === "save" ? contract("existing", 7) : undefined;
      const saved = contract(previous?.id ?? "created", previous ? 8 : 1);
      const mutation = Promise.withResolvers<Response>();
      const document = Promise.withResolvers<Response>();
      const mutations: { method: string; path: string; body: unknown }[] = [];
      const reads: string[] = [];
      respond((url, init) => {
        if (init?.method === "POST" || init?.method === "PUT") {
          mutations.push({
            body: JSON.parse(String(init.body)),
            method: init.method,
            path: url.pathname,
          });
          // A second save with the old expectedRevision conflicts on the server.
          if (mutations.length > 1)
            return Response.json(
              { error: "This contract changed elsewhere." },
              { status: 409 },
            );
          return mutation.promise;
        }
        reads.push(url.pathname);
        if (url.pathname === `/api/contracts/${saved.id}/document`)
          return document.promise;
        if (url.pathname === `/api/contracts/${saved.id}`)
          return Response.json({ contract: saved });
        throw new Error(`Unexpected request: ${url.pathname}`);
      });

      // Start busy before mounting: an ordinary StrictMode state update does
      // not necessarily replay its effect, but the initial mount does.
      const initial = saving(previous);
      const { container } = await mount(
        <StrictMode>
          <AuthoringHarness initial={initial} />
        </StrictMode>,
      );
      expect(status(container)).toBe("saving");
      expect(mutations).toEqual([
        {
          body: previous
            ? { ...initial.draft, expectedRevision: 7 }
            : initial.draft,
          method: previous ? "PUT" : "POST",
          path: previous
            ? `/api/contracts/${previous.id}/authored`
            : "/api/contracts/authored",
        },
      ]);

      await complete(mutation, Response.json({ contract: saved }));
      expect(status(container)).toBe("loadingPreview");
      expect(container.querySelector("[data-request]")?.textContent).toBe("41");
      expect(container.querySelector("[data-saved]")?.textContent).toBe(
        `${saved.id} revision ${previous ? 8 : 1}`,
      );
      expect(reads).toEqual([`/api/contracts/${saved.id}/document`]);

      await complete(document, new Response(pdfBytes));
      expect(status(container)).toBe("renderingPreview");
      expect(container.textContent).toContain(
        `PDF bytes: ${pdfBytes.byteLength}`,
      );
      expect(container.querySelector("[role=alert]")).toBeNull();
      expect(mutations).toHaveLength(1);
      expect(reads).toEqual([
        `/api/contracts/${saved.id}/document`,
        `/api/contracts/${saved.id}`,
      ]);
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores a cleaned-up ${outcome} after replacement with a new state identity`, async () => {
      const abandoned = Promise.withResolvers<Response>();
      const replacement = Promise.withResolvers<Response>();
      const saved = contract("replacement", 1, "Replacement agreement");
      const titles: string[] = [];
      const reads: string[] = [];
      respond((url, init) => {
        if (
          url.pathname === "/api/contracts/authored" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as { title: string };
          titles.push(body.title);
          return titles.length === 1 ? abandoned.promise : replacement.promise;
        }
        reads.push(url.pathname);
        if (url.pathname === `/api/contracts/${saved.id}/document`)
          return new Response(pdfBytes);
        if (url.pathname === `/api/contracts/${saved.id}`)
          return Response.json({ contract: saved });
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      const { container } = await mount(
        <StrictMode>
          <AuthoringHarness initial={saving()} />
        </StrictMode>,
      );
      // Reuse the tag deliberately: the subscription cleanup, not only the
      // reducer's numeric stale-event guard, must protect the replacement.
      await click("Replace pending draft");
      expect(titles).toEqual(["Consulting agreement", "Replacement agreement"]);
      expect(status(container)).toBe("saving");

      await complete(
        abandoned,
        outcome === "success"
          ? Response.json({ contract: contract("abandoned", 1) })
          : Response.json({ error: "Abandoned save failed." }, { status: 409 }),
      );
      expect(status(container)).toBe("saving");
      expect(container.querySelector("h1")?.textContent).toBe(
        "Replacement agreement",
      );
      expect(container.querySelector("[data-saved]")?.textContent).toBe(
        "Not saved",
      );
      expect(container.querySelector("[role=alert]")).toBeNull();
      expect(reads).toEqual([]);

      await complete(replacement, Response.json({ contract: saved }));
      expect(status(container)).toBe("renderingPreview");
      expect(container.querySelector("[data-saved]")?.textContent).toBe(
        "replacement revision 1",
      );
      expect(container.textContent).toContain(
        `PDF bytes: ${pdfBytes.byteLength}`,
      );
      expect(titles).toHaveLength(2);
      expect(reads).toEqual([
        "/api/contracts/replacement/document",
        "/api/contracts/replacement",
      ]);
    });
  }
});
