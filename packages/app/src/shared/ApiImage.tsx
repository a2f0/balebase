import { type ComponentProps, useEffect, useState } from "react";
import { fetchApi } from "../apiVersion";
import { nativeHost } from "../host";

/** WebView image loads cannot use the native HTTP cookie store. */
export function ApiImage({
  src,
  alt,
  ...props
}: ComponentProps<"img"> & { src: string }) {
  const native = nativeHost() !== undefined;
  const [image, setImage] = useState<{
    url: string;
    blob?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!native) return;
    let active = true;
    let blob: string | undefined;
    const controller = new AbortController();
    void fetchApi(src, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Image unavailable");
        const bytes = await response.blob();
        if (!active) return;
        blob = URL.createObjectURL(bytes);
        setImage({ url: src, blob });
      })
      .catch(() => {
        if (active) setImage({ url: src, failed: true });
      });
    return () => {
      active = false;
      controller.abort();
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [native, src]);
  if (native && image?.url === src && image.failed) {
    return (
      <span className={props.className}>{alt || "Image unavailable"}</span>
    );
  }
  return (
    <img
      {...props}
      alt={alt}
      src={native ? (image?.url === src ? image.blob : undefined) : src}
    />
  );
}
