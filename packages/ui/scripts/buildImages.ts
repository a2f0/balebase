import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  encodeIco,
  encodePng,
  type PixelArt,
  parseColor,
  parsePixelSvg,
  type Rgb,
  renderPixelArt,
} from "./pixelImage";

/*
 * Generates the raster brand images from assets/logo.svg; none of them are
 * committed. With --favicons <dir>, it writes the browser icons a site serves
 * (the website and client builds do this for public/). Without arguments, it
 * writes the full set to dist/images: favicons, native app icons and splash
 * screens laid out like Capacitor's ios/ and android/ projects, and the icon
 * uploaded to Plaid.
 */

type Output = [path: string, content: string | Uint8Array];
const outputs = (entries: Output[]) => new Map(entries);

// Match --color-lime and --color-ink in src/styles/tokens.css.
const limeHex = "#b7ff5b";
const lime = parseColor(limeHex);
const ink = parseColor("#181916");

function png(
  art: PixelArt,
  options: { background?: Rgb; height?: number; percent: number; size: number },
) {
  return encodePng(
    renderPixelArt(art, {
      background: options.background,
      height: options.height ?? options.size,
      percent: options.percent,
      width: options.size,
    }),
  );
}

export function favicons(art: PixelArt, svg: string) {
  return outputs([
    ["favicon.svg", svg],
    // Transparent and edge to edge, like favicon.svg, for /favicon.ico.
    [
      "favicon.ico",
      encodeIco(
        [16, 32, 48].map((size) =>
          renderPixelArt(art, { height: size, percent: 100, width: size }),
        ),
      ),
    ],
    // iOS fills transparent home-screen icon pixels with black.
    [
      "apple-touch-icon.png",
      png(art, { background: lime, percent: 80, size: 180 }),
    ],
  ]);
}

const iosAssets = "ios/App/App/Assets.xcassets";

function iosImages(art: PixelArt) {
  // The square splash is scaled to cover the screen, so keep the mark small.
  const splash = png(art, { background: ink, percent: 20, size: 2732 });
  return outputs([
    // App Store icons must be opaque; iOS rounds the corners itself.
    [
      `${iosAssets}/AppIcon.appiconset/AppIcon-512@2x.png`,
      png(art, { background: lime, percent: 75, size: 1024 }),
    ],
    [`${iosAssets}/Splash.imageset/splash.png`, splash],
    [`${iosAssets}/Splash.imageset/splash@2x.png`, splash],
    [`${iosAssets}/Splash.imageset/splash@3x.png`, splash],
  ]);
}

const androidResources = "android/app/src/main/res";
// Each density's size relative to mdpi (160 dpi).
const androidDensities = {
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
};
// Landscape splash sizes; portrait swaps them.
const androidSplashSizes = {
  mdpi: [480, 320],
  hdpi: [800, 480],
  xhdpi: [1280, 720],
  xxhdpi: [1600, 960],
  xxxhdpi: [1920, 1280],
} satisfies Record<keyof typeof androidDensities, [number, number]>;

function androidImages(art: PixelArt) {
  const images = outputs([
    // Capacitor's adaptive icon draws its foreground on this color.
    [
      `${androidResources}/values/ic_launcher_background.xml`,
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${limeHex.toUpperCase()}</color>\n</resources>\n`,
    ],
  ]);
  for (const [density, factor] of Object.entries(androidDensities)) {
    const mipmap = `${androidResources}/mipmap-${density}`;
    const launcher = 48 * factor;
    images.set(
      `${mipmap}/ic_launcher.png`,
      png(art, { background: lime, percent: 70, size: launcher }),
    );
    images.set(
      `${mipmap}/ic_launcher_round.png`,
      png(art, { background: lime, percent: 50, size: launcher }),
    );
    // Adaptive icon layers are 108dp; launchers may mask all but the
    // center 66dp, which the 60% tile stays inside.
    images.set(
      `${mipmap}/ic_launcher_foreground.png`,
      png(art, { percent: 60, size: 108 * factor }),
    );
  }
  for (const [density, [long, short]] of Object.entries(androidSplashSizes)) {
    for (const [orientation, width, height] of [
      ["land", long, short],
      ["port", short, long],
    ] as const) {
      images.set(
        `${androidResources}/drawable-${orientation}-${density}/splash.png`,
        png(art, { background: ink, height, percent: 30, size: width }),
      );
    }
  }
  return images;
}

export function allImages(art: PixelArt, svg: string) {
  const web = [...favicons(art, svg)].map(
    ([path, content]): Output => [`web/${path}`, content],
  );
  return outputs([
    ...web,
    ...iosImages(art),
    ...androidImages(art),
    // Uploaded to Plaid; the margin keeps the B whole under a circular crop.
    [
      "plaid/icon-1024.png",
      png(art, { background: lime, percent: 75, size: 1024 }),
    ],
  ]);
}

async function write(directory: string, files: Map<string, Output[1]>) {
  for (const [path, content] of files) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  console.log(`Wrote ${files.size} brand images to ${directory}`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { favicons: { type: "string" } } });
  const packageRoot = resolve(import.meta.dir, "..");
  const svg = await readFile(join(packageRoot, "assets", "logo.svg"), "utf8");
  const art = parsePixelSvg(svg);
  if (values.favicons) {
    await write(resolve(values.favicons), favicons(art, svg));
  } else {
    await write(join(packageRoot, "dist", "images"), allImages(art, svg));
  }
}
