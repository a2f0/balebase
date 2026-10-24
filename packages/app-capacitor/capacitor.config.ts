import type { CapacitorConfig } from "@capacitor/cli";

// The native release tier picks the store app; fastlane/lib/native_release_target.rb
// maps the same tiers to Gradle build types, Xcode schemes, and secrets folders.
const { NATIVE_RELEASE_TIER } = process.env;
const nativeReleaseTier = (NATIVE_RELEASE_TIER ?? "production")
  .trim()
  .toLowerCase();
if (nativeReleaseTier !== "production" && nativeReleaseTier !== "staging") {
  throw new Error(
    `Unknown NATIVE_RELEASE_TIER=${JSON.stringify(nativeReleaseTier)}. Expected production or staging.`,
  );
}
const isStagingRelease = nativeReleaseTier === "staging";

const config: CapacitorConfig = {
  appId: isStagingRelease ? "com.balebase.staging.app" : "com.balebase.app",
  appName: isStagingRelease ? "Balebase Staging" : "Balebase",
  webDir: "dist",
  backgroundColor: "#181916",
  // Saving a password sends it through the bridge. Disable Capacitor's
  // request/response logging, including on debug builds.
  loggingBehavior: "none",
  ios: { contentInset: "always" },
  // PackageDescription 6 knows the iOS 18 deployment target used by pdf.js.
  experimental: { ios: { spm: { swiftToolsVersion: "6.0" } } },
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
  },
  plugins: {
    // Native networking keeps authenticated requests out of WebView third-party
    // cookie restrictions. This must also be enabled in release builds.
    CapacitorHttp: { enabled: true },
    // Android draws the page under the system bars from the first frame;
    // index.html adds viewport-fit=cover there once the page loads.
    SystemBars: { initialViewportFitValueHint: "cover" },
  },
};

export default config;
