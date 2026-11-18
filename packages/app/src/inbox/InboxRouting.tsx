import { Button, confirmDialog, Toast } from "@balebase/ui/react";
import type { DomainClaim } from "@balebase/validators/inbox";
import { useEffect, useState } from "react";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";

// A mutation can finish after its panel unmounts. Mounted views reload their
// current workspace rather than receiving data from the old request.
const routingChanged = new EventTarget();

export function useRoutingRefresh(reload: () => Promise<unknown>) {
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    routingChanged.addEventListener("change", refresh);
    return () => routingChanged.removeEventListener("change", refresh);
  }, [reload]);
}

export function InboxRouting() {
  const [visited, setVisited] = useState(false);
  return (
    <details
      className="card"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <summary>Manage inbox addresses</summary>
      {visited && <RoutingSettings />}
    </details>
  );
}

function RoutingSettings() {
  const settings = useLoad(
    api.inbox.routing,
    "Could not load inbox addresses.",
  );
  useRoutingRefresh(settings.reload);
  const action = useAction("Could not update inbox addresses.");
  async function change(mutate: () => Promise<unknown>) {
    return action.run(async () => {
      await mutate();
      routingChanged.dispatchEvent(new Event("change"));
    });
  }
  const busy = settings.loading || action.busy;
  async function remove(
    title: string,
    description: string,
    run: () => Promise<unknown>,
  ) {
    if (
      await confirmDialog({
        title,
        message: description,
        confirmLabel: title,
        tone: "danger",
      })
    )
      await change(run);
  }
  return (
    <div className="stack">
      {(settings.error || action.error) && (
        <Toast tone="danger">{settings.error ?? action.error}</Toast>
      )}
      <DomainForm
        busy={busy}
        onSubmit={(domain) => change(() => api.inbox.claimDomain(domain))}
      />
      {settings.data?.domains.map((claim) => (
        <DomainRecord
          key={claim.id}
          claim={claim}
          busy={busy}
          verify={() => change(() => api.inbox.verifyDomain(claim.id))}
          release={() =>
            remove(
              "Release domain",
              `Remove the domain claim for ${claim.domain}?`,
              () => api.inbox.releaseDomain(claim.id),
            )
          }
        />
      ))}
      <MailboxForm
        busy={busy}
        onSubmit={(name, address) =>
          change(() => api.inbox.bindMailbox(name, address))
        }
      />
      {settings.data?.mailboxes.map((box) => (
        <div className="stack" key={box.id}>
          <strong>{box.name}</strong>
          <p>
            Route mail for <code>{box.address}</code> to{" "}
            <code>{box.forwardingAddress}</code> at your mail provider.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void remove(
                "Disconnect address",
                `Stop receiving mail for ${box.address}? Existing messages stay in this inbox.`,
                () => api.inbox.disconnectMailbox(box.id),
              )
            }
          >
            Disconnect address
          </Button>
        </div>
      ))}
    </div>
  );
}

function DomainForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (domain: string) => Promise<boolean>;
}) {
  const [domain, setDomain] = useState("");
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSubmit(domain)) setDomain("");
      }}
    >
      <label className="field">
        Email domain
        <input
          disabled={busy}
          className="input"
          placeholder="example.com"
          value={domain}
          required
          onChange={(event) => setDomain(event.target.value)}
        />
      </label>
      <Button disabled={busy} type="submit">
        Add domain
      </Button>
    </form>
  );
}

function DomainRecord({
  claim,
  busy,
  verify,
  release,
}: {
  claim: DomainClaim;
  busy: boolean;
  verify: () => Promise<boolean>;
  release: () => Promise<void>;
}) {
  return (
    <div className="stack">
      <strong>
        {claim.domain} ·{" "}
        {claim.status === "verified" ? "Verified" : "Awaiting verification"}
      </strong>
      {claim.status === "pending" && (
        <>
          <p>
            Add this TXT record at your DNS provider, then verify ownership.
          </p>
          <dl>
            <dt>Record name</dt>
            <dd>
              <code>{claim.recordName}</code>
            </dd>
            <dt>TXT value</dt>
            <dd>
              <code>{claim.recordValue}</code>
            </dd>
          </dl>
          <Button disabled={busy} onClick={() => void verify()}>
            Verify domain
          </Button>
        </>
      )}
      <Button disabled={busy} onClick={() => void release()}>
        Release domain
      </Button>
    </div>
  );
}

function MailboxForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (name: string, address: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSubmit(name, address)) {
          setName("");
          setAddress("");
        }
      }}
    >
      <label className="field">
        Inbox name
        <input
          disabled={busy}
          className="input"
          value={name}
          placeholder="Legal"
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        Address to receive
        <input
          disabled={busy}
          className="input"
          type="email"
          placeholder="legal@example.com"
          required
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <Button disabled={busy} type="submit">
        Connect inbox address
      </Button>
    </form>
  );
}
