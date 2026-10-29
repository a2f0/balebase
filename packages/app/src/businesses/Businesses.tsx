import {
  Banner,
  Button,
  Card,
  ContextMenu,
  confirmDialog,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { Business } from "@balebase/validators/businesses";
import {
  type ComponentProps,
  type FormEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { countLabel, formatCalendarDate } from "../shared/labels";
import { useFocusWhenFolded } from "../shared/useFocusWhenFolded";
import { businessIdForPath, businessPath } from "../workspace/workspacePaths";
import { BusinessDetailPage } from "./BusinessDetail";
import {
  BusinessFields,
  type BusinessFormState,
  businessForm,
  businessInput,
  emptyBusinessForm,
} from "./BusinessForm";
import {
  type BusinessListState,
  businessIdentifiers,
  businessListReducer,
  type CopyIdentifier,
  formatBusinessAddress,
  formatDuns,
  formatEin,
  initialBusinessListState,
  useIdentifierCopy,
} from "./businessState";

export function Businesses({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const businessId = businessIdForPath(pathname);
  return businessId ? (
    <BusinessDetailPage
      id={businessId}
      key={businessId}
      onNavigate={onNavigate}
    />
  ) : (
    <BusinessListPage onNavigate={onNavigate} />
  );
}

function BusinessListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const [state, dispatch] = useReducer(
    businessListReducer,
    initialBusinessListState,
  );
  const load = useCallback(async () => {
    dispatch({ type: "loadStarted" });
    try {
      dispatch({ type: "loaded", data: await api.businesses.list() });
    } catch (cause) {
      dispatch({
        type: "loadFailed",
        message: errorMessage(cause, "Could not load businesses."),
      });
    }
  }, []);
  useEffect(() => void load(), [load]);
  const { copyNotice, onCopy } = useIdentifierCopy();

  return (
    <BusinessListView
      {...state}
      copyNotice={copyNotice}
      onAddingChange={(adding) =>
        dispatch({ type: adding ? "addOpened" : "addCancelled" })
      }
      onCopy={onCopy}
      onCreated={(business) => dispatch({ type: "created", business })}
      onDeleted={(id) => dispatch({ type: "deleted", id })}
      onError={(message) => dispatch({ type: "failed", message })}
      onNavigate={onNavigate}
      onUpdated={(business) => dispatch({ type: "updated", business })}
    />
  );
}

interface BusinessListViewProps extends BusinessListState {
  copyNotice: ReturnType<typeof useIdentifierCopy>["copyNotice"];
  onAddingChange: (adding: boolean) => void;
  onCopy: CopyIdentifier;
  onCreated: (business: Business) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onNavigate: (pathname: string) => void;
  onUpdated: (business: Business) => void;
}

/**
 * The first business is added from an open form. Once one exists, the form
 * folds behind an "Add business" header action so the list leads the page.
 */
export function BusinessListView(props: BusinessListViewProps) {
  const { adding, data, onAddingChange } = props;
  const canManage = data?.canManage ?? false;
  const hasBusinesses = (data?.businesses.length ?? 0) > 0;
  const formOpen = canManage && (adding || !hasBusinesses);
  const addButton = useFocusWhenFolded(formOpen);
  return (
    <Page>
      <PageHeader
        actions={
          canManage &&
          hasBusinesses &&
          !adding && (
            <Button
              icon="add"
              onClick={() => onAddingChange(true)}
              ref={addButton}
              variant="primary"
            >
              Add business
            </Button>
          )
        }
        description="Keep the businesses belonging to this organization in one place."
        eyebrow="Records"
        title="Businesses"
      />
      <PageBody>
        <BusinessListBody {...props} formOpen={formOpen} />
      </PageBody>
    </Page>
  );
}

function BusinessListBody({
  copyNotice,
  data,
  error,
  formOpen,
  loading,
  notice,
  onAddingChange,
  onCopy,
  onCreated,
  onDeleted,
  onError,
  onNavigate,
  onUpdated,
}: BusinessListViewProps & { formOpen: boolean }) {
  const hasBusinesses = (data?.businesses.length ?? 0) > 0;
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {copyNotice && <Toast tone={copyNotice.tone}>{copyNotice.message}</Toast>}
      {loading && !data ? (
        <LoadingState label="Loading businesses…" />
      ) : data ? (
        <>
          {!data.canManage && <ReadOnlyNotice />}
          {formOpen && (
            <BusinessCreateForm
              onCancel={hasBusinesses ? () => onAddingChange(false) : undefined}
              onCreated={onCreated}
              onError={onError}
            />
          )}
          <BusinessList
            businesses={data.businesses}
            canManage={data.canManage}
            onCopy={onCopy}
            onDeleted={onDeleted}
            onError={onError}
            onNavigate={onNavigate}
            onUpdated={onUpdated}
          />
        </>
      ) : (
        <BusinessEmptyState title="Businesses could not be loaded." />
      )}
    </>
  );
}

function ReadOnlyNotice() {
  return (
    <Banner announce={false} icon="lock" tone="neutral">
      Only organization owners and admins can add or change businesses.
    </Banner>
  );
}

function BusinessCreateForm({
  onCancel,
  onCreated,
  onError,
}: {
  /** Present when the form was opened on demand and can fold away again. */
  onCancel: (() => void) | undefined;
  onCreated: (business: Business) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<BusinessFormState>(emptyBusinessForm);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const openedOnDemand = Boolean(onCancel);
  // The header button that opened the form is gone; move focus into the form.
  // A form that is simply open on arrival leaves focus where it was.
  useEffect(() => {
    if (openedOnDemand) nameField.current?.focus();
  }, [openedOnDemand]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.businesses.create(businessInput(form));
      setForm(emptyBusinessForm());
      onCreated(result.business);
    } catch (cause) {
      onError(errorMessage(cause, "Could not add the business."));
    } finally {
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
            {onCancel && (
              <Button disabled={busy} onClick={onCancel} variant="ghost">
                Cancel
              </Button>
            )}
            <Button
              busy={busy}
              disabled={!form.name.trim()}
              icon="add"
              type="submit"
              variant="primary"
            >
              {busy ? "Adding…" : "Add business"}
            </Button>
          </div>
        </>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a business"
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

function BusinessList({
  businesses,
  canManage,
  onNavigate,
  onCopy,
  onDeleted,
  onError,
  onUpdated,
}: {
  businesses: Business[];
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  onCopy: CopyIdentifier;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  const count = businesses.length;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(count, "business", "businesses")}
        </span>
      }
      title="Organization businesses"
    >
      {count === 0 ? (
        <BusinessEmptyState title="No businesses yet." />
      ) : (
        <Card flush>
          <ul className="rowList">
            {businesses.map((business) => (
              <BusinessRow
                business={business}
                canManage={canManage}
                key={business.id}
                onNavigate={onNavigate}
                onCopy={onCopy}
                onDeleted={onDeleted}
                onError={onError}
                onUpdated={onUpdated}
              />
            ))}
          </ul>
        </Card>
      )}
    </PageSection>
  );
}

function BusinessRow({
  business,
  canManage,
  onNavigate,
  onCopy,
  onDeleted,
  onError,
  onUpdated,
}: {
  business: Business;
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  onCopy: CopyIdentifier;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!(await confirmBusinessDeletion(business))) return;
    setBusy(true);
    try {
      await api.businesses.delete(business.id);
      onDeleted(business.id);
    } catch (cause) {
      onError(errorMessage(cause, "Could not delete the business."));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <BusinessEditRow
        business={business}
        onCancel={() => setEditing(false)}
        onError={onError}
        onUpdated={(updatedBusiness) => {
          onUpdated(updatedBusiness);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <BusinessContextMenu business={business} onCopy={onCopy}>
      {(targetProps) => (
        <li className="row" {...targetProps}>
          <BusinessSummary business={business} onNavigate={onNavigate} />
          {canManage && (
            <div className="rowActions businessRowActions">
              <Button
                disabled={busy}
                icon="edit"
                onClick={() => setEditing(true)}
                size="sm"
              >
                Edit
              </Button>
              <Button
                busy={busy}
                icon="trash"
                onClick={() => void remove()}
                size="sm"
                variant="danger"
              >
                {busy ? "Deleting…" : "Delete"}
              </Button>
            </div>
          )}
        </li>
      )}
    </BusinessContextMenu>
  );
}

function BusinessContextMenu({
  business,
  children,
  onCopy,
}: {
  business: Business;
  children: ComponentProps<typeof ContextMenu>["children"];
  onCopy: CopyIdentifier;
}) {
  return (
    <ContextMenu
      items={businessIdentifiers(business).map(({ id, identifier, value }) => ({
        disabled: !value,
        icon: "copy",
        id: `copy-${id}`,
        label: `Copy ${identifier}`,
        onSelect: () => {
          if (value) onCopy(identifier, value);
        },
      }))}
      label={`Actions for ${business.name}`}
    >
      {children}
    </ContextMenu>
  );
}

function BusinessSummary({
  business,
  onNavigate,
}: {
  business: Business;
  onNavigate: (pathname: string) => void;
}) {
  const facts = [
    business.ein ? `EIN ${formatEin(business.ein)}` : "EIN not provided",
  ];
  if (business.duns) facts.push(`DUNS ${formatDuns(business.duns)}`);
  if (business.incorporationDate) {
    facts.push(
      `Incorporated ${formatCalendarDate(business.incorporationDate)}`,
    );
  }
  const address = formatBusinessAddress(business);
  return (
    <AppLink
      className="businessSummary businessSummaryLink"
      href={businessPath(business.id)}
      onNavigate={onNavigate}
    >
      <span aria-hidden="true" className="businessMark">
        <Icon name="businesses" size={18} />
      </span>
      <div className="rowMain">
        <span className="rowTitle">{business.name}</span>
        <span className="rowMeta tabular">{facts.join(" · ")}</span>
        {address && <span className="rowMeta">{address}</span>}
      </div>
    </AppLink>
  );
}

function BusinessEditRow({
  business,
  onCancel,
  onError,
  onUpdated,
}: {
  business: Business;
  onCancel: () => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  const [form, setForm] = useState<BusinessFormState>(() =>
    businessForm(business),
  );
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.businesses.update(
        business.id,
        businessInput(form),
      );
      onUpdated(result.business);
    } catch (cause) {
      onError(errorMessage(cause, "Could not save the business."));
      setBusy(false);
    }
  }

  return (
    <li className="row businessEditRow">
      <form
        aria-label={`Edit ${business.name}`}
        className="formGrid businessEditForm"
        onSubmit={(event) => void save(event)}
      >
        <p className="textSm textStrong">Edit business</p>
        <BusinessFields
          compact
          disabled={busy}
          form={form}
          onChange={setForm}
        />
        <div className="formActions businessEditActions">
          <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!form.name.trim()}
            icon="check"
            size="sm"
            type="submit"
            variant="primary"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </li>
  );
}

function BusinessEmptyState({ title }: { title: string }) {
  return (
    <EmptyState icon="businesses" title={title}>
      Business details will appear here.
    </EmptyState>
  );
}

function confirmBusinessDeletion(business: Business) {
  return confirmDialog({
    confirmLabel: "Delete business",
    message: "This can't be undone.",
    title: `Delete ${business.name}?`,
    tone: "danger",
  });
}
