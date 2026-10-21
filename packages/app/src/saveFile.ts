import { nativeHost } from "./host";

/** Saves downloaded bytes; a native shell saves or shares them its own way. */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  const native = nativeHost();
  if (native) return native.saveFile(blob, filename);

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
