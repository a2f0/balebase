import { describe, expect, it } from "bun:test";
import type {
  Business,
  BusinessListing,
} from "@balebase/validators/businesses";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessListView } from "./Businesses";
import {
  type BusinessListEvent,
  type BusinessListState,
  businessListReducer,
  initialBusinessListState,
} from "./businessState";

const acme: Business = {
  city: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  duns: null,
  ein: null,
  id: "business-1",
  incorporationDate: null,
  name: "Acme, Inc.",
  state: null,
  streetAddress: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  zip: null,
};

function renderState(state: BusinessListState) {
  const noop = () => {};
  return renderToStaticMarkup(
    <BusinessListView
      {...state}
      copyNotice={undefined}
      onAddingChange={noop}
      onCopy={noop}
      onCreated={noop}
      onDeleted={noop}
      onError={noop}
      onNavigate={noop}
      onUpdated={noop}
    />,
  );
}

function renderBusinesses(data: BusinessListing) {
  return renderState({
    adding: false,
    data,
    deletions: 0,
    error: undefined,
    loading: false,
    notice: undefined,
  });
}

const headerAction = /<div class="pageActions">[\s\S]*?Add business<\/button>/;
const createForm = "Add a business";

describe("business list page", () => {
  it("offers no way to add a business to read-only members", () => {
    for (const businesses of [[], [acme]]) {
      const html = renderBusinesses({ businesses, canManage: false });
      expect(html).not.toContain(createForm);
      expect(html).not.toMatch(headerAction);
      expect(html).toContain("Only organization owners and admins");
    }
  });
});

describe("adding a business", () => {
  // Drives the page's own reducer through what a user does, rendering each
  // state the way the page would.
  function step(state: BusinessListState, event: BusinessListEvent) {
    const next = businessListReducer(state, event);
    return { html: renderState(next), next };
  }

  it("reopens the form when the last business is deleted", () => {
    const state = businessListReducer(
      { ...initialBusinessListState, loading: false },
      { type: "loaded", data: { businesses: [acme], canManage: true } },
    );
    const view = step(state, { type: "deleted", id: acme.id });
    expect(view.html).toContain(createForm);
    expect(view.html).not.toMatch(headerAction);
  });
});
