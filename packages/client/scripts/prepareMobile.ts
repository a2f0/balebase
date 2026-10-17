import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { allImages } from "../../ui/scripts/buildImages";
import { parsePixelSvg } from "../../ui/scripts/pixelImage";

const clientRoot = resolve(import.meta.dir, "..");
const svg = await readFile(join(clientRoot, "../ui/assets/logo.svg"), "utf8");
for (const [path, content] of allImages(parsePixelSvg(svg), svg)) {
  if (!path.startsWith("ios/") && !path.startsWith("android/")) continue;
  const target = join(clientRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

// Restore the binary wrapper from the pinned CLI rather than tracking a JAR.
const cliRoot = dirname(
  createRequire(import.meta.url).resolve("@capacitor/cli/package.json"),
);
execFileSync("tar", [
  "-xzf",
  join(cliRoot, "assets/android-template.tar.gz"),
  "-C",
  join(clientRoot, "android"),
  "gradle/wrapper/gradle-wrapper.jar",
]);
console.log("Prepared native icons, splash screens, and Gradle wrapper.");
