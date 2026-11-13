import { describe, expect, it } from "bun:test";
import {
  parseContractMarkdown,
  serializeContractMarkdown,
} from "@balebase/validators/contractMarkdown";
import { Editor } from "@tiptap/core";
import { useState } from "react";
import { installDom } from "../testing/dom";
import { ContractAuthoringContent } from "./ContractAuthoringContent";
import { ContractAuthoringDetails } from "./ContractAuthoringDetails";
import { newAuthoredDraft } from "./contractAuthoringState";
import {
  appendAuthoringAtom,
  authoringExtensions,
} from "./contractAuthoringVisual";

const { click, fill, mount, settle } = installDom({
  globals: (window) => ({
    DOMParser: window.DOMParser,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  }),
});

const source = `# Agreement\n\n**Bold** and *italic* for :value[client.name].\n\n1. First item\n2. Second item\n\n:signature{#signature-client role="client"}\n\n:initials{#initials-client role="client"}\n\n:name{#name-client role="client"}\n\n:signed-date{#date-client role="client"}\n\n:text{#title-client role="client" label="Title" required="false"}\n`;

function ContentHarness({
  initial = source,
  disabled = false,
}: {
  initial?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => ({
    ...newAuthoredDraft(),
    source: initial,
  }));
  return (
    <ContractAuthoringContent
      disabled={disabled}
      draft={draft}
      onChange={(next) => setDraft({ ...draft, source: next })}
    />
  );
}

describe("written contract visual/source interaction", () => {
  it("does not rewrite saved source when saving disables and re-enables the visual editor", async () => {
    const { container, render } = await mount(<ContentHarness />);
    await render(<ContentHarness disabled />);
    await render(<ContentHarness />);
    await click("Markdown");
    expect(container.querySelector("textarea")?.value).toBe(source);
  });

  it("roundtrips all five field kinds, identities, optional labels, values and supported formatting through real editor JSON", () => {
    const document = parseContractMarkdown(source);
    const editor = new Editor({
      content: document,
      extensions: authoringExtensions(() => {}),
      element: window.document.createElement("div"),
    });
    try {
      const serialized = serializeContractMarkdown(editor.getJSON());
      expect(parseContractMarkdown(serialized)).toEqual(document);
      expect(serialized).toContain("title-client");
      expect(serialized).toContain('required="false"');
      expect(serialized).toContain(":value[client.name]");
    } finally {
      editor.destroy();
    }
  });

  it("rejects a duplicate pasted field rather than losing or reusing its identity", async () => {
    const errors: string[] = [];
    const editor = new Editor({
      content: parseContractMarkdown(source),
      extensions: authoringExtensions((message) => errors.push(message)),
      element: window.document.createElement("div"),
    });
    try {
      const before = editor.getJSON();
      editor.commands.insertContent({
        type: "contractField",
        attrs: {
          id: "signature-client",
          kind: "signature",
          role: "client",
          label: "",
          required: true,
        },
      });
      await settle();
      expect(editor.getJSON()).toEqual(before);
      expect(errors.length).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it("keeps unsupported source intact when Visual is requested and permits correction", async () => {
    const invalid = "# Keep this\n\n[unsupported](https://example.com)\n";
    const { container } = await mount(<ContentHarness initial={invalid} />);
    await click("Visual");
    expect(container.querySelector("textarea")?.value).toBe(invalid);
    expect(container.querySelector('[role="textbox"]')).toBeNull();
    await fill(container.querySelector("textarea"), source);
    await click("Visual");
    await settle();
    expect(
      container.querySelector('[aria-label="Contract visual editor"]'),
    ).not.toBeNull();
    await click("Markdown");
    expect(
      parseContractMarkdown(container.querySelector("textarea")?.value ?? ""),
    ).toEqual(parseContractMarkdown(source));
  });

  it("inserts a unique role-bound field in source mode and retains it across visual mode", async () => {
    const { container } = await mount(<ContentHarness />);
    await click("Markdown");
    await click("Insert field");
    const inserted = container.querySelector("textarea")?.value ?? "";
    expect(inserted).toMatch(/#field-[a-f0-9-]+/);
    const document = parseContractMarkdown(inserted);
    await click("Visual");
    await settle();
    await click("Markdown");
    expect(
      parseContractMarkdown(container.querySelector("textarea")?.value ?? ""),
    ).toEqual(document);
  });

  it("does not overwrite malformed source when an insertion is attempted", () => {
    const invalid = "<script>keep as source, never execute</script>";
    expect(() =>
      appendAuthoringAtom(invalid, {
        type: "contractValue",
        attrs: { key: "project.title" },
      }),
    ).toThrow();
  });
});

function DetailsHarness() {
  const [draft, setDraft] = useState(newAuthoredDraft);
  return <ContractAuthoringDetails draft={draft} onChange={setDraft} />;
}

describe("signer row identity", () => {
  it("preserves the focused role input across renaming and keeps remaining rows when deleting another signer", async () => {
    const { container } = await mount(<DetailsHarness />);
    const role = container.querySelector<HTMLInputElement>(
      ".contractAuthoringRole input",
    );
    expect(role).not.toBeNull();
    role?.focus();
    await fill(role, "customer");
    expect(container.querySelector(".contractAuthoringRole input")).toBe(role);
    expect(document.activeElement).toBe(role);
    await fill(role, "customer-company");
    expect(document.activeElement).toBe(role);
    await click("Add signer");
    const second = container.querySelectorAll(".contractAuthoringRole")[1];
    if (!second) throw new Error("The second signer row was not added.");
    const secondRole = second.querySelector("input");
    await click("Remove signer 1");
    expect(container.querySelector(".contractAuthoringRole")).toBe(second);
    expect(container.querySelector(".contractAuthoringRole input")).toBe(
      secondRole,
    );
    expect(secondRole?.value).toBe("signer2");
  });
});
