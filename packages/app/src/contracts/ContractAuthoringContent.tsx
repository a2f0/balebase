import { Button, Field, Select, Toast } from "@balebase/ui/react";
import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import {
  parseContractMarkdown,
  serializeContractMarkdown,
} from "@balebase/validators/contractMarkdown";
import type { FieldType } from "@balebase/validators/contracts";
import { contractLimits } from "@balebase/validators/rules";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import {
  appendAuthoringAtom,
  authoringExtensions,
  visualDocument,
} from "./contractAuthoringVisual";
import { fieldTypes } from "./contractFields";

export function ContractAuthoringContent({
  draft,
  disabled,
  onChange,
}: {
  draft: ContractAuthoringInput;
  disabled: boolean;
  onChange: (source: string) => void;
}) {
  const [mode, setMode] = useState<"visual" | "source">(() => {
    try {
      parseContractMarkdown(draft.source);
      return "visual";
    } catch {
      return "source";
    }
  });
  const [error, setError] = useState<string>();
  const visual = useRef<Editor | null>(null);
  let sourceError: string | undefined;
  try {
    parseContractMarkdown(draft.source);
  } catch (cause) {
    sourceError = cause instanceof Error ? cause.message : "Invalid Markdown.";
  }
  const insert = (atom: JSONContent) => {
    setError(undefined);
    if (mode === "visual" && visual.current) {
      visual.current.chain().focus().insertContent(atom).run();
      return;
    }
    try {
      onChange(appendAuthoringAtom(draft.source, atom));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Cannot insert into invalid Markdown.",
      );
    }
  };
  return (
    <section className="stack stackMd" aria-label="Contract content">
      <nav aria-label="Authoring mode" className="segmented">
        <button
          type="button"
          aria-pressed={mode === "visual"}
          disabled={disabled}
          onClick={() => {
            if (sourceError) {
              setError(sourceError);
              return;
            }
            setError(undefined);
            setMode("visual");
          }}
        >
          Visual
        </button>
        <button
          type="button"
          aria-pressed={mode === "source"}
          disabled={disabled}
          onClick={() => {
            setError(undefined);
            setMode("source");
          }}
        >
          Markdown
        </button>
      </nav>
      <p className="contractHint">
        Headings, paragraphs, bold, italic, line breaks, and flat lists are
        supported. Fields and merge values are preserved when switching modes.
        Links, images, HTML, tables, and code are not supported.
      </p>
      {(sourceError || error) && (
        <Toast tone="danger">{sourceError || error}</Toast>
      )}
      <AuthoringInsert
        draft={draft}
        disabled={disabled || Boolean(sourceError)}
        insert={insert}
      />
      {mode === "source" ? (
        <Field
          label="Markdown source"
          hint="Insertion controls append a new paragraph. Field IDs must remain unique."
        >
          <textarea
            className="textarea contractMarkdownSource"
            disabled={disabled}
            maxLength={50000}
            onChange={(event) => {
              setError(undefined);
              onChange(event.target.value);
            }}
            rows={20}
            spellCheck={false}
            value={draft.source}
          />
        </Field>
      ) : (
        <VisualContent
          source={draft.source}
          disabled={disabled}
          onChange={onChange}
          onError={setError}
          onEditor={(editor) => {
            visual.current = editor;
          }}
        />
      )}
    </section>
  );
}

function VisualContent({
  source,
  disabled,
  onChange,
  onError,
  onEditor,
}: {
  source: string;
  disabled: boolean;
  onChange: (source: string) => void;
  onError: (message: string | undefined) => void;
  onEditor: (editor: Editor | null) => void;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    content: visualDocument(source),
    extensions: authoringExtensions(onError),
    editorProps: {
      attributes: {
        "aria-label": "Contract visual editor",
        "aria-multiline": "true",
        class: "contractVisualContent",
        role: "textbox",
      },
    },
    onUpdate: ({ editor: current }) => {
      onError(undefined);
      onChange(serializeContractMarkdown(current.getJSON()));
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [disabled, editor]);
  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);
  if (!editor) return null;
  let headingLevel = 0;
  if (editor.isActive("heading")) {
    const { level } = editor.getAttributes("heading");
    headingLevel = level;
  }
  return (
    <div className="contractVisualEditor">
      <fieldset
        className="contractAuthoringToolbar"
        aria-label="Text formatting"
      >
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
          size="sm"
        >
          Bold
        </Button>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          size="sm"
        >
          Italic
        </Button>
        <Select
          aria-label="Paragraph style"
          disabled={disabled}
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level === 0) editor.chain().focus().setParagraph().run();
            else
              editor
                .chain()
                .focus()
                .setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
                .run();
          }}
          value={headingLevel}
        >
          <option value={0}>Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>
              Heading {level}
            </option>
          ))}
        </Select>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          size="sm"
        >
          Bullet list
        </Button>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          size="sm"
        >
          Numbered list
        </Button>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().setHardBreak().run()}
          size="sm"
        >
          Line break
        </Button>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().undo().run()}
          size="sm"
        >
          Undo
        </Button>
        <Button
          disabled={disabled}
          onClick={() => editor.chain().focus().redo().run()}
          size="sm"
        >
          Redo
        </Button>
      </fieldset>
      <EditorContent editor={editor} />
    </div>
  );
}

function AuthoringInsert({
  draft,
  disabled,
  insert,
}: {
  draft: ContractAuthoringInput;
  disabled: boolean;
  insert: (atom: JSONContent) => void;
}) {
  const [selectedRole, setRole] = useState("");
  const [kind, setKind] = useState<FieldType>("signature");
  const [label, setLabel] = useState("");
  const [optional, setOptional] = useState(false);
  const [valueKey, setValueKey] = useState("");
  const roleKeys = [...new Set(draft.recipients.map(({ key }) => key))];
  const role = draft.recipients.some(({ key }) => key === selectedRole)
    ? selectedRole
    : (draft.recipients[0]?.key ?? "");
  return (
    <div className="contractAuthoringInsert">
      <Field label="Signer field">
        <Select
          disabled={disabled}
          value={kind}
          onChange={(event) => setKind(event.target.value as FieldType)}
        >
          {fieldTypes.map((field) => (
            <option key={field.type} value={field.type}>
              {field.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Assign to role">
        <Select
          disabled={disabled}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {!draft.recipients.length && (
            <option value="">Add a signer first</option>
          )}
          {roleKeys.map((key) => (
            <option key={key} value={key}>
              {key || "Unnamed role"}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Field label" optional>
        <input
          className="input"
          disabled={disabled}
          maxLength={contractLimits.fieldLabel}
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
      </Field>
      {kind === "text" && (
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={optional}
            onChange={(event) => setOptional(event.target.checked)}
          />{" "}
          Optional text
        </label>
      )}
      <Button
        disabled={disabled || !role}
        onClick={() =>
          insert({
            type: "contractField",
            attrs: {
              id: `field-${crypto.randomUUID()}`,
              kind,
              label,
              required: kind !== "text" || !optional,
              role,
            },
          })
        }
      >
        Insert field
      </Button>
      <Field
        label="Merge value key"
        hint="For example client.name, client.email, or an explicit value below."
      >
        <input
          className="input"
          disabled={disabled}
          onChange={(event) => setValueKey(event.target.value)}
          placeholder="client.name"
          value={valueKey}
        />
      </Field>
      <Button
        disabled={disabled || !valueKey.trim()}
        onClick={() =>
          insert({ type: "contractValue", attrs: { key: valueKey.trim() } })
        }
      >
        Insert value
      </Button>
    </div>
  );
}
