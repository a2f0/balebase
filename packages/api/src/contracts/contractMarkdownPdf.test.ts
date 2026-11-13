import { describe, expect, it } from "bun:test";
import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import { ContractMarkdownError } from "@balebase/validators/contractMarkdown";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  type PDFPage,
  PDFRawStream,
} from "pdf-lib";
import { renderContractMarkdown } from "./contractMarkdownPdf";

const input: ContractAuthoringInput = {
  formatVersion: 1,
  title: "Agreement",
  source: ':signature{#sig role="client"}',
  recipients: [
    {
      key: "client",
      name: "Sam Signer",
      email: "sam@example.com",
      routingOrder: 1,
    },
  ],
  values: {},
  signingOrder: "parallel",
  message: "",
  dueDate: null,
  reminderIntervalDays: null,
};

function pageOperations(page: PDFPage) {
  const contents = page.node.lookup(PDFName.of("Contents"));
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => {
          const stream = page.doc.context.lookup(ref);
          if (!(stream instanceof PDFRawStream))
            throw new Error("Expected a raw PDF content stream.");
          return stream;
        })
      : contents instanceof PDFRawStream
        ? [contents]
        : [];
  return streams
    .map((stream) =>
      new TextDecoder().decode(decodePDFRawStream(stream).decode()),
    )
    .join("\n");
}

describe("renderContractMarkdown", () => {
  it("paginates fields atomically and derives their exact rectangles from drawing", async () => {
    const source = Array.from(
      { length: 90 },
      (_, index) =>
        `Paragraph ${index}: **terms** and _conditions_.\n\n:signature{#sig-${index} role="client"}`,
    ).join("\n\n");
    const result = await renderContractMarkdown({ ...input, source });
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(result.pageCount);
    expect(result.pageCount).toBeGreaterThan(1);
    expect(result.fields).toHaveLength(90);
    for (const field of result.fields) {
      expect(field.x).toBeGreaterThanOrEqual(51 / 612);
      expect(field.y).toBeGreaterThanOrEqual(51 / 792);
      expect(field.x + field.width).toBeLessThanOrEqual(1 - 51 / 612);
      expect(field.y + field.height).toBeLessThanOrEqual(1 - 51 / 792);
      expect(field.width).toBe(200 / 612);
      expect(field.height).toBe(56 / 792);
      const page = pdf.getPage(field.page - 1);
      const transforms = [
        ...pageOperations(page).matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm/g),
      ];
      expect(
        transforms.some(
          (match) =>
            Math.abs(Number(match[1]) - field.x * 612) < 0.001 &&
            Math.abs(
              Number(match[2]) - (792 - (field.y + field.height) * 792),
            ) < 0.001,
        ),
      ).toBe(true);
    }
  });

  it("keeps a near-bottom signature together on the next page", async () => {
    const source = `${Array.from({ length: 43 }, () => "Line").join("\\\n")}\n\n:signature{#sig role="client"}`;
    const result = await renderContractMarkdown({ ...input, source });
    expect(result.fields[0]?.page).toBe(2);
    expect(result.fields[0]?.y).toBeCloseTo((51 + 11 + 4) / 792);
  });

  it("resolves role values and treats inserted Markdown as literal text", async () => {
    const result = await renderContractMarkdown({
      ...input,
      source:
        '# Terms\n\n:value[client.name] :value[client.email]\n\n:value[project.terms]\n\n**Bold** _Italic_ **_Both_**\n\n:signature{#sig role="client"}',
      values: {
        "project.terms":
          ':signature{#injected role="unknown"} <script> & **literal**',
      },
    });
    expect(result.fields).toHaveLength(1);
    const pdf = await PDFDocument.load(result.bytes);
    const operations = pageOperations(pdf.getPage(0));
    // PDF text operators hold hex-encoded literal text, not HTML or Markdown nodes.
    expect(operations).toContain(
      Buffer.from(":signature{#injected").toString("hex").toUpperCase(),
    );
    expect(operations).toContain(
      Buffer.from("Sam").toString("hex").toUpperCase(),
    );
    const fonts = pdf.getPage(0).node.Resources()?.lookup(PDFName.of("Font"));
    expect(fonts?.toString()).toContain("Helvetica-BoldOblique");
  });

  it("wraps long literal words and reserves every fixed field type", async () => {
    const result = await renderContractMarkdown({
      ...input,
      source: `${"a".repeat(1800)}\n\n:signature{#sig role="client"} :initials{#initials role="client"} :name{#name role="client"} :signed-date{#date role="client"} :text{#text role="client" label="Title" required="false"}`,
    });
    expect(result.fields.map((field) => field.type)).toEqual([
      "signature",
      "initials",
      "name",
      "date_signed",
      "text",
    ]);
    expect(result.fields.at(-1)?.required).toBe(false);
    for (const field of result.fields) {
      expect(field.x + field.width).toBeLessThan(1);
      expect(field.y + field.height).toBeLessThan(1);
    }
  });

  const invalidContent: Partial<ContractAuthoringInput>[] = [
    { source: ':signature{#sig role="missing"}' },
    { source: ":value[project.missing]" },
    {
      source: ":value[client.name]",
      recipients: [
        {
          ...input.recipients[0],
          key: "client",
          name: "",
          email: "sam@example.com",
          routingOrder: 1,
        },
      ],
    },
    { source: ":value[project.name]", values: { "project.name": "   " } },
    { source: "Unsupported emoji: 😀" },
    { source: ':text{#text role="client" label="漢字"}' },
    {
      source: ':signature{#same role="client"} :signature{#same role="client"}',
    },
  ];
  it.each(invalidContent)(
    "rejects unresolved, ambiguous, or unrenderable content",
    async (patch) => {
      await expect(
        renderContractMarkdown({ ...input, ...patch }),
      ).rejects.toBeInstanceOf(ContractMarkdownError);
    },
  );

  it("rejects unsupported signer-name glyphs before a blank name field can be stamped", async () => {
    await expect(
      renderContractMarkdown({
        ...input,
        source: ':name{#name role="client"}',
        recipients: [
          {
            key: "client",
            name: "漢字",
            email: "sam@example.com",
            routingOrder: 1,
          },
        ],
      }),
    ).rejects.toThrow(/name that the PDF font cannot render/);
  });

  it("stops at the page bound instead of emitting an unbounded document", async () => {
    await expect(
      renderContractMarkdown({ ...input, source: "Line\n\n".repeat(4000) }),
    ).rejects.toThrow(/100 PDF pages/);
  });
});
