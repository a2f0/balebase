/*
 * Site-wide constants for the marketing pages. Product facts that the client
 * also shows (name, plans, legal links) live in @balebase/ui/brand.
 */
import type { ReleaseTier } from "@balebase/diagnostics/config";

export const appUrl: string =
  import.meta.env.PUBLIC_APP_URL ?? "http://localhost:5173";

export const siteSections = [
  { href: "/#product", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/screenshots/", label: "Screenshots" },
] as const;

export type StoreListing = {
  /** Rounded dimensions reserving space for the vector artwork before load. */
  badge: { height: number; src: string; width: number };
  id: "app-store" | "google-play";
  /** The badge's own wording, used as its alternative text. */
  label: string;
  /** Where the badge links on each tier's site. */
  urls: Readonly<Record<ReleaseTier, string>>;
};

/**
 * Each tier's store app. Neither store lists either app yet: the App Store
 * records (the Apple IDs App Store Connect assigned to com.balebase.app and
 * com.balebase.staging.app) are empty until Apple approves the app, and the
 * Google Play links are the internal testing opt-in links, which only testers
 * added in Play Console can join. Once a store approves the production app,
 * point its production URL at the public listing.
 */
export const storeListings: readonly StoreListing[] = [
  {
    id: "app-store",
    label: "Download on the App Store",
    badge: { src: "/badges/app-store.svg", width: 150, height: 50 },
    urls: {
      production: "https://apps.apple.com/app/id6825740983",
      staging: "https://apps.apple.com/app/id6825742254",
    },
  },
  {
    id: "google-play",
    label: "Get it on Google Play",
    badge: { src: "/badges/google-play.svg", width: 169, height: 50 },
    urls: {
      production:
        "https://play.google.com/apps/internaltest/4701348725767206894",
      staging: "https://play.google.com/apps/internaltest/4701038202740460125",
    },
  },
];
