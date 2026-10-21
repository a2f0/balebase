import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.balebase.app",
  appName: "Balebase",
  webDir: "dist-mobile",
  backgroundColor: "#181916",
  // cap run builds this Gradle flavor; staging has its own Play application ID.
  android: { flavor: "production" },
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
  },
};

export default config;
