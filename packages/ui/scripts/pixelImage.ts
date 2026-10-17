import { crc32, deflateSync } from "node:zlib";

/*
 * Pixel art is a grid of opaque, whole-unit rectangles, read from an SVG made
 * only of <rect> elements. Rendering it at a whole-number scale maps every
 * grid unit to an exact block of output pixels, so images need no
 * anti-aliasing and stay crisp at every size.
 */

export type Rgb = readonly [number, number, number];

interface PixelRect {
  color: Rgb;
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface PixelArt {
  height: number;
  rects: readonly PixelRect[];
  width: number;
}

/** Row-major pixels: RGB when the image is opaque, RGBA otherwise. */
export interface Image {
  channels: 3 | 4;
  data: Uint8Array;
  height: number;
  width: number;
}

interface Placement {
  height: number;
  /** Largest share of the canvas, in percent, the art may span. */
  percent: number;
  width: number;
}

const ignoredElements = new Set(["svg", "title"]);
const rectAttributes = new Set(["fill", "height", "width", "x", "y"]);

export function parsePixelSvg(source: string): PixelArt {
  const text = source.replace(/<!--[\s\S]*?-->/g, "");
  const viewBox = /<svg\b[^>]*\bviewBox="0 0 (\d+) (\d+)"/.exec(text);
  if (!viewBox) {
    throw new Error('The SVG needs a viewBox of the form "0 0 width height".');
  }
  const width = Number(viewBox[1]);
  const height = Number(viewBox[2]);
  const rects: PixelRect[] = [];
  for (const [, element = "", attributes = ""] of text.matchAll(
    /<(\w+)\b([^>]*)>/g,
  )) {
    if (element === "rect") {
      rects.push(parseRect(attributes, width, height));
    } else if (!ignoredElements.has(element)) {
      throw new Error(
        `Unsupported SVG element <${element}>; draw with whole-unit <rect> elements.`,
      );
    }
  }
  if (rects.length === 0) throw new Error("The SVG has no <rect> elements.");
  return { height, rects, width };
}

function parseRect(source: string, gridWidth: number, gridHeight: number) {
  const attributes = new Map<string, string>();
  for (const [, name = "", value = ""] of source.matchAll(
    /([\w-]+)="([^"]*)"/g,
  )) {
    if (!rectAttributes.has(name)) {
      throw new Error(`Unsupported <rect> attribute "${name}".`);
    }
    attributes.set(name, value);
  }
  const unit = (name: string, fallback?: string) => {
    const value = attributes.get(name) ?? fallback;
    if (value === undefined || !/^\d+$/.test(value)) {
      throw new Error(
        `<rect> ${name} must be a whole number, not ${value ?? "missing"}.`,
      );
    }
    return Number(value);
  };
  const rect: PixelRect = {
    color: parseColor(attributes.get("fill") ?? ""),
    height: unit("height"),
    width: unit("width"),
    x: unit("x", "0"),
    y: unit("y", "0"),
  };
  if (
    rect.width === 0 ||
    rect.height === 0 ||
    rect.x + rect.width > gridWidth ||
    rect.y + rect.height > gridHeight
  ) {
    throw new Error(
      `<rect${source}> must be non-empty and inside the viewBox.`,
    );
  }
  return rect;
}

export function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) throw new Error(`Colors must be #rrggbb, not "${value}".`);
  const channel = (start: number) =>
    Number.parseInt(hex.slice(start, start + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

/** The whole-number scale and centered offset that fit the art. */
function place(art: PixelArt, { height, percent, width }: Placement) {
  const scale = Math.floor(
    Math.min(
      (width * percent) / (100 * art.width),
      (height * percent) / (100 * art.height),
    ),
  );
  if (scale < 1) {
    throw new Error(
      `${percent}% of ${width}x${height} cannot fit the ${art.width}x${art.height} grid.`,
    );
  }
  return {
    left: Math.floor((width - art.width * scale) / 2),
    scale,
    top: Math.floor((height - art.height * scale) / 2),
  };
}

/**
 * Renders the art centered on a canvas. With a background the image is
 * opaque; without one, pixels outside the art stay transparent.
 */
export function renderPixelArt(
  art: PixelArt,
  options: Placement & { background?: Rgb | undefined },
): Image {
  const { background, height, width } = options;
  const { left, scale, top } = place(art, options);
  const image: Image = {
    channels: background ? 3 : 4,
    data: new Uint8Array(width * height * (background ? 3 : 4)),
    height,
    width,
  };
  if (background) fill(image, { height, width, x: 0, y: 0 }, background);
  for (const rect of art.rects) {
    fill(
      image,
      {
        height: rect.height * scale,
        width: rect.width * scale,
        x: left + rect.x * scale,
        y: top + rect.y * scale,
      },
      rect.color,
    );
  }
  return image;
}

function fill(image: Image, area: Omit<PixelRect, "color">, color: Rgb) {
  const pixel = Uint8Array.of(...color, 255).subarray(0, image.channels);
  for (let row = area.y; row < area.y + area.height; row += 1) {
    for (let column = area.x; column < area.x + area.width; column += 1) {
      image.data.set(pixel, (row * image.width + column) * image.channels);
    }
  }
}

const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export function encodePng(image: Image): Uint8Array {
  const stride = image.width * image.channels;
  const scanlines = new Uint8Array((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    // Each scanline keeps its leading 0 byte: filter type "none".
    scanlines.set(
      image.data.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1,
    );
  }
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, image.width);
  header.setUint32(4, image.height);
  header.setUint8(8, 8); // Bits per channel.
  header.setUint8(9, image.channels === 3 ? 2 : 6); // Truecolor, with alpha.
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", new Uint8Array(header.buffer)),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function pngChunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
  return bytes;
}

/** A Windows icon that stores one PNG per size. */
export function encodeIco(images: readonly Image[]): Uint8Array {
  const entries = images.map((image) => ({ image, png: encodePng(image) }));
  const directory = new DataView(new ArrayBuffer(6 + entries.length * 16));
  directory.setUint16(2, 1, true); // Resource type: icon.
  directory.setUint16(4, entries.length, true);
  let offset = directory.byteLength;
  for (const [index, { image, png }] of entries.entries()) {
    const entry = 6 + index * 16;
    // A stored dimension of 0 means 256 pixels.
    directory.setUint8(entry, image.width % 256);
    directory.setUint8(entry + 1, image.height % 256);
    directory.setUint16(entry + 4, 1, true); // Color planes.
    directory.setUint16(entry + 6, 32, true); // Bits per pixel.
    directory.setUint32(entry + 8, png.length, true);
    directory.setUint32(entry + 12, offset, true);
    offset += png.length;
  }
  return Buffer.concat([
    new Uint8Array(directory.buffer),
    ...entries.map(({ png }) => png),
  ]);
}
