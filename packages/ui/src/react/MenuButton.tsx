import type { IconName } from "../icons";
import { Button } from "./Button";
import type { ContextMenuButtonProps } from "./ContextMenu";

/**
 * The small icon button a row or card shows for its `ContextMenu`; spread the
 * menu's second render argument on it so the button and right-click open the
 * same actions.
 */
export function MenuButton({
  busy = false,
  disabled = false,
  icon = "more",
  label,
  variant = "ghost",
  ...menuButton
}: ContextMenuButtonProps & {
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  icon?: IconName | undefined;
  /** Names the button, such as "Actions for Acme". */
  label: string;
  variant?: "ghost" | "secondary" | undefined;
}) {
  return (
    <Button
      {...menuButton}
      aria-label={label}
      busy={busy}
      disabled={disabled}
      icon={icon}
      iconOnly
      size="sm"
      variant={variant}
    />
  );
}
