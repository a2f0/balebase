import { Button, confirmDialog, Toast } from "@balebase/ui/react";
import type { DomainClaim } from "@balebase/validators/inbox";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { useClipboard } from "../shared/useClipboard";
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

function useTxtCopyGate() {
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  async function run(write: () => Promise<void>) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      await write();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return { run, busy };
}

function RoutingSettings() {
  const copyGate = useTxtCopyGate();
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
          copyGate={copyGate}
          mx={settings.data?.directMx ?? null}
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
            Forwarding: At your current mail provider, forward only{" "}
            <code>{box.address}</code> to <code>{box.forwardingAddress}</code>{" "}
            to keep your existing MX records.
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

function VerificationTxt({
  claim,
  copyGate,
}: {
  claim: DomainClaim;
  copyGate: ReturnType<typeof useTxtCopyGate>;
}) {
  const { copy, notice } = useClipboard();
  return (
    <div>
      <dl>
        {[
          {
            label: "Record name",
            action: "Copy record name",
            value: claim.recordName,
          },
          {
            label: "TXT value",
            action: "Copy TXT value",
            value: claim.recordValue,
          },
        ].map(({ label, action, value }) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className="inboxDnsField">
              <code>{value}</code>
              <Button
                aria-label={`${action} for ${claim.domain}`}
                aria-disabled={copyGate.busy}
                icon="copy"
                iconOnly
                onClick={() =>
                  void copyGate.run(() => copy(value, `${label} copied.`))
                }
                size="sm"
                title={action}
                variant="ghost"
              />
            </dd>
          </Fragment>
        ))}
      </dl>
      <div role="status">{notice?.message}</div>
    </div>
  );
}

function DomainRecord({
  claim,
  copyGate,
  mx,
  busy,
  verify,
  release,
}: {
  claim: DomainClaim;
  copyGate: ReturnType<typeof useTxtCopyGate>;
  mx: { host: string; priority: number } | null;
  busy: boolean;
  verify: () => Promise<boolean>;
  release: () => Promise<void>;
}) {
  const mxCheck = useAction("Could not check public MX records.");
  return (
    <div className="stack">
      <strong>
        {claim.domain} ·{" "}
        {claim.status === "verified" ? "Verified" : "Awaiting verification"}
      </strong>
      <p>
        {claim.status === "pending"
          ? "Add this TXT record at your DNS provider, then verify ownership."
          : "Keep the TXT record published while using direct MX. A missing record temporarily stops direct delivery."}
      </p>
      <VerificationTxt claim={claim} copyGate={copyGate} />
      {claim.status === "pending" && (
        <Button disabled={busy} onClick={() => void verify()}>
          Verify domain
        </Button>
      )}
      {claim.status === "verified" &&
        (mx ? (
          <>
            <p>
              <strong>Direct MX</strong> sends all mail for{" "}
              <code>{claim.domain}</code> here. Connect each recipient first.
              For a domain with other email users, keep your existing MX and use
              per-address forwarding below.
            </p>
            <dl>
              <dt>MX record name</dt>
              <dd>
                <code>{claim.domain}</code>
              </dd>
              <dt>Mail server</dt>
              <dd>
                <code>{mx.host}</code>
              </dd>
              <dt>Priority</dt>
              <dd>{mx.priority}</dd>
            </dl>
            <Button
              disabled={busy || mxCheck.busy}
              onClick={() =>
                void mxCheck.run(
                  () => api.inbox.checkMx(claim.id),
                  ({ ready }) =>
                    ready
                      ? "Public MX records match."
                      : "Public MX records do not yet match the displayed host and priority.",
                )
              }
            >
              Check public MX
            </Button>
            {(mxCheck.notice || mxCheck.error) && (
              <p role="status">{mxCheck.error ?? mxCheck.notice}</p>
            )}
          </>
        ) : (
          <p>
            Direct MX is unavailable in this environment. Use per-address
            forwarding below.
          </p>
        ))}
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
