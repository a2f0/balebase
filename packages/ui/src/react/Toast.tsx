import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Banner } from "./Banner";
import { cx } from "./cx";

const ToastViewport = createContext<HTMLElement | null | undefined>(undefined);

/** One viewport keeps feedback clear of page transforms and stacks concurrent notices. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <ToastViewport value={viewport}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <section
            aria-label="Notifications"
            className="toastViewport"
            ref={setViewport}
          />,
          document.body,
        )}
    </ToastViewport>
  );
}

/** Floating feedback that stays at the bottom of the viewport without moving content. */
export function Toast({ className, ...props }: ComponentProps<typeof Banner>) {
  const viewport = useContext(ToastViewport);
  const toast = <Banner {...props} className={cx("toast", className)} />;
  // Standalone views retain their fixed toast; a provider waits for its portal target.
  if (viewport === undefined) return toast;
  return viewport ? createPortal(toast, viewport) : null;
}
