import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * agent-tool's own tests cover rendering. These cover what the repository
 * owns in the images section of agent-tool.json: the favicons the pages link,
 * the design-token colors, and Capacitor's project layout.
 */

type Output = { colors?: Record<string, string>; layers?: { fill?: string }[] };

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(root, "node_modules", ".bin", "agent-tool");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function agentTool(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "--repo", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

const { targets } = JSON.parse(agentTool("images", "list")) as {
  targets: { name: string; files: string[] }[];
};
const filesOf = (name: string) =>
  targets.find((target) => target.name === name)?.files.toSorted() ?? [];

test("favicons are exactly the icons the app shells and website link", () => {
  for (const page of [
    "packages/app-web/index.html",
    "packages/app-capacitor/index.html",
    "packages/website/src/layouts/BaseLayout.astro",
  ]) {
    const linked = read(page).matchAll(
      /<link rel="(?:icon|apple-touch-icon)" href="\/([^"]+)"/g,
    );
    expect([...linked].map(([, path]) => path).toSorted()).toEqual(
      filesOf("favicons"),
    );
  }
});

test("the social image is the 1200x630 Open Graph image", () => {
  expect(filesOf("social")).toEqual(["og-image.png"]);
  const out = mkdtempSync(join(tmpdir(), "balebase-social-"));
  try {
    agentTool("images", "build", "social", "--out", out);
    const png = readFileSync(join(out, "og-image.png"));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    // Width, height, and color type (2, opaque RGB) from the IHDR chunk.
    expect([view.getUint32(16), view.getUint32(20), view.getUint8(25)]).toEqual(
      [1200, 630, 2],
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  // The app shell shares the website's copy (socialImage in search.ts).
  const app = read("packages/app-web/index.html");
  for (const tag of [
    '<meta property="og:image" content="https://balebase.com/og-image.png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
  ])
    expect(app).toContain(tag);
});

test("colors are the lime and ink design tokens", () => {
  const { images } = JSON.parse(read("agent-tool.json")) as {
    images: { targets: Record<string, { outputs: Output[] }> };
  };
  const colors = Object.values(images.targets)
    .flatMap((target) => target.outputs)
    .flatMap((output) => [
      ...Object.values(output.colors ?? {}),
      ...(output.layers ?? []).flatMap((layer) => layer.fill ?? []),
    ]);
  // The first rule in tokens.css is the default, light theme.
  const lightTheme = read("packages/ui/src/styles/tokens.css").split("}")[0];
  const token = (name: string) => {
    const value = lightTheme?.match(`--color-${name}: (#[0-9a-f]{6});`)?.[1];
    if (!value) throw new Error(`tokens.css defines no --color-${name}.`);
    return value;
  };
  expect(new Set(colors)).toEqual(new Set([token("lime"), token("ink")]));
});

describe("native images", () => {
  const out = mkdtempSync(join(tmpdir(), "balebase-images-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  agentTool("images", "build", "native", "--out", out);
  const res = "android/app/src/main/res";
  const xcassets = "ios/App/App/Assets.xcassets";

  test("follow Capacitor's ios and android project layout", () => {
    const written = [...new Bun.Glob("**/*").scanSync({ cwd: out })];
    expect(written.toSorted()).toEqual(filesOf("native"));
    expect(written.filter((path) => path.includes("/mipmap-"))).toHaveLength(
      15,
    );
    expect(written.filter((path) => path.includes("/drawable-"))).toHaveLength(
      11,
    );
    expect(
      readFileSync(join(out, res, "values/ic_launcher_background.xml"), "utf8"),
    ).toContain('<color name="ic_launcher_background">#B7FF5B</color>');
  });

  // Store and launcher icons must be opaque (RGB); only the adaptive
  // foreground keeps an alpha channel.
  test.each([
    ["plaid/icon-1024.png", 1024, 1024, 2],
    [`${xcassets}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 1024, 2],
    [`${xcassets}/Splash.imageset/splash@3x.png`, 2732, 2732, 2],
    [`${res}/mipmap-mdpi/ic_launcher.png`, 48, 48, 2],
    [`${res}/mipmap-xxxhdpi/ic_launcher_round.png`, 192, 192, 2],
    [`${res}/mipmap-hdpi/ic_launcher_foreground.png`, 162, 162, 6],
    [`${res}/drawable-mdpi/splash.png`, 320, 480, 2],
    [`${res}/drawable-land-mdpi/splash.png`, 480, 320, 2],
    [`${res}/drawable-port-xxxhdpi/splash.png`, 1280, 1920, 2],
  ])("render %s at %ix%i", (path, width, height, colorType) => {
    const png = readFileSync(join(out, path));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    // Width, height, and color type from the IHDR chunk.
    expect([view.getUint32(16), view.getUint32(20), view.getUint8(25)]).toEqual(
      [width, height, colorType],
    );
  });
});
