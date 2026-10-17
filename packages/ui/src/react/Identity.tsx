import logoUrl from "../../assets/logo.svg";
import { productName } from "../brand";
import { cx } from "./cx";

/** The pixel B tile from assets/logo.svg, which the favicons share. */
export function BrandMark({ className }: { className?: string | undefined }) {
  return <img alt="" className={cx("brandMark", className)} src={logoUrl} />;
}

export function Logo({ className }: { className?: string | undefined }) {
  return (
    <span className={cx("brand", className)}>
      <BrandMark />
      <span>{productName}</span>
    </span>
  );
}

export function Avatar({
  className,
  name,
  size = "md",
}: {
  className?: string | undefined;
  name: string;
  size?: "lg" | "md" | "sm" | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "avatar",
        size === "sm" && "avatarSm",
        size === "lg" && "avatarLg",
        className,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}

/**
 * Up to two initials: the first two words of a name, or, for a single word
 * such as an email address, its first two dot-, dash-, or @-separated parts.
 */
export function initialsFor(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const parts =
    words.length > 1
      ? words
      : (words[0] ?? "").split(/[@._-]+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    // Array.from keeps emoji and other astral characters whole.
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}
