import type { ComponentProps } from "react";
import { cx } from "./cx";

/** Styled dropdown with native keyboard, form, and mobile picker behavior. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cx("select", className)} />;
}
