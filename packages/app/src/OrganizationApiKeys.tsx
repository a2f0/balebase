import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  LoadingState,
  Select,
  Toast,
} from "@balebase/ui/react";
import type {
  ApiKey,
  ApiKeyAccess,
  ApiKeyExpiration,
} from "@balebase/validators/apiKeys";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "./apiClient";
import { McpConfiguration } from "./McpConfiguration";
import { useClipboard } from "./useClipboard";

interface CreatedKey {
  apiKey: ApiKey;
  token: string;
}

const expirationOptions: Array<{ label: string; value: string }> = [
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
  { label: "Never", value: "never" },
];

const statusBadges: Record<
  Exclude<ApiKey["status"], "active">,
  { label: string; title: string; tone: BadgeTone }
> = {
  expired: {
    label: "Expired",
    title: "This key passed its expiration date.",
    tone: "warning",
  },
  inactive: {
    label: "Inactive",
    title:
      "The person who created this key no longer owns or administers the organization.",
    tone: "warning",
  },
  revoked: {
    label: "Revoked",
    title: "This key was revoked.",
    tone: "neutral",
  },
};

export function OrganizationApiKeys({
  organizationId,
}: {
  organizationId: string;
}) {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>();
  const [loadError, setLoadError] = useState<string>();
  const [created, setCreated] = useState<CreatedKey>();
  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoadError(undefined);
    try {
      setApiKeys(await api.apiKeys.list());
    } catch (cause) {
      setLoadError(messageFrom(cause));
    }
  }, [organizationId]);
  useEffect(() => void load(), [load]);

  if (!apiKeys) {
    return loadError ? (
      <Banner
        actions={
          <Button onClick={() => void load()} size="sm">
            Try again
          </Button>
        }
        tone="danger"
      >
        {loadError}
      </Banner>
    ) : (
      <LoadingState label="Loading API keys…" />
    );
  }
  const replace = (apiKey: ApiKey) =>
    setApiKeys((current) =>
      current?.map((key) => (key.id === apiKey.id ? apiKey : key)),
    );
  return (
    <>
      {created ? (
        <NewApiKeyCard created={created} onDone={() => setCreated(undefined)} />
      ) : (
        <CreateApiKeyCard
          onCreated={(next) => {
            setCreated(next);
            setApiKeys((current) => [next.apiKey, ...(current ?? [])]);
          }}
        />
      )}
      <ApiKeyList apiKeys={apiKeys} onRevoked={replace} />
      {!created && <ConnectionCard />}
    </>
  );
}

function CreateApiKeyCard({
  onCreated,
}: {
  onCreated: (created: CreatedKey) => void;
}) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiKeyAccess>("read");
  const [expiration, setExpiration] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      onCreated(
        await api.apiKeys.create({
          access,
          expiresInDays: expirationDays(expiration),
          name: name.trim(),
        }),
      );
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <Card
      description="Scripts and MCP clients such as Claude and Codex use API keys to reach this organization. A key acts as you, limited to the access you choose."
      footer={
        <Button
          busy={busy}
          disabled={!name.trim()}
          icon="key"
          type="submit"
          variant="primary"
        >
          {busy ? "Creating…" : "Create API key"}
        </Button>
      }
      onSubmit={(event) => void create(event)}
      title="Create an API key"
    >
      <div className="formGrid">
        <Field label="Name">
          <input
            className="input"
            disabled={busy}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Claude"
            required
            type="text"
            value={name}
          />
        </Field>
        <div className="formRow">
          <Field label="Access">
            <Select
              disabled={busy}
              onChange={(event) =>
                setAccess(event.target.value as ApiKeyAccess)
              }
              value={access}
            >
              <option value="read">Read everything</option>
              <option value="write">Read and write everything</option>
            </Select>
          </Field>
          <Field label="Expires after">
            <Select
              disabled={busy}
              onChange={(event) => setExpiration(event.target.value)}
              value={expiration}
            >
              {expirationOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && <Toast tone="danger">{error}</Toast>}
      </div>
    </Card>
  );
}

function NewApiKeyCard({
  created,
  onDone,
}: {
  created: CreatedKey;
  onDone: () => void;
}) {
  const { copy, notice } = useClipboard();
  return (
    <Card
      className="cardAccent"
      description="This is the only time the key is shown. Store it in a password manager or your MCP client's settings."
      footer={
        <Button onClick={onDone} variant="primary">
          Done
        </Button>
      }
      title={`Copy your new API key: ${created.apiKey.name}`}
    >
      <div className="formGrid">
        <Field label="API key">
          <span className="apiKeySecret">
            <input
              aria-label="API key"
              className="input mono"
              onFocus={(event) => event.target.select()}
              readOnly
              value={created.token}
            />
            <Button
              icon="copy"
              onClick={() => void copy(created.token, "API key copied.")}
            >
              Copy key
            </Button>
          </span>
        </Field>
        <McpConfiguration token={created.token} />
        {notice && <Toast tone={notice.tone}>{notice.message}</Toast>}
      </div>
    </Card>
  );
}

function ApiKeyList({
  apiKeys,
  onRevoked,
}: {
  apiKeys: ApiKey[];
  onRevoked: (apiKey: ApiKey) => void;
}) {
  const [revokingId, setRevokingId] = useState<string>();
  const [error, setError] = useState<string>();
  const usable = apiKeys.filter(({ status }) => status === "active").length;

  async function revoke(apiKey: ApiKey) {
    if (!(await confirmRevoke(apiKey.name))) return;
    setRevokingId(apiKey.id);
    setError(undefined);
    try {
      onRevoked(await api.apiKeys.revoke(apiKey.id));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setRevokingId(undefined);
    }
  }

  return (
    <Card
      description={`${usable} active ${usable === 1 ? "key" : "keys"}. Revoke a key as soon as it is no longer needed.`}
      flush
      title="API keys"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {apiKeys.length === 0 ? (
        <EmptyState compact icon="key" title="No API keys yet">
          Create a key to connect Claude, Codex, or another MCP client.
        </EmptyState>
      ) : (
        <ul className="rowList">
          {apiKeys.map((apiKey) => (
            <ApiKeyRow
              apiKey={apiKey}
              busy={revokingId !== undefined}
              key={apiKey.id}
              onRevoke={revoke}
              revoking={revokingId === apiKey.id}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ApiKeyRow({
  apiKey,
  busy,
  onRevoke,
  revoking,
}: {
  apiKey: ApiKey;
  busy: boolean;
  onRevoke: (apiKey: ApiKey) => Promise<void>;
  revoking: boolean;
}) {
  const status = apiKey.status === "active" ? undefined : apiKey.status;
  return (
    <li className="row apiKeyRow">
      <div className="rowMain">
        <span className="apiKeyHeading">
          <span className="rowTitle truncate">{apiKey.name}</span>
          <Badge tone={apiKey.access === "write" ? "accent" : "info"}>
            {apiKey.access === "write" ? "Read and write" : "Read only"}
          </Badge>
          {status && (
            <span title={statusBadges[status].title}>
              <Badge tone={statusBadges[status].tone}>
                {statusBadges[status].label}
              </Badge>
            </span>
          )}
        </span>
        <span className="rowMeta">
          <span className="mono">{apiKey.prefix}…</span> · Created by{" "}
          {apiKey.createdBy.name} on {formatDate(apiKey.createdAt)}
        </span>
        <span className="rowMeta">{usageSummary(apiKey)}</span>
      </div>
      {apiKey.status !== "revoked" && (
        <Button
          busy={revoking}
          disabled={busy}
          onClick={() => void onRevoke(apiKey)}
          size="sm"
          variant="danger"
        >
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      )}
    </li>
  );
}

function ConnectionCard() {
  return (
    <Card
      description="Any MCP client that supports Streamable HTTP and custom headers can connect. Read keys see only read tools."
      title="Connect an MCP client"
    >
      <McpConfiguration />
    </Card>
  );
}

function usageSummary(apiKey: ApiKey) {
  if (apiKey.revokedAt) {
    return `Revoked ${formatDate(apiKey.revokedAt)}${
      apiKey.revokedBy ? ` by ${apiKey.revokedBy.name}` : ""
    }`;
  }
  const used = apiKey.lastUsedAt
    ? `Last used ${formatDate(apiKey.lastUsedAt)}`
    : "Never used";
  const expires = apiKey.expiresAt
    ? `${Date.parse(apiKey.expiresAt) <= Date.now() ? "Expired" : "Expires"} ${formatDate(apiKey.expiresAt)}`
    : "Never expires";
  return `${used} · ${expires}`;
}

function expirationDays(value: string): ApiKeyExpiration {
  if (value === "30" || value === "90" || value === "365") {
    return Number(value) as ApiKeyExpiration;
  }
  return null;
}

function confirmRevoke(name: string) {
  return confirmDialog({
    confirmLabel: "Revoke key",
    message:
      "Anything using this key loses access immediately. This cannot be undone.",
    title: `Revoke ${name}?`,
    tone: "danger",
  });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update API keys. Please try again.";
}
