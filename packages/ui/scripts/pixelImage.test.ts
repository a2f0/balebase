import { describe, expect, test } from "bun:test";
import { crc32, inflateSync } from "node:zlib";
import {
  encodeIco,
  encodePng,
  parseColor,
  parsePixelSvg,
  renderPixelArt,
} from "./pixelImage";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2"><title>T</title><!-- <path/> -->${body}</svg>`;

// A 4x2 grid: a red pixel at the top left and a blue bar along the bottom.
const art = parsePixelSvg(
  svg(
    '<rect width="1" height="1" fill="#ff0000"/><rect x="0" y="1" width="4" height="1" fill="#0000FF"/>',
  ),
);

function pixel(image: ReturnType<typeof renderPixelArt>, x: number, y: number) {
  const start = (y * image.width + x) * image.channels;
  return [...image.data.subarray(start, start + image.channels)];
}

describe("parsePixelSvg", () => {
  test("reads whole-unit rects in document order", () => {
    expect(art).toEqual({
      height: 2,
      rects: [
        { color: [255, 0, 0], height: 1, width: 1, x: 0, y: 0 },
        { color: [0, 0, 255], height: 1, width: 4, x: 0, y: 1 },
      ],
      width: 4,
    });
  });

  test.each([
    [
      "other elements",
      '<path d="M0 0h1v1z"/>',
      "Unsupported SVG element <path>",
    ],
    [
      "fractions",
      '<rect width="1.5" height="1" fill="#000000"/>',
      "whole number",
    ],
    ["rounding", '<rect width="1" height="1" rx="1" fill="#000000"/>', '"rx"'],
    ["overflow", '<rect x="3" width="2" height="1" fill="#000000"/>', "inside"],
    ["empty rects", '<rect width="0" height="1" fill="#000000"/>', "non-empty"],
    ["short colors", '<rect width="1" height="1" fill="#000"/>', "#rrggbb"],
    ["no rects", "", "no <rect>"],
  ])("rejects %s", (_, body, message) => {
    expect(() => parsePixelSvg(svg(body))).toThrow(message);
  });

  test("requires a viewBox at the origin", () => {
    expect(() =>
      parsePixelSvg(
        '<svg viewBox="1 1 4 2"><rect width="1" height="1"/></svg>',
      ),
    ).toThrow("viewBox");
  });
});

test("parseColor reads #rrggbb", () => {
  expect(parseColor("#B7ff5b")).toEqual([183, 255, 91]);
});

describe("renderPixelArt", () => {
  test("centers the art at the largest whole-number scale", () => {
    // 75% of 13 is 9.75 wide, so each unit becomes 2x2 pixels.
    const image = renderPixelArt(art, { height: 13, percent: 75, width: 13 });
    expect(image.channels).toBe(4);
    // The 8x4 art starts at (2, 4).
    expect(pixel(image, 1, 4)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 2, 4)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 3, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 4, 4)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 9, 7)).toEqual([0, 0, 255, 255]);
    expect(pixel(image, 10, 7)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 9, 8)).toEqual([0, 0, 0, 0]);
  });

  test("fills an opaque background", () => {
    const image = renderPixelArt(art, {
      background: [1, 2, 3],
      height: 4,
      percent: 100,
      width: 6,
    });
    expect(image.channels).toBe(3);
    expect(pixel(image, 0, 0)).toEqual([1, 2, 3]);
    expect(pixel(image, 1, 1)).toEqual([255, 0, 0]);
    expect(pixel(image, 1, 2)).toEqual([0, 0, 255]);
  });

  test("refuses a canvas smaller than the grid", () => {
    expect(() =>
      renderPixelArt(art, { height: 8, percent: 25, width: 8 }),
    ).toThrow("cannot fit");
  });
});

function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const found = new Map<string, Uint8Array>();
  for (let offset = 8; offset < png.length; ) {
    const length = view.getUint32(offset);
    const typed = png.subarray(offset + 4, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length)).toBe(crc32(typed));
    found.set(
      new TextDecoder().decode(typed.subarray(0, 4)),
      typed.subarray(4),
    );
    offset += length + 12;
  }
  return found;
}

describe("encodePng", () => {
  test.each([
    ["RGBA", undefined, 6],
    ["RGB", [9, 9, 9] as const, 2],
  ])("stores %s scanlines that decode to the image", (_, background, type) => {
    const image = renderPixelArt(art, {
      background,
      height: 3,
      percent: 100,
      width: 5,
    });
    const png = encodePng(image);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const found = chunks(png);
    expect([...found.keys()]).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = found.get("IHDR") ?? new Uint8Array();
    const header = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.length);
    expect([header.getUint32(0), header.getUint32(4)]).toEqual([5, 3]);
    expect([header.getUint8(8), header.getUint8(9)]).toEqual([8, type]);
    const scanlines = inflateSync(found.get("IDAT") ?? new Uint8Array());
    const stride = 5 * image.channels;
    for (let row = 0; row < 3; row += 1) {
      expect(scanlines[row * (stride + 1)]).toBe(0);
      expect([
        ...scanlines.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)),
      ]).toEqual([...image.data.subarray(row * stride, (row + 1) * stride)]);
    }
  });
});

test("encodeIco indexes one PNG per size", () => {
  const images = [16, 256].map((size) =>
    renderPixelArt(art, { height: size, percent: 100, width: size }),
  );
  const ico = encodeIco(images);
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  expect([view.getUint16(0, true), view.getUint16(2, true)]).toEqual([0, 1]);
  expect(view.getUint16(4, true)).toBe(2);
  const pngs = images.map(encodePng);
  let offset = 6 + 2 * 16;
  for (const [index, png] of pngs.entries()) {
    const entry = 6 + index * 16;
    // 256 is stored as 0.
    expect(view.getUint8(entry)).toBe(index === 0 ? 16 : 0);
    expect(view.getUint32(entry + 8, true)).toBe(png.length);
    expect(view.getUint32(entry + 12, true)).toBe(offset);
    expect(ico.subarray(offset, offset + png.length)).toEqual(png);
    offset += png.length;
  }
  expect(ico.length).toBe(offset);
});
