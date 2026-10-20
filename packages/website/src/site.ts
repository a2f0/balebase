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
