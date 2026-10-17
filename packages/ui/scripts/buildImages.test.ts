import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { allImages, favicons } from "./buildImages";
import { parsePixelSvg } from "./pixelImage";

const svg = await readFile(
  join(import.meta.dir, "..", "assets", "logo.svg"),
  "utf8",
);
const art = parsePixelSvg(svg);

/** Width, height, and PNG color type (2 is RGB, 6 is RGBA). */
function pngHeader(content: string | Uint8Array | undefined) {
  if (!(content instanceof Uint8Array)) throw new Error("Expected a PNG.");
  const view = new DataView(content.buffer, content.byteOffset);
  return [view.getUint32(16), view.getUint32(20), view.getUint8(25)];
}

test("the logo is a 16x16 grid", () => {
  expect([art.width, art.height]).toEqual([16, 16]);
});

describe("favicons", () => {
  const outputs = favicons(art, svg);

  test("serve the logo as-is beside raster fallbacks", () => {
    expect([...outputs.keys()]).toEqual([
      "favicon.svg",
      "favicon.ico",
      "apple-touch-icon.png",
    ]);
    expect(outputs.get("favicon.svg")).toBe(svg);
    expect(pngHeader(outputs.get("apple-touch-icon.png"))).toEqual([
      180, 180, 2,
    ]);
  });

  test("pack 16, 32, and 48 pixel icons", () => {
    const ico = outputs.get("favicon.ico");
    if (!(ico instanceof Uint8Array)) throw new Error("Expected an icon.");
    const view = new DataView(ico.buffer, ico.byteOffset);
    const sizes = [0, 1, 2].map((index) => view.getUint8(6 + index * 16));
    expect(sizes).toEqual([16, 32, 48]);
  });
});

describe("allImages", () => {
  const outputs = allImages(art, svg);
  const res = "android/app/src/main/res";
  const xcassets = "ios/App/App/Assets.xcassets";

  test.each([
    ["plaid/icon-1024.png", 1024, 1024, 2],
    [`${xcassets}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 1024, 2],
    [`${xcassets}/Splash.imageset/splash@3x.png`, 2732, 2732, 2],
    ["web/apple-touch-icon.png", 180, 180, 2],
    [`${res}/mipmap-mdpi/ic_launcher.png`, 48, 48, 2],
    [`${res}/mipmap-xxxhdpi/ic_launcher_round.png`, 192, 192, 2],
    [`${res}/mipmap-hdpi/ic_launcher_foreground.png`, 162, 162, 6],
    [`${res}/drawable-land-mdpi/splash.png`, 480, 320, 2],
    [`${res}/drawable-port-xxxhdpi/splash.png`, 1280, 1920, 2],
  ])("renders %s at %ix%i", (path, width, height, colorType) => {
    expect(pngHeader(outputs.get(path))).toEqual([width, height, colorType]);
  });

  test("covers every density and splash orientation", () => {
    const paths = [...outputs.keys()];
    expect(paths.filter((path) => path.includes("/mipmap-"))).toHaveLength(15);
    expect(paths.filter((path) => path.endsWith("/splash.png"))).toHaveLength(
      11,
    );
    expect(outputs.get(`${res}/values/ic_launcher_background.xml`)).toContain(
      ">#B7FF5B<",
    );
  });
});
