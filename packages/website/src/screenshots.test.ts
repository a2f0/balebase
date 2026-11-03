/// <reference types="bun" />
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_MANIFEST,
  parseScreenshotManifest,
  screenshotRoutes,
} from "@a2f0/agent-tool/screenshots/manifest";
import { galleryPage, readGalleryManifest } from "./screenshots";
import { siteSections } from "./site";

const manifest = parseScreenshotManifest({
  schemaVersion: 1,
  projects: [
    { name: "web", label: "Desktop", frame: "none" },
    { name: "mobile", label: "Phone", frame: "phone" },
  ],
  themes: [{ name: "light", label: "Light" }],
  screens: [
    { name: "audit", label: "Audit", alt: "An audit in progress." },
    { name: "groups", label: "Groups" },
  ],
  entries: [
    {
      project: "mobile",
      theme: "light",
      name: "audit",
      src: "/screenshot-gallery/img/mobile/light/audit.png?v=1a2b3c4d",
      width: 1170,
      height: 2532,
    },
    {
      project: "web",
      theme: "light",
      name: "groups",
      src: "/screenshot-gallery/img/web/light/groups.png?v=5e6f7a8b",
      width: 2880,
      height: 1800,
    },
  ],
  capture: null,
});

test("a missing manifest builds an empty gallery with only its index", () => {
  const missing = join(tmpdir(), "no-such-gallery", "manifest.json");
  expect(readGalleryManifest(missing)).toEqual(EMPTY_MANIFEST);
  expect(screenshotRoutes(EMPTY_MANIFEST)).toEqual([
    { params: { slug: undefined }, props: {} },
  ]);
});

test("a staged manifest is read and validated", () => {
  const work = mkdtempSync(join(tmpdir(), "website-gallery-"));
  try {
    const file = join(work, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    expect(readGalleryManifest(file)).toEqual(manifest);
    writeFileSync(file, JSON.stringify({ schemaVersion: 2 }));
    expect(() => readGalleryManifest(file)).toThrow();
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
});

test("each deep link has its own heading, title, and description", () => {
  expect(galleryPage(manifest)).toEqual({
    description: expect.stringContaining("desktop, tablet, and phone"),
    heading: "Screenshots",
    title: "Screenshots — Balebase",
  });
  expect(galleryPage(manifest, "mobile", "audit")).toEqual({
    description: "An audit in progress. Shown in the phone layout.",
    heading: "Audit, phone screenshot",
    title: "Audit, phone screenshot — Balebase",
  });
  // A screen without alt text is described by its label.
  expect(galleryPage(manifest, "web", "groups").description).toBe(
    "Groups in Balebase. Shown in the desktop layout.",
  );
});

test("the site navigation links the gallery at its trailing-slash URL", () => {
  expect(siteSections).toContainEqual({
    href: "/screenshots/",
    label: "Screenshots",
  });
});
