import { contractLimits } from "./rules";

export const contractMarkdownLimits = {
  source: 50_000,
  fields: Math.min(200, contractLimits.fields),
  pages: 100,
} as const;

export class ContractMarkdownError extends Error {
  override name = "ContractMarkdownError";
}

export interface ContractMarkdownField {
  id: string;
  role: string;
  kind: "signature" | "initials" | "name" | "date_signed" | "text";
  label: string;
  required: boolean;
}

interface ContractMarkdownMark {
  type: "bold" | "italic";
}

export type ContractMarkdownInline =
  | { type: "text"; text: string; marks?: ContractMarkdownMark[] }
  | { type: "hardBreak" }
  | { type: "contractValue"; attrs: { key: string } }
  | { type: "contractField"; attrs: ContractMarkdownField };

interface ContractMarkdownParagraph {
  type: "paragraph";
  content?: ContractMarkdownInline[];
}

interface ContractMarkdownListItem {
  type: "listItem";
  content: [ContractMarkdownParagraph];
}

export type ContractMarkdownBlock =
  | ContractMarkdownParagraph
  | {
      type: "heading";
      attrs: { level: number };
      content?: ContractMarkdownInline[];
    }
  | { type: "bulletList"; content: ContractMarkdownListItem[] }
  | {
      type: "orderedList";
      attrs?: { start: number };
      content: ContractMarkdownListItem[];
    };

export interface ContractMarkdownDocument {
  type: "doc";
  content: ContractMarkdownBlock[];
}

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const valueKey =
  /^[A-Za-z][A-Za-z0-9_-]{0,99}(\.[A-Za-z][A-Za-z0-9_-]{0,99})*$/;

function invalid(path: string, reason: string): never {
  throw new ContractMarkdownError(
    `Unsupported or invalid contract document at ${path}: ${reason}.`,
  );
}

function record<Key extends string>(
  input: unknown,
  path: string,
  allowedKeys: readonly Key[],
): Partial<Record<Key, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "expected a plain object");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== "string" ||
      !allowedKeys.some((allowed) => allowed === key)
    ) {
      return invalid(path, `unknown attribute "${String(key)}"`);
    }
  }
  return input as Partial<Record<Key, unknown>>;
}

function array(input: unknown, path: string, minimum = 0): unknown[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > contractMarkdownLimits.source
  ) {
    return invalid(
      path,
      `expected ${minimum} to ${contractMarkdownLimits.source} items`,
    );
  }
  for (let index = 0; index < input.length; index++) {
    if (!Object.hasOwn(input, index))
      return invalid(`${path}.${index}`, "missing array item");
  }
  return input;
}

function text(input: unknown, path: string, maximum: number, minimum = 0) {
  if (
    typeof input !== "string" ||
    input.length < minimum ||
    input.length > maximum
  ) {
    return invalid(path, `expected ${minimum} to ${maximum} characters`);
  }
  return input;
}

/** Reject controls without changing any authored or merged text. */
export function assertContractMarkdownText(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 127 ||
      (code < 32 && code !== 9 && code !== 10 && code !== 13)
    ) {
      throw new ContractMarkdownError(
        "Contract text contains unsupported control characters.",
      );
    }
  }
}

class DocumentValidator {
  private readonly ids = new Set<string>();
  private textLength = 0;
  private nodeCount = 0;

  private node<Key extends string>(
    input: unknown,
    path: string,
    keys: readonly Key[],
  ) {
    this.nodeCount++;
    if (this.nodeCount > contractMarkdownLimits.source) {
      return invalid(path, "the document contains too many nodes");
    }
    return record(input, path, keys);
  }

  private field(input: unknown, path: string): ContractMarkdownField {
    const attrs = record(input, path, [
      "id",
      "role",
      "kind",
      "label",
      "required",
    ]);
    const id = text(attrs.id, `${path}.id`, 100, 1);
    const role = text(attrs.role, `${path}.role`, 100, 1);
    if (!identifier.test(id) || !identifier.test(role)) {
      return invalid(
        path,
        "field IDs and roles must be identifiers beginning with a letter",
      );
    }
    const kind = attrs.kind;
    if (
      kind !== "signature" &&
      kind !== "initials" &&
      kind !== "name" &&
      kind !== "date_signed" &&
      kind !== "text"
    ) {
      return invalid(`${path}.kind`, "unknown field kind");
    }
    const label = text(attrs.label, `${path}.label`, contractLimits.fieldLabel);
    if (typeof attrs.required !== "boolean") {
      return invalid(`${path}.required`, "expected true or false");
    }
    if (kind !== "text" && !attrs.required) {
      throw new ContractMarkdownError("Only text fields can be optional.");
    }
    if (this.ids.has(id)) {
      throw new ContractMarkdownError(
        `Duplicate field ID "${id}". Give each field a unique ID.`,
      );
    }
    this.ids.add(id);
    if (this.ids.size > contractMarkdownLimits.fields) {
      throw new ContractMarkdownError(
        `Use at most ${contractMarkdownLimits.fields} signing fields.`,
      );
    }
    return { id, role, kind, label, required: attrs.required };
  }

  private textNode(
    item: Partial<Record<"type" | "text" | "marks" | "attrs", unknown>>,
    path: string,
  ): ContractMarkdownInline {
    record(item, path, ["type", "text", "marks"]);
    const value = text(
      item.text,
      `${path}.text`,
      contractMarkdownLimits.source,
      1,
    );
    this.textLength += value.length;
    if (this.textLength > contractMarkdownLimits.source) {
      throw new ContractMarkdownError("The contract text is too long.");
    }
    if (item.marks === undefined) return { type: "text", text: value };
    const values = array(item.marks, `${path}.marks`);
    if (values.length > 2)
      return invalid(`${path}.marks`, "only bold and italic are supported");
    const seen = new Set<string>();
    const marks: ContractMarkdownMark[] = values.map((value, index) => {
      const mark = record(value, `${path}.marks.${index}`, ["type"]);
      if (mark.type !== "bold" && mark.type !== "italic") {
        return invalid(
          `${path}.marks.${index}`,
          "only bold and italic are supported",
        );
      }
      if (seen.has(mark.type)) {
        throw new ContractMarkdownError(
          "Duplicate text formatting is not supported.",
        );
      }
      seen.add(mark.type);
      return { type: mark.type };
    });
    return { type: "text", text: value, marks };
  }

  private inline(input: unknown, path: string): ContractMarkdownInline {
    const item = this.node(input, path, ["type", "text", "marks", "attrs"]);
    switch (item.type) {
      case "text":
        return this.textNode(item, path);
      case "hardBreak":
        record(item, path, ["type"]);
        return { type: "hardBreak" };
      case "contractValue": {
        record(item, path, ["type", "attrs"]);
        const attrs = record(item.attrs, `${path}.attrs`, ["key"]);
        const key = text(attrs.key, `${path}.attrs.key`, 500, 1);
        if (!valueKey.test(key))
          return invalid(`${path}.attrs.key`, "expected a dotted identifier");
        return { type: "contractValue", attrs: { key } };
      }
      case "contractField":
        record(item, path, ["type", "attrs"]);
        return {
          type: "contractField",
          attrs: this.field(item.attrs, `${path}.attrs`),
        };
      default:
        return invalid(path, "unsupported inline node");
    }
  }

  private inlineContent(input: unknown, path: string) {
    return array(input, path).map((value, index) =>
      this.inline(value, `${path}.${index}`),
    );
  }

  private paragraph(input: unknown, path: string): ContractMarkdownParagraph {
    const item = this.node(input, path, ["type", "content"]);
    if (item.type !== "paragraph")
      return invalid(path, "expected a single paragraph");
    return {
      type: "paragraph",
      ...(item.content === undefined
        ? {}
        : { content: this.inlineContent(item.content, `${path}.content`) }),
    };
  }

  private heading(
    item: Partial<Record<"type" | "attrs" | "content", unknown>>,
    path: string,
  ): ContractMarkdownBlock {
    const attrs = record(item.attrs, `${path}.attrs`, ["level"]);
    if (
      typeof attrs.level !== "number" ||
      !Number.isInteger(attrs.level) ||
      attrs.level < 1 ||
      attrs.level > 6
    ) {
      return invalid(
        `${path}.attrs.level`,
        "expected a heading level from 1 to 6",
      );
    }
    return {
      type: "heading",
      attrs: { level: attrs.level },
      ...(item.content === undefined
        ? {}
        : { content: this.inlineContent(item.content, `${path}.content`) }),
    };
  }

  private listItem(input: unknown, path: string): ContractMarkdownListItem {
    const item = this.node(input, path, ["type", "content"]);
    if (item.type !== "listItem") return invalid(path, "expected a list item");
    const children = array(item.content, `${path}.content`, 1);
    if (children.length !== 1)
      return invalid(path, "lists must contain one paragraph per item");
    return {
      type: "listItem",
      content: [this.paragraph(children[0], `${path}.content.0`)],
    };
  }

  private orderedListAttributes(input: unknown, path: string) {
    if (input === undefined) return undefined;
    const attrs = record(input, path, ["start"]);
    if (
      typeof attrs.start !== "number" ||
      !Number.isInteger(attrs.start) ||
      attrs.start < 1 ||
      attrs.start > 999_999_999
    ) {
      return invalid(
        `${path}.start`,
        "expected a list start from 1 to 999999999",
      );
    }
    return { start: attrs.start };
  }

  private block(input: unknown, path: string): ContractMarkdownBlock {
    const item = record(input, path, ["type", "attrs", "content"]);
    if (item.type === "paragraph") return this.paragraph(input, path);
    this.node(item, path, ["type", "attrs", "content"]);
    if (item.type === "heading") return this.heading(item, path);
    if (item.type !== "bulletList" && item.type !== "orderedList") {
      return invalid(path, "unsupported block node");
    }
    const content = array(item.content, `${path}.content`, 1).map(
      (value, index) => this.listItem(value, `${path}.content.${index}`),
    );
    if (item.type === "bulletList") {
      record(item, path, ["type", "content"]);
      return { type: "bulletList", content };
    }
    const attrs = this.orderedListAttributes(item.attrs, `${path}.attrs`);
    return {
      type: "orderedList",
      ...(attrs === undefined ? {} : { attrs }),
      content,
    };
  }

  validate(input: unknown): ContractMarkdownDocument {
    const document = this.node(input, "document", ["type", "content"]);
    if (document.type !== "doc")
      return invalid("document.type", 'expected "doc"');
    return {
      type: "doc",
      content: array(document.content, "document.content").map((value, index) =>
        this.block(value, `document.content.${index}`),
      ),
    };
  }
}

/** Strict on both source and visual-editor input: nothing can be stripped. */
export function validateContractMarkdownDocument(
  input: unknown,
): ContractMarkdownDocument {
  return new DocumentValidator().validate(input);
}
