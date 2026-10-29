import { ButtonLink, Toast } from "@balebase/ui/react";
import { type ComponentProps, type MouseEvent, useRef, useState } from "react";
import { fetchApi } from "../apiVersion";
import { nativeHost } from "../host";
import { saveFile } from "./saveFile";

/** Browser links stay ordinary links; native downloads share authenticated bytes. */
export function ApiDownload({
  filename,
  href,
  plain = false,
  ...props
}: Omit<ComponentProps<typeof ButtonLink>, "onClick" | "href"> & {
  filename: string;
  href: string;
  plain?: boolean;
}) {
  const downloading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const download = async () => {
    try {
      const response = await fetchApi(href, { credentials: "include" });
      if (!response.ok)
        throw new Error("Could not download the file. Please try again.");
      await saveFile(await response.blob(), filename);
    } catch {
      setError("Could not download the file. Please try again.");
    } finally {
      downloading.current = false;
      setBusy(false);
    }
  };
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!nativeHost()) return;
    event.preventDefault();
    if (downloading.current) return;
    downloading.current = true;
    setBusy(true);
    setError(undefined);
    void download();
  };
  const Link = plain ? "a" : ButtonLink;
  return (
    <>
      <Link
        {...props}
        aria-busy={busy || undefined}
        href={href}
        onClick={onClick}
      />
      {error && <Toast tone="danger">{error}</Toast>}
    </>
  );
}
