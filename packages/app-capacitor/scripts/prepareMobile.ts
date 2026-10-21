import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
for (const platform of ["ios", "android"]) {
  await cp(
    join(packageRoot, "../ui/dist/images", platform),
    join(packageRoot, platform),
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
  join(packageRoot, "android"),
  "gradle/wrapper/gradle-wrapper.jar",
]);
console.log("Prepared native icons, splash screens, and Gradle wrapper.");
