/*
 * Site-wide constants for the marketing pages. Product facts that the client
 * also shows (name, plans, legal links) live in @balebase/ui/brand.
 */
export const appUrl: string =
  import.meta.env.PUBLIC_APP_URL ?? "http://localhost:5173";

export const siteSections = [
  { href: "/#product", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing" },
] as const;

export type StoreListing = {
  /** Badge artwork in public/badges, drawn at the store's 40px height. */
  badge: { height: number; src: string; width: number };
  id: "app-store" | "google-play";
  /** The badge's own wording, used as its alternative text. */
  label: string;
  /** Whether the store has approved the app; unlisted badges show no link. */
  listed: boolean;
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
    listed: false,
  },
  {
    id: "google-play",
    label: "Get it on Google Play",
    badge: { src: "/badges/google-play.svg", width: 135, height: 40 },
    url: "https://play.google.com/store/apps/details?id=com.balebase.app",
    listed: false,
  },
];
