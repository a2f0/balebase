import { ButtonLink } from "@balebase/ui/react";
import type { ComponentProps, MouseEvent } from "react";

interface Destination {
  href: string;
  onNavigate: (pathname: string) => void;
}

/**
 * A link within the app. A plain click opens `href` without a page load;
 * a modified or middle click is left to the browser, for a new tab or window.
 */
export function AppLink({
  href,
  onNavigate,
  ...props
}: Omit<ComponentProps<"a">, "href" | "onClick"> & Destination) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => followLink(event, href, onNavigate)}
    />
  );
}

/** An `AppLink` that looks like a button. */
export function AppButtonLink({
  href,
  onNavigate,
  ...props
}: Omit<ComponentProps<typeof ButtonLink>, "href" | "onClick"> & Destination) {
  return (
    <ButtonLink
      {...props}
      href={href}
      onClick={(event) => followLink(event, href, onNavigate)}
    />
  );
}

function followLink(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate: (pathname: string) => void,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  onNavigate(href);
}
