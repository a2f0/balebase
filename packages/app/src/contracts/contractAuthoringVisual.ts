import {
  parseContractMarkdown,
  serializeContractMarkdown,
} from "@balebase/validators/contractMarkdown";
import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

// StarterKit's ordered list also carries HTML numbering styles, outside our subset.
const ContractOrderedList = Node.create({
  name: "orderedList",
  group: "block list",
  content: "listItem+",
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element) => Number(element.getAttribute("start")) || 1,
      },
    };
  },
  parseHTML() {
    return [{ tag: "ol" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["ol", HTMLAttributes, 0];
  },
  addCommands() {
    return {
      toggleOrderedList:
        () =>
        ({ commands }) =>
          commands.toggleList("orderedList", "listItem"),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Shift-7": () => this.editor.commands.toggleOrderedList() };
  },
});

const pasteTags: Record<string, true> = {
  P: true,
  BR: true,
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
  UL: true,
  OL: true,
  LI: true,
  STRONG: true,
  B: true,
  EM: true,
  I: true,
};

const ContractValue = Node.create({
  name: "contractValue",
  group: "inline",
  marks: "",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      key: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-key"),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-contract-value]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { key } = node.attrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "contractValueChip",
        "data-contract-value": "",
        "data-key": key,
      }),
      `Value: ${key}`,
    ];
  },
});

const ContractField = Node.create({
  name: "contractField",
  group: "inline",
  marks: "",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-field-id"),
      },
      kind: {
        default: "signature",
        parseHTML: (element) => element.getAttribute("data-kind"),
      },
      label: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-label") ?? "",
      },
      required: {
        default: true,
        parseHTML: (element) =>
          element.getAttribute("data-required") !== "false",
      },
      role: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-role"),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-contract-field]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { id, kind, label, required, role } = node.attrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "contractFieldChip",
        "data-contract-field": "",
        "data-field-id": id,
        "data-kind": kind,
        "data-label": label,
        "data-required": String(required),
        "data-role": role,
      }),
      `${role}: ${label || String(kind).replaceAll("_", " ")}${required ? "" : " (optional)"}`,
    ];
  },
});

/** Invalid visual operations are rejected before they can diverge from source. */
export function authoringExtensions(onError: (message: string) => void) {
  const supported = Extension.create({
    name: "contractSupportedMarkdown",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction(transaction) {
            if (!transaction.docChanged) return true;
            try {
              serializeContractMarkdown(transaction.doc.toJSON());
              return true;
            } catch (cause) {
              queueMicrotask(() =>
                onError(
                  cause instanceof Error
                    ? cause.message
                    : "This edit is not supported.",
                ),
              );
              return false;
            }
          },
          props: {
            handlePaste(_view, event) {
              const html = event.clipboardData?.getData("text/html");
              if (!html) return false;
              const document = new DOMParser().parseFromString(
                html,
                "text/html",
              );
              const unsupported = [...document.body.querySelectorAll("*")].some(
                (element) =>
                  !Object.hasOwn(pasteTags, element.tagName) &&
                  !(
                    element.tagName === "SPAN" &&
                    (element.hasAttribute("data-contract-value") ||
                      element.hasAttribute("data-contract-field"))
                  ),
              );
              if (unsupported)
                onError(
                  "This paste contains unsupported formatting. Paste plain text, or use Markdown mode to inspect it.",
                );
              return unsupported;
            },
          },
        }),
      ];
    },
  });
  return [
    StarterKit.configure({
      blockquote: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
      strike: false,
      underline: false,
      trailingNode: false,
      orderedList: false,
    }),
    ContractOrderedList,
    ContractValue,
    ContractField,
    supported,
  ];
}

export function visualDocument(source: string) {
  return parseContractMarkdown(source);
}

export function appendAuthoringAtom(source: string, atom: unknown) {
  // Parsing first ensures insertion can never erase invalid source.
  const document = parseContractMarkdown(source);
  return serializeContractMarkdown({
    ...document,
    content: [...document.content, { type: "paragraph", content: [atom] }],
  });
}
