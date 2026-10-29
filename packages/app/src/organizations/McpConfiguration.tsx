import { Button, Toast } from "@balebase/ui/react";
import { type KeyboardEvent, useId, useState } from "react";
import { apiUrl } from "../shared/config";
import { useClipboard } from "../shared/useClipboard";

/** The MCP endpoint that accepts API keys. */
const mcpServerUrl = `${apiUrl}/mcp`;

const clients = ["Claude Code", "Codex", "Generic"] as const;
type Client = (typeof clients)[number];

export function McpConfiguration({ token }: { token?: string | undefined }) {
  const [client, setClient] = useState<Client>("Claude Code");
  const id = useId();
  const key = token ?? "YOUR_API_KEY";
  return (
    <div className="formGrid">
      {!token && (
        <p className="textSm textMuted">
          Replace YOUR_API_KEY with a saved active key. Existing key secrets
          cannot be shown again. If you no longer have yours, create a new key.
        </p>
      )}
      <div aria-label="MCP client" className="tabs" role="tablist">
        {clients.map((name, index) => (
          <button
            aria-controls={`${id}-panel`}
            aria-selected={client === name}
            className="tab"
            id={`${id}-${index}`}
            key={name}
            onClick={() => setClient(name)}
            onKeyDown={(event) => switchTab(event, name, setClient)}
            role="tab"
            tabIndex={client === name ? 0 : -1}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>
      {/* The panel starts with instructions, so keyboard users can focus it. */}
      <div
        aria-labelledby={`${id}-${clients.indexOf(client)}`}
        className="formGrid"
        id={`${id}-panel`}
        key={client}
        role="tabpanel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels with introductory text need a keyboard focus stop.
        tabIndex={0}
      >
        <ClientConfiguration client={client} token={key} />
      </div>
      <p className="textSm textMuted">
        The same header works for <code className="codeChip">{apiUrl}/api</code>{" "}
        workspace routes. Account, billing, and key management stay
        session-only.
      </p>
    </div>
  );
}

function switchTab(
  event: KeyboardEvent<HTMLButtonElement>,
  client: Client,
  select: (client: Client) => void,
) {
  const index = clients.indexOf(client);
  const next = new Map([
    ["ArrowLeft", (index + clients.length - 1) % clients.length],
    ["ArrowRight", (index + 1) % clients.length],
    ["End", clients.length - 1],
    ["Home", 0],
  ]).get(event.key);
  if (next === undefined) return;
  event.preventDefault();
  select(clients[next] ?? "Claude Code");
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    [next]?.focus();
}

function ClientConfiguration({
  client,
  token,
}: {
  client: Client;
  token: string;
}) {
  if (client === "Claude Code") {
    return (
      <>
        <p className="textSm textMuted">
          Run this in a terminal to add Balebase to Claude Code.
        </p>
        <CopyableCode
          label="Copy command"
          text={`claude mcp add --transport http balebase ${mcpServerUrl} --header "Authorization: Bearer ${token}"`}
        />
      </>
    );
  }
  if (client === "Codex") {
    return (
      <>
        <p className="textSm textMuted">
          Add this to <code>~/.codex/config.toml</code>, or replace the existing
          Balebase entry. Keep this file private because it contains your key.
        </p>
        <CopyableCode
          label="Copy configuration"
          text={`[mcp_servers.balebase]\nurl = ${JSON.stringify(mcpServerUrl)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`}
        />
      </>
    );
  }
  return (
    <>
      <p className="textSm textMuted">
        Choose Streamable HTTP in your MCP client, then set the server URL and
        Authorization header below. Your client must support custom headers.
      </p>
      <CopyableCode label="Copy server URL" text={mcpServerUrl} />
      <CopyableCode
        label="Copy header"
        text={`Authorization: Bearer ${token}`}
      />
    </>
  );
}

function CopyableCode({ label, text }: { label: string; text: string }) {
  const { copy, notice } = useClipboard();
  return (
    <div className="formGrid">
      <div className="apiKeySecret">
        <pre className="apiKeyCommand">
          <code>{text}</code>
        </pre>
        <Button icon="copy" onClick={() => void copy(text)}>
          {label}
        </Button>
      </div>
      {notice && <Toast tone={notice.tone}>{notice.message}</Toast>}
    </div>
  );
}
