import { type PDFDocument, type PDFFont, rgb } from "pdf-lib";

/** One paragraph of generated text; gap is extra space above it. */
export interface PdfLine {
  bold?: boolean;
  gap?: number;
  size: number;
  text: string;
}

const letterPage = { height: 792, margin: 54, width: 612 };

/** Flows lines onto new US Letter pages, wrapping each to the margins. */
export function addTextPages(
  document: PDFDocument,
  lines: PdfLine[],
  font: PDFFont,
  bold: PDFFont,
) {
  const width = letterPage.width - letterPage.margin * 2;
  let page = document.addPage([letterPage.width, letterPage.height]);
  let y = letterPage.height - letterPage.margin;
  for (const line of lines) {
    const face = line.bold ? bold : font;
    y -= line.gap ?? 0;
    for (const wrapped of wrap(
      encodable(line.text, face),
      face,
      line.size,
      width,
    )) {
      if (y - line.size < letterPage.margin) {
        page = document.addPage([letterPage.width, letterPage.height]);
        y = letterPage.height - letterPage.margin;
      }
      y -= line.size * 1.35;
      page.drawText(wrapped, {
        color: rgb(0.08, 0.09, 0.1),
        font: face,
        size: line.size,
        x: letterPage.margin,
        y,
      });
    }
  }
}

/** Replaces characters the standard font cannot encode, such as CJK. */
export function encodable(value: string, font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return [...value.replace(/[\r\n\t]+/g, " ")]
    .map((character) =>
      supported.has(character.codePointAt(0) ?? 0) ? character : "?",
    )
    .join("");
}

export function formatUtcTimestamp(value: string) {
  return `${value
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "")} UTC`;
}

/** Breaks text into lines that fit, splitting long unbroken runs too. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length - 1;
      while (
        cut > 1 &&
        font.widthOfTextAtSize(rest.slice(0, cut), size) > width
      ) {
        cut -= 1;
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}
