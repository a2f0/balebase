/*
 * The screenshot gallery's manifest, which `bun run screenshots` stages from
 * the shared capture into public/screenshot-gallery before each dev or build
 * (agent-tool.json `screenshots.targets.website`). Builds that skip staging,
 * such as the tests' bare `astro build`, see no manifest and render an empty
 * gallery.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  EMPTY_MANIFEST,
  parseScreenshotManifest,
  projectInfo,
  type ScreenshotManifest,
  screenInfo,
  screenshotHeading,
} from "@a2f0/agent-tool/screenshots/manifest";
import { productName } from "@balebase/ui/brand";

export const galleryManifestUrl = "/screenshot-gallery/manifest.json";
export const galleryPath = "/screenshots";

// Browser tests build against a fixture gallery instead of the staged one.
const { SCREENSHOT_GALLERY_MANIFEST } = process.env;

/** Reads the staged manifest; paths are relative to the website package. */
export function readGalleryManifest(
  file = SCREENSHOT_GALLERY_MANIFEST ||
    "public/screenshot-gallery/manifest.json",
): ScreenshotManifest {
  if (!existsSync(file)) return EMPTY_MANIFEST;
  return parseScreenshotManifest(JSON.parse(readFileSync(file, "utf8")));
}

export const galleryTitleTemplate = `{heading} — ${productName}`;

const indexDescription = `See ${productName} on desktop, tablet, and phone, in light and dark themes: projects, audits, issues, equipment, contracts, finance, and more, with one sample company's records.`;

/**
 * The heading, title, and description of the gallery's index (no project or
 * screen) or of one screen's deep link, described by its alt text.
 */
export function galleryPage(
  manifest: ScreenshotManifest,
  project?: string,
  screen?: string,
) {
  if (!project || !screen) {
    const heading = "Screenshots";
    return {
      description: indexDescription,
      heading,
      title: galleryTitleTemplate.replace("{heading}", heading),
    };
  }
  const heading = screenshotHeading(manifest, project, screen);
  const { alt, label } = screenInfo(manifest, screen);
  const layout = projectInfo(manifest, project).label.toLowerCase();
  // Each layout's deep link needs its own description.
  const description = `${alt ?? `${label} in ${productName}.`} Shown in the ${layout} layout.`;
  return {
    description,
    heading,
    title: galleryTitleTemplate.replace("{heading}", heading),
  };
}
