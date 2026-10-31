import {
  Button,
  Card,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { Business } from "@balebase/validators/businesses";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { formatCalendarDate } from "../shared/labels";
import { useFocusWhenFolded } from "../shared/useFocusWhenFolded";
import { useLoad } from "../shared/useLoad";
import { businessPath } from "../workspace/workspacePaths";
import {
  BusinessFields,
  type BusinessFormState,
  businessForm,
  changedBusinessInput,
} from "./BusinessForm";
import {
  businessIdentifiers,
  type CopyIdentifier,
  formatBusinessAddress,
  useIdentifierCopy,
} from "./businessState";

export function BusinessDetailPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const loaded = useLoad(
    useCallback(() => api.businesses.get(id), [id]),
    "Could not load the business.",
  );
  const detail = loaded.data;
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { copyNotice, onCopy } = useIdentifierCopy();
  const editButton = useFocusWhenFolded(editing);
  const business = detail?.business;
  const error = failure ?? loaded.error;
  const announce = (message: string) => {
    setFailure(undefined);
    setNotice(message);
  };
  const fail = (message: string) => {
    setNotice(undefined);
    setFailure(message);
  };

  return (
    <Page>
      <PageHeader
        actions={
          <>
            {detail?.canManage && !editing && (
              <Button
                icon="edit"
                onClick={() => setEditing(true)}
                ref={editButton}
              >
                Edit
              </Button>
            )}
            <Button icon="arrowLeft" onClick={() => onNavigate(businessPath())}>
              Businesses
            </Button>
          </>
        }
        eyebrow="Business"
        title={business?.name ?? "Business details"}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {copyNotice && (
          <Toast tone={copyNotice.tone}>{copyNotice.message}</Toast>
        )}
        {!business && !error && <LoadingState label="Loading business…" />}
        {business &&
          (editing ? (
            <BusinessEditCard
              business={business}
              onCancel={() => setEditing(false)}
              onError={fail}
              onSaved={(updated) => {
                loaded.setData((current) =>
                  current ? { ...current, business: updated } : current,
                );
                setEditing(false);
                announce("Business updated.");
              }}
            />
          ) : (
            <BusinessDetailCard business={business} onCopy={onCopy} />
          ))}
        {business && (
          <ActivityFeed
            refreshKey={business}
            source={{ id: business.id, type: "business" }}
          />
        )}
      </PageBody>
    </Page>
  );
}

function BusinessDetailCard({
  business,
  onCopy,
}: {
  business: Business;
  onCopy: CopyIdentifier;
}) {
  return (
    <PageSection title="Details">
      <Card>
        <dl className="businessDetails">
          <div>
            <dt>Name</dt>
            <dd>{business.name}</dd>
          </div>
          {businessIdentifiers(business).map(({ id, identifier, value }) => (
            <div key={id}>
              <dt>{identifier}</dt>
              <dd className="businessDetailValue">
                {value ?? "Not provided"}
                {value && (
                  <Button
                    aria-label={`Copy ${identifier}`}
                    icon="copy"
                    iconOnly
                    onClick={() => onCopy(identifier, value)}
                    size="sm"
                    variant="ghost"
                  />
                )}
              </dd>
            </div>
          ))}
          <div>
            <dt>Incorporation date</dt>
            <dd>
              {business.incorporationDate
                ? formatCalendarDate(business.incorporationDate)
                : "Not provided"}
            </dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{formatBusinessAddress(business) || "Not provided"}</dd>
          </div>
        </dl>
      </Card>
    </PageSection>
  );
}

/** The detail page's editor: the add form's fields, filled from the business. */
function BusinessEditCard({
  business,
  onCancel,
  onError,
  onSaved,
}: {
  business: Business;
  onCancel: () => void;
  onError: (message: string) => void;
  onSaved: (business: Business) => void;
}) {
  // The business as editing began; later refreshes must not move it.
  const [baseline] = useState(() => businessForm(business));
  const [form, setForm] = useState<BusinessFormState>(baseline);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  // The Edit button that opened the form is gone; move focus into the form.
  useEffect(() => nameField.current?.focus(), []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.businesses.update(
        business.id,
        changedBusinessInput(baseline, form),
      );
      onSaved(result.business);
    } catch (cause) {
      onError(errorMessage(cause, "Could not save the business."));
      setBusy(false);
    }
  }

  return (
    <Card
      footer={
        <>
          <span className="textSm textSubtle">
            Only the business name is required.
          </span>
          <div className="cluster">
            <Button disabled={busy} onClick={onCancel} variant="ghost">
              Cancel
            </Button>
            <Button
              busy={busy}
              disabled={!form.name.trim()}
              icon="check"
              type="submit"
              variant="primary"
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </>
      }
      onSubmit={(event) => void save(event)}
      title="Edit business"
    >
      <BusinessFields
        disabled={busy}
        form={form}
        nameField={nameField}
        onChange={setForm}
      />
    </Card>
  );
}
