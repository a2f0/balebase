import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/** Native downloads use the system share sheet, including Save to Files. */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }

  // Keep files long enough for Android's receiving app to read them after the
  // chooser closes. Prune old exports on the next download; the OS may also
  // evict this cache. Never expose the rest of the app's storage to sharing.
  const directory = Directory.Cache;
  const previous = await Filesystem.readdir({
    directory,
    path: "downloads",
  }).catch(() => ({ files: [] }));
  for (const file of previous.files) {
    if (file.mtime < Date.now() - 24 * 60 * 60 * 1000) {
      await Filesystem.rmdir({
        directory,
        path: `downloads/${file.name}`,
        recursive: true,
      }).catch(() => undefined);
    }
  }
  const safeName =
    filename
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .replace(/^\.+/, "")
      .slice(-200) || "download";
  const folder = `downloads/${crypto.randomUUID()}`;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not prepare the download."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({
    directory,
    path: `${folder}/${safeName}`,
    data,
    recursive: true,
  });
  try {
    await Share.share({
      files: [uri],
      title: safeName,
      dialogTitle: "Save or share file",
    });
    return true;
  } catch (error) {
    await Filesystem.rmdir({ directory, path: folder, recursive: true }).catch(
      () => undefined,
    );
    if (error instanceof Error && error.message === "Share canceled")
      return false;
    throw error;
  }
}
