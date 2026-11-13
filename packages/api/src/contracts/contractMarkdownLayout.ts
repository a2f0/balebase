import {
  ContractMarkdownError,
  type ContractMarkdownField,
  contractMarkdownLimits,
} from "@balebase/validators/contractMarkdown";
import type { ContractDraft } from "@balebase/validators/contracts";
import { type PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

export interface ContractMarkdownFonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

type TextPiece = {
  type: "text";
  text: string;
  font: PDFFont;
  size: number;
  width: number;
};
type FieldPiece = {
  type: "field";
  field: ContractMarkdownField;
  width: number;
  boxHeight: number;
  labels: string[];
};
type LinePiece = TextPiece | FieldPiece;

const pageWidth = 612;
const pageHeight = 792;
const margin = 51;
const lineGap = 4;
const fieldGap = 8;
const labelSize = 8;
const labelLeading = 11;
const sizes = {
  signature: { width: 200, height: 56, title: "Signature" },
  initials: { width: 84, height: 42, title: "Initials" },
  name: { width: 180, height: 28, title: "Name" },
  date_signed: { width: 110, height: 28, title: "Date signed" },
  text: { width: 180, height: 28, title: "Text" },
} as const;

/** Standard PDF fonts must never silently replace contract wording. */
function measure(text: string, font: PDFFont, size: number) {
  try {
    font.encodeText(text);
    return font.widthOfTextAtSize(text, size);
  } catch {
    for (const character of text) {
      try {
        font.encodeText(character);
      } catch {
        throw new ContractMarkdownError(
          `The PDF font cannot render "${character}" (U+${character.codePointAt(0)?.toString(16).toUpperCase()}). Replace it with supported text before saving.`,
        );
      }
    }
    throw new ContractMarkdownError(
      "The PDF font cannot render this contract text.",
    );
  }
}

/** Shares one measured line buffer between drawing and field-coordinate output. */
export class ContractMarkdownLayout {
  readonly fields: ContractDraft["fields"] = [];
  private page: PDFPage;
  private top = margin;
  private indent = 0;
  private prefix = "";
  private size = 11;
  private pieces: LinePiece[] = [];
  private used = 0;

  constructor(
    private readonly document: PDFDocument,
    private readonly fonts: ContractMarkdownFonts,
  ) {
    this.page = this.newPage();
  }

  private newPage() {
    if (this.document.getPageCount() >= contractMarkdownLimits.pages) {
      throw new ContractMarkdownError(
        `The contract exceeds ${contractMarkdownLimits.pages} PDF pages. Shorten its content.`,
      );
    }
    this.top = margin;
    return this.document.addPage([pageWidth, pageHeight]);
  }

  begin(size: number, prefix = "") {
    this.size = size;
    this.prefix = prefix;
    this.indent = prefix ? measure(prefix, this.fonts.regular, size) + 12 : 0;
  }

  private get available() {
    return pageWidth - 2 * margin - this.indent;
  }

  private add(piece: LinePiece) {
    const width = piece.width + (piece.type === "field" ? fieldGap : 0);
    if (this.used + width > this.available && this.pieces.length) this.flush();
    this.pieces.push(piece);
    this.used += width;
  }

  text(text: string, font: PDFFont) {
    for (const token of text.split(/(\r\n|\r|\n|[^\S\r\n]+)/)) {
      if (!token) continue;
      if (/^(?:\r\n|\r|\n)$/.test(token)) {
        this.flush(true);
        continue;
      }
      const width = measure(token, font, this.size);
      if (width <= this.available) {
        this.add({ type: "text", text: token, width, font, size: this.size });
        continue;
      }
      // Long unbroken words wrap without a hyphen or any textual substitution.
      let fragment = "";
      let fragmentWidth = 0;
      for (const character of token) {
        const characterWidth = measure(character, font, this.size);
        if (fragmentWidth + characterWidth > this.available) {
          this.add({
            type: "text",
            text: fragment,
            width: fragmentWidth,
            font,
            size: this.size,
          });
          this.flush();
          fragment = "";
          fragmentWidth = 0;
        }
        fragment += character;
        fragmentWidth += characterWidth;
      }
      if (fragment)
        this.add({
          type: "text",
          text: fragment,
          width: fragmentWidth,
          font,
          size: this.size,
        });
    }
  }

  field(field: ContractMarkdownField) {
    const size = sizes[field.kind];
    const label = `${field.label || size.title} (${field.role})`;
    const labels: string[] = [];
    let line = "";
    let width = 0;
    for (const character of label) {
      const characterWidth = measure(character, this.fonts.regular, labelSize);
      if (width + characterWidth > size.width) {
        labels.push(line);
        line = "";
        width = 0;
      }
      line += character;
      width += characterWidth;
    }
    if (line) labels.push(line);
    this.add({
      type: "field",
      field,
      width: size.width,
      boxHeight: size.height,
      labels,
    });
  }

  break() {
    this.flush(true);
  }

  end() {
    this.flush(true);
    this.top += 8;
  }

  private flush(force = false) {
    if (!this.pieces.length && !force) return;
    const height = Math.max(
      this.size * 1.4,
      ...this.pieces.map((piece) =>
        piece.type === "text"
          ? piece.size * 1.4
          : piece.labels.length * labelLeading + 4 + piece.boxHeight + lineGap,
      ),
    );
    if (this.top + height > pageHeight - margin) this.page = this.newPage();
    if (this.prefix) {
      this.page.drawText(this.prefix, {
        x: margin,
        y: pageHeight - this.top - this.size,
        size: this.size,
        font: this.fonts.regular,
      });
      this.prefix = "";
    }
    let x = margin + this.indent;
    for (const piece of this.pieces) {
      if (piece.type === "text") {
        this.page.drawText(piece.text, {
          x,
          y: pageHeight - this.top - piece.size,
          size: piece.size,
          font: piece.font,
        });
        x += piece.width;
        continue;
      }
      for (const [index, label] of piece.labels.entries()) {
        this.page.drawText(label, {
          x,
          y: pageHeight - this.top - labelSize - index * labelLeading,
          size: labelSize,
          font: this.fonts.regular,
        });
      }
      const boxTop = this.top + piece.labels.length * labelLeading + 4;
      this.page.drawRectangle({
        x,
        y: pageHeight - boxTop - piece.boxHeight,
        width: piece.width,
        height: piece.boxHeight,
        borderWidth: 0.5,
        borderColor: rgb(0.55, 0.55, 0.55),
      });
      this.fields.push({
        type: piece.field.kind,
        recipientKey: piece.field.role,
        label: piece.field.label || null,
        required: piece.field.required,
        page: this.document.getPageCount(),
        x: x / pageWidth,
        y: boxTop / pageHeight,
        width: piece.width / pageWidth,
        height: piece.boxHeight / pageHeight,
      });
      x += piece.width + fieldGap;
    }
    this.top += height;
    this.pieces = [];
    this.used = 0;
  }
}
