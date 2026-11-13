import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import {
  assertContractMarkdownText,
  type ContractMarkdownBlock,
  type ContractMarkdownDocument,
  ContractMarkdownError,
  type ContractMarkdownField,
  type ContractMarkdownInline,
  contractMarkdownLimits,
  validateContractMarkdownDocument,
} from "./contractMarkdownDocument";

export {
  type ContractMarkdownBlock,
  type ContractMarkdownDocument,
  ContractMarkdownError,
  type ContractMarkdownField,
  type ContractMarkdownInline,
  contractMarkdownLimits,
} from "./contractMarkdownDocument";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  spread?: boolean;
  checked?: boolean | null;
  name?: string;
  attributes?: {
    id?: string | null;
    role?: string | null;
    label?: string | null;
    required?: string | null;
    [key: string]: string | null | undefined;
  };
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkDirective)
  .use(remarkStringify, { bullet: "-", emphasis: "_", strong: "*" });
const directiveKinds: Record<string, ContractMarkdownField["kind"]> = {
  signature: "signature",
  initials: "initials",
  name: "name",
  "signed-date": "date_signed",
  text: "text",
};

function unsupported(type: string): never {
  throw new ContractMarkdownError(
    `Unsupported Markdown feature: ${type}. Use paragraphs, headings, flat lists, bold, italic, and contract directives.`,
  );
}

function valueDirective(node: MarkdownNode): ContractMarkdownInline {
  if (
    node.type !== "textDirective" ||
    Object.keys(node.attributes || {}).length
  ) {
    throw new ContractMarkdownError(
      "Values must use :value[key] without attributes.",
    );
  }
  if (node.children?.length !== 1 || node.children[0]?.type !== "text") {
    throw new ContractMarkdownError(
      "A value reference must contain one plain key, for example :value[client.name].",
    );
  }
  return {
    type: "contractValue",
    attrs: { key: node.children[0].value || "" },
  };
}

function directive(node: MarkdownNode): ContractMarkdownInline {
  if (node.name === "value") return valueDirective(node);
  const attributes = node.attributes || {};
  const kind =
    node.name && Object.hasOwn(directiveKinds, node.name)
      ? directiveKinds[node.name]
      : undefined;
  if (!kind)
    throw new ContractMarkdownError(
      `Unknown contract directive "${node.name}".`,
    );
  if (node.children?.length) {
    throw new ContractMarkdownError(
      "Signing fields cannot have directive content; use the label attribute instead.",
    );
  }
  for (const key of Object.keys(attributes)) {
    if (!["id", "role", "label", "required"].includes(key)) {
      throw new ContractMarkdownError(`Unknown field attribute "${key}".`);
    }
  }
  if (
    attributes.required !== undefined &&
    attributes.required !== "true" &&
    attributes.required !== "false"
  ) {
    throw new ContractMarkdownError(
      'Field required must be "true" or "false".',
    );
  }
  return {
    type: "contractField",
    attrs: {
      id: attributes.id || "",
      role: attributes.role || "",
      kind,
      label: attributes.label ?? "",
      required: attributes.required !== "false",
    },
  };
}

/** Remark normalizes duplicate attributes; reject them before that can hide input. */
function checkDirectiveAttributes(node: MarkdownNode, source: string) {
  const raw = source.slice(
    node.position?.start.offset,
    node.position?.end.offset,
  );
  const start = raw.indexOf("{");
  if (start === -1) return;
  const attributes = raw.slice(start + 1, raw.lastIndexOf("}"));
  const names = new Set<string>();
  const tokens =
    /\s*(?:#([A-Za-z0-9_-]+)|([A-Za-z][A-Za-z0-9_-]*)=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'{}]+))\s*/gy;
  let offset = 0;
  while (offset < attributes.length) {
    tokens.lastIndex = offset;
    const token = tokens.exec(attributes);
    if (!token)
      throw new ContractMarkdownError(
        "Invalid field attributes. Use #id and quoted role, label, or required attributes.",
      );
    const name = token[1] ? "id" : token[2];
    if (!name || names.has(name))
      throw new ContractMarkdownError(`Duplicate field attribute "${name}".`);
    names.add(name);
    offset = tokens.lastIndex;
  }
}

type InlineMarks = Array<{ type: "bold" | "italic" }>;

function parseText(
  node: MarkdownNode,
  source: string,
  marks: InlineMarks,
): ContractMarkdownInline[] {
  const raw = source.slice(
    node.position?.start.offset,
    node.position?.end.offset,
  );
  if (/(?:^|[^\\]):{1,3}[A-Za-z][\w-]*(?=[[{])/.test(raw)) {
    throw new ContractMarkdownError(
      "Malformed contract directive. Check its brackets and attributes, or escape the colon for literal text.",
    );
  }
  const text = (node.value || "").replace(/\r?\n/g, " ");
  return text
    ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }]
    : [];
}

function parseInlineAtom(
  node: MarkdownNode,
  source: string,
  marks: InlineMarks,
): ContractMarkdownInline {
  if (node.type !== "break" && node.type !== "textDirective")
    return unsupported(node.type);
  if (marks.length) {
    throw new ContractMarkdownError(
      "Apply formatting to text, not hard breaks or contract directives.",
    );
  }
  if (node.type === "break") return { type: "hardBreak" };
  checkDirectiveAttributes(node, source);
  return directive(node);
}

function parseInline(
  nodes: MarkdownNode[],
  source: string,
  marks: InlineMarks = [],
  depth = 0,
): ContractMarkdownInline[] {
  if (depth > 20)
    throw new ContractMarkdownError(
      "Markdown formatting is nested too deeply.",
    );
  const result: ContractMarkdownInline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result.push(...parseText(node, source, marks));
        break;
      case "strong":
      case "emphasis": {
        const type = node.type === "strong" ? "bold" : "italic";
        const nextMarks: InlineMarks = marks.some((mark) => mark.type === type)
          ? marks
          : [...marks, { type }];
        result.push(
          ...parseInline(node.children || [], source, nextMarks, depth + 1),
        );
        break;
      }
      default:
        result.push(parseInlineAtom(node, source, marks));
    }
  }
  return result;
}

function parseBlock(node: MarkdownNode, source: string): ContractMarkdownBlock {
  if (node.type === "paragraph")
    return {
      type: "paragraph",
      content: parseInline(node.children || [], source),
    };
  if (node.type === "heading")
    return {
      type: "heading",
      attrs: { level: node.depth || 1 },
      content: parseInline(node.children || [], source),
    };
  if (node.type === "leafDirective") {
    checkDirectiveAttributes(node, source);
    return { type: "paragraph", content: [directive(node)] };
  }
  if (node.type === "list") {
    const content = (node.children || []).map((item) => {
      if (
        item.type !== "listItem" ||
        item.checked != null ||
        item.children?.length !== 1 ||
        item.children[0]?.type !== "paragraph"
      ) {
        throw new ContractMarkdownError(
          "Lists must be flat, with one paragraph per item; task lists are not supported.",
        );
      }
      return {
        type: "listItem" as const,
        content: [
          {
            type: "paragraph" as const,
            content: parseInline(item.children[0].children || [], source),
          },
        ] as [{ type: "paragraph"; content: ContractMarkdownInline[] }],
      };
    });
    return node.ordered
      ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content }
      : { type: "bulletList", content };
  }
  return unsupported(node.type);
}

export function parseContractMarkdown(
  source: string,
): ContractMarkdownDocument {
  if (
    typeof source !== "string" ||
    source.length > contractMarkdownLimits.source
  ) {
    throw new ContractMarkdownError(
      `Contract Markdown must be at most ${contractMarkdownLimits.source} characters.`,
    );
  }
  assertContractMarkdownText(source);
  if (/^\s*\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t:|-]*$/m.test(source)) {
    throw new ContractMarkdownError("Markdown tables are not supported.");
  }
  if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s/m.test(source)) {
    throw new ContractMarkdownError("Markdown task lists are not supported.");
  }
  const root = processor.parse(source) as unknown as MarkdownNode;
  return validateContractMarkdownDocument({
    type: "doc",
    content: root.children?.length
      ? root.children.map((node) => parseBlock(node, source))
      : [{ type: "paragraph", content: [] }],
  });
}

function marked(
  node: ContractMarkdownInline | undefined,
  type: "bold" | "italic",
): node is Extract<ContractMarkdownInline, { type: "text" }> {
  return (
    node?.type === "text" &&
    (node.marks?.some((mark) => mark.type === type) ?? false)
  );
}

function inlineNodeToMarkdown(node: ContractMarkdownInline): MarkdownNode {
  switch (node.type) {
    case "text":
      return { type: "text", value: node.text };
    case "hardBreak":
      return { type: "break" };
    case "contractValue":
      return {
        type: "textDirective",
        name: "value",
        attributes: {},
        children: [{ type: "text", value: node.attrs.key }],
      };
    case "contractField":
      return {
        type: "textDirective",
        name:
          node.attrs.kind === "date_signed" ? "signed-date" : node.attrs.kind,
        attributes: {
          id: node.attrs.id,
          role: node.attrs.role,
          ...(node.attrs.label ? { label: node.attrs.label } : {}),
          required: String(node.attrs.required),
        },
        children: [],
      };
  }
}

function inlineToMarkdown(
  nodes: ContractMarkdownInline[],
  markIndex = 0,
): MarkdownNode[] {
  const markType = (["bold", "italic"] as const)[markIndex];
  const result: MarkdownNode[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node) continue;
    if (markType && marked(node, markType)) {
      const group = [node];
      while (index + 1 < nodes.length) {
        const next = nodes[index + 1];
        if (!next || !marked(next, markType)) break;
        group.push(next);
        index++;
      }
      result.push({
        type: markType === "bold" ? "strong" : "emphasis",
        children: inlineToMarkdown(group, markIndex + 1),
      });
    } else if (markType) {
      result.push(...inlineToMarkdown([node], markIndex + 1));
    } else {
      result.push(inlineNodeToMarkdown(node));
    }
  }
  return result;
}

function blockToMarkdown(block: ContractMarkdownBlock): MarkdownNode {
  if (block.type === "bulletList" || block.type === "orderedList") {
    return {
      type: "list",
      ordered: block.type === "orderedList",
      start: block.type === "orderedList" ? (block.attrs?.start ?? 1) : null,
      spread: false,
      children: block.content.map((item) => ({
        type: "listItem",
        spread: false,
        children: item.content.map(blockToMarkdown),
      })),
    };
  }
  return {
    type: block.type,
    ...(block.type === "heading" ? { depth: block.attrs.level } : {}),
    children: inlineToMarkdown(block.content || []),
  };
}

export function serializeContractMarkdown(document: unknown): string {
  const validated = validateContractMarkdownDocument(document);
  const tree = {
    type: "root",
    children: validated.content.map(blockToMarkdown),
  };
  // The directive plugin extends remark's tree beyond its base RootContent types.
  const source = processor.stringify(
    tree as Parameters<typeof processor.stringify>[0],
  );
  // The source limit and parser rules apply to both editing modes.
  parseContractMarkdown(source);
  return source;
}
