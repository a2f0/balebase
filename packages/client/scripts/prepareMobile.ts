import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const clientRoot = resolve(import.meta.dir, "..");
for (const platform of ["ios", "android"]) {
  await cp(
    join(clientRoot, "../ui/dist/images", platform),
    join(clientRoot, platform),
    { recursive: true },
  );
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
