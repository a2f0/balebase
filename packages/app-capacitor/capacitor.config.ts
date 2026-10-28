import type { CapacitorConfig } from "@capacitor/cli";
import { nativeReleaseTarget } from "./nativeReleaseTarget.ts";

// The native release tier picks the store app (nativeReleaseTargets.json).
const { appIdentifier, appName } = nativeReleaseTarget();

const config: CapacitorConfig = {
  appId: appIdentifier,
  appName,
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
