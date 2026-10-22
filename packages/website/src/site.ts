/*
 * Site-wide constants for the marketing pages. Product facts that the client
 * also shows (name, plans, legal links) live in @balebase/ui/brand.
 */
import { productName } from "@balebase/ui/brand";

export const appUrl: string =
  import.meta.env.PUBLIC_APP_URL ?? "http://localhost:5173";

export const siteSections = [
  { href: "/#product", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing" },
] as const;

export type StoreListing = {
  /** Display dimensions for the original vector artwork in public/badges. */
  badge: { height: number; src: string; width: number };
  id: "app-store" | "google-play";
  /** The badge's own wording, used as its alternative text. */
  label: string;
  /** Whether the store has approved the app; unlisted badges show no link. */
  listed: boolean;
  /** The devices the store serves, as the coming-soon note names them. */
  platform: "Android" | "iPhone";
  url: string;
};

/**
 * The production app's store listings. Set `listed` once a store approves the
 * app; until then the badges show without links.
 */
export const storeListings: readonly StoreListing[] = [
  {
    id: "app-store",
    label: "Download on the App Store",
    badge: { src: "/badges/app-store.svg", width: 120, height: 40 },
    // The Apple ID App Store Connect assigned to com.balebase.app.
    url: "https://apps.apple.com/app/id6825740983",
    platform: "iPhone",
    listed: false,
  },
  {
    id: "google-play",
    label: "Get it on Google Play",
    badge: { src: "/badges/google-play.svg", width: 135, height: 40 },
    url: "https://play.google.com/store/apps/details?id=com.balebase.app",
    platform: "Android",
    listed: false,
  },
];

/** The badge's link: its listing once the store lists the app, else none. */
export function storeBadgeHref(listing: StoreListing): string | null {
  return listing.listed ? listing.url : null;
}

/** Names the platforms whose apps aren't listed yet, or null once all are. */
export function storeComingSoonNote(
  listings: readonly StoreListing[],
): string | null {
  const upcoming = listings
    .filter((listing) => !listing.listed)
    .map((listing) => listing.platform);
  if (upcoming.length === 0) return null;
  const platforms = upcoming.join(" and ");
  return upcoming.length === 1
    ? `The ${productName} app for ${platforms} is coming soon.`
    : `The ${productName} apps for ${platforms} are coming soon.`;
}
