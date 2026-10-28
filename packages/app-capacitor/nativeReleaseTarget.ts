import targets from "./nativeReleaseTargets.json" with { type: "json" };

// nativeReleaseTargets.json defines each native store tier once. The Capacitor
// and Vite configs read it here; Fastlane (fastlane/lib/native_release_target.rb)
// and Gradle (android/app/build.gradle) read the same file.
type NativeReleaseTier = keyof typeof targets.tiers;

function isNativeReleaseTier(tier: string): tier is NativeReleaseTier {
  return Object.hasOwn(targets.tiers, tier);
}

/** The store target NATIVE_RELEASE_TIER selects, production by default. */
export function nativeReleaseTarget() {
  const { NATIVE_RELEASE_TIER } = process.env;
  const tier = (NATIVE_RELEASE_TIER ?? targets.defaultTier)
    .trim()
    .toLowerCase();
  if (!isNativeReleaseTier(tier)) {
    const expected = Object.keys(targets.tiers).join(" or ");
    throw new Error(
      `Unknown NATIVE_RELEASE_TIER=${JSON.stringify(tier)}. Expected ${expected}.`,
    );
  }
  return targets.tiers[tier];
}
