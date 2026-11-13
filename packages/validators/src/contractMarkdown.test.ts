import { describe, expect, it } from "bun:test";
import {
  type ContractMarkdownDocument,
  ContractMarkdownError,
  contractMarkdownLimits,
  parseContractMarkdown,
  serializeContractMarkdown,
} from "./contractMarkdown";

const source = `# Agreement

A **bold _and italic_** agreement for :value[client.name].\\
Another line.

3. First item
4. Second item with _emphasis_

- Flat item

::signature{#sig-client role="client"}

:initials{#initials-client role="client"} :name{#name-client role="client"} :signed-date{#date-client role="client"} :text{#title-client role="client" label="Job & Title" required="false"}
`;

describe("contract Markdown", () => {
  it("round-trips supported blocks, marks, roles, labels and stable field IDs", () => {
    const document = parseContractMarkdown(source);
    const serialized = serializeContractMarkdown(document);
    expect(parseContractMarkdown(serialized)).toEqual(document);
    expect(serializeContractMarkdown(parseContractMarkdown(serialized))).toBe(
      serialized,
    );
    expect(serialized).toContain("sig-client");
    expect(serialized).toContain("title-client");
  });

  it("escapes literal visual text rather than creating executable content or fields", () => {
    const document: ContractMarkdownDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: 'Literal <script>alert(1)</script> **not bold** :signature{#fake role="client"} :value[other]',
            },
          ],
        },
      ],
    };
    expect(parseContractMarkdown(serializeContractMarkdown(document))).toEqual(
      document,
    );
  });

  it.each([
    '<script>alert("bad")</script>',
    "[link](https://example.com)",
    "![image](https://example.com/image.png)",
    "`code`",
    "```js\nalert(1)\n```",
    "> quoted",
    "---",
    "- Parent\n  - Nested",
    "- [ ] Task",
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    ":unknown[test]",
    ':signature{role="client"}',
    ":signature{#sig}",
    ':signature{#sig role="client" width="20"}',
    ':signature{#one #two role="client"}',
    ':signature{#sig role="client" role="other"}',
    ':signature{#sig role="client" required="false"}',
    ':text{#sig role="client" required="maybe"}',
    ':signature{#sig role="client"',
    ":value[bad key]",
    ':value[client.name]{role="client"}',
    ':signature{#same role="client"} :text{#same role="client"}',
    '**:signature{#sig role="client"}**',
  ])("rejects unsupported or ambiguous source: %s", (invalid) => {
    expect(() => parseContractMarkdown(invalid)).toThrow(ContractMarkdownError);
  });

  it("does not strip unsupported visual nodes, marks, or attributes", () => {
    for (const node of [
      { type: "image", attrs: { src: "https://example.com/a.png" } },
      {
        type: "text",
        text: "link",
        marks: [{ type: "link", attrs: { href: "https://example.com" } }],
      },
      { type: "text", text: "text", attrs: { onclick: "bad" } },
      {
        type: "contractField",
        attrs: {
          id: "sig",
          role: "client",
          kind: "signature",
          label: "",
          required: true,
          width: 200,
        },
      },
    ]) {
      expect(() =>
        serializeContractMarkdown({
          type: "doc",
          content: [{ type: "paragraph", content: [node] }],
        }),
      ).toThrow(ContractMarkdownError);
    }
  });

  it("rejects sparse arrays, inherited nodes, and duplicate marks from visual input", () => {
    for (const content of [
      new Array(1),
      [Object.create({ type: "paragraph", content: [] })],
      [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Bold",
              marks: [{ type: "bold" }, { type: "bold" }],
            },
          ],
        },
      ],
    ]) {
      expect(() => serializeContractMarkdown({ type: "doc", content })).toThrow(
        ContractMarkdownError,
      );
    }
  });

  it("bounds source and total fields using authoring limits", () => {
    expect(() =>
      parseContractMarkdown("x".repeat(contractMarkdownLimits.source + 1)),
    ).toThrow(ContractMarkdownError);
    const fields = Array.from(
      { length: contractMarkdownLimits.fields + 1 },
      (_, index) => `:signature{#sig-${index} role="client"}`,
    ).join("\n\n");
    expect(() => parseContractMarkdown(fields)).toThrow(/at most 200/);
  });
});
