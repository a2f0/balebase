import {
  type ContractAuthoringInput,
  ContractAuthoringSchema,
} from "@balebase/validators/contractAuthoring";
import {
  type ContractMarkdownBlock,
  ContractMarkdownError,
  type ContractMarkdownField,
  type ContractMarkdownInline,
  parseContractMarkdown,
} from "@balebase/validators/contractMarkdown";
import { assertContractMarkdownText } from "@balebase/validators/contractMarkdownDocument";
import type {
  ContractDraft,
  DraftRecipient,
} from "@balebase/validators/contracts";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  type ContractMarkdownFonts,
  ContractMarkdownLayout,
} from "./contractMarkdownLayout";

export interface RenderedContractMarkdown {
  bytes: Uint8Array;
  pageCount: number;
  fields: ContractDraft["fields"];
}

class ContractMarkdownRenderer {
  private readonly roles: Map<string, DraftRecipient>;
  private resolvedLength = 0;

  constructor(
    private readonly authoring: ContractAuthoringInput,
    private readonly fonts: ContractMarkdownFonts,
    private readonly layout: ContractMarkdownLayout,
    private readonly missingValues: "reject" | "placeholder",
  ) {
    this.roles = new Map(
      authoring.recipients.map((recipient) => [recipient.key, recipient]),
    );
  }

  private field(field: ContractMarkdownField) {
    const recipient = this.roles.get(field.role);
    if (!recipient) {
      throw new ContractMarkdownError(
        `Field "${field.id}" references unknown signer role "${field.role}".`,
      );
    }
    if (field.kind === "name") {
      try {
        this.fonts.regular.encodeText(recipient.name);
      } catch {
        throw new ContractMarkdownError(
          `Signer role "${field.role}" has a name that the PDF font cannot render. Use supported characters before saving.`,
        );
      }
    }
    this.layout.field(field);
  }

  private value(key: string) {
    const [roleKey, property, extra] = key.split(".");
    const recipient = roleKey ? this.roles.get(roleKey) : undefined;
    let value: string | undefined;
    if (recipient && !extra && (property === "name" || property === "email")) {
      value = recipient[property];
    } else if (Object.hasOwn(this.authoring.values, key)) {
      value = this.authoring.values[key];
    }
    if (value === undefined || !value.trim()) {
      if (this.missingValues === "placeholder") return `[${key}]`;
      throw new ContractMarkdownError(
        `Supply a non-empty merge value for "${key}".`,
      );
    }
    return value;
  }

  private font(node: ContractMarkdownInline, heading: boolean) {
    const marks = node.type === "text" ? node.marks : undefined;
    const bold = heading || marks?.some((mark) => mark.type === "bold");
    const italic = marks?.some((mark) => mark.type === "italic");
    if (bold) return italic ? this.fonts.boldItalic : this.fonts.bold;
    return italic ? this.fonts.italic : this.fonts.regular;
  }

  private text(
    node: Extract<ContractMarkdownInline, { type: "text" | "contractValue" }>,
    heading: boolean,
  ) {
    const text =
      node.type === "contractValue" ? this.value(node.attrs.key) : node.text;
    this.resolvedLength += text.length;
    if (this.resolvedLength > 200_000) {
      throw new ContractMarkdownError(
        "The resolved contract exceeds 200,000 characters. Shorten its merge values or content.",
      );
    }
    assertContractMarkdownText(text);
    this.layout.text(text, this.font(node, heading));
  }

  private inline(nodes: ContractMarkdownInline[], heading: boolean) {
    for (const node of nodes) {
      switch (node.type) {
        case "hardBreak":
          this.layout.break();
          break;
        case "contractField":
          this.field(node.attrs);
          break;
        case "text":
        case "contractValue":
          this.text(node, heading);
          break;
      }
    }
  }

  block(block: ContractMarkdownBlock) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      let index = block.type === "orderedList" ? (block.attrs?.start ?? 1) : 1;
      for (const item of block.content) {
        this.layout.begin(
          11,
          block.type === "orderedList" ? `${index}.` : "\u2022",
        );
        this.inline(item.content[0].content || [], false);
        this.layout.end();
        index++;
      }
      return;
    }
    const heading = block.type === "heading";
    this.layout.begin(heading ? 26 - block.attrs.level * 2 : 11);
    this.inline(block.content || [], heading);
    this.layout.end();
  }
}

/** The returned boxes and PDF are produced together, never by a second renderer. */
export async function renderContractMarkdown(
  input: ContractAuthoringInput,
  missingValues: "reject" | "placeholder" = "reject",
): Promise<RenderedContractMarkdown> {
  const checked = ContractAuthoringSchema.safeParse(input);
  if (!checked.success) {
    throw new ContractMarkdownError(
      checked.error.issues[0]?.message ||
        "The contract authoring input is invalid.",
    );
  }
  const authoring = checked.data;
  const content = parseContractMarkdown(authoring.source);
  const document = await PDFDocument.create();
  document.setTitle(authoring.title);
  const [regular, bold, italic, boldItalic] = await Promise.all([
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(StandardFonts.HelveticaBold),
    document.embedFont(StandardFonts.HelveticaOblique),
    document.embedFont(StandardFonts.HelveticaBoldOblique),
  ]);
  const fonts: ContractMarkdownFonts = { regular, bold, italic, boldItalic };
  const layout = new ContractMarkdownLayout(document, fonts);
  const renderer = new ContractMarkdownRenderer(
    authoring,
    fonts,
    layout,
    missingValues,
  );
  for (const block of content.content) renderer.block(block);
  return {
    bytes: await document.save(),
    pageCount: document.getPageCount(),
    fields: layout.fields,
  };
}
