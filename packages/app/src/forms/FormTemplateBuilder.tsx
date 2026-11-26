import {
  Banner,
  Button,
  Card,
  ContextMenu,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  type SectionTabState,
  Select,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type {
  FormTemplate,
  FormTemplateItem,
  FormTemplateSection,
  FormTemplateVersion,
  TemplatePublication,
} from "@balebase/validators/forms";
import { formLimits } from "@balebase/validators/rules";
import { type ReactNode, useCallback, useState } from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { balebase } from "../balebase";
import { ErrorToast } from "../billing/ErrorToast";
import type { ErrorNotice } from "../shared/errors";
import { countLabel, formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import {
  formTemplatePath,
  globalTemplatesPath,
} from "../workspace/workspacePaths";
import { GlobalFormControls, PublicationControls } from "./GlobalFormControls";
import { TemplateProjects } from "./TemplateProjects";
import { moveEntry, useReorderDrag } from "./useReorderDrag";

interface BuilderProps {
  /** Whether the person can publish and unpublish the organization's templates. */
  canPublish?: boolean;
  id: string;
  manageGlobal?: boolean;
  onNavigate: (pathname: string) => void;
}

interface BackLink {
  label: string;
  onBack: () => void;
}

/**
 * A template, at its current version unless one is given. Root admin's
 * Global templates reads global templates; an organization, its own and published
 * global templates.
 */
function loadTemplate(id: string, manageGlobal: boolean, version?: number) {
  if (manageGlobal) {
    return version === undefined
      ? balebase().api.adminFormTemplates.get(id)
      : balebase().api.adminFormTemplates.getVersion(id, version);
  }
  return version === undefined
    ? balebase().api.forms.getTemplate(id)
    : balebase().api.forms.getTemplateVersion(id, version);
}

function loadVersions(id: string, manageGlobal: boolean) {
  return manageGlobal
    ? balebase().api.adminFormTemplates.listVersions(id)
    : balebase().api.forms.listTemplateVersions(id);
}

/**
 * Saves the editor's copy as the template's next version, publishing or
 * unpublishing it when asked. An organization's edits to a global template
 * become a template of its own.
 */
function saveTemplate(
  template: FormTemplate,
  manageGlobal: boolean,
  status: TemplatePublication,
) {
  if (manageGlobal)
    return balebase().api.adminFormTemplates.update(template, status);
  return template.scope === "global"
    ? balebase().api.forms.copyTemplate(template)
    : balebase().api.forms.updateTemplate(template, status);
}

function useTemplateBuilder({
  id,
  manageGlobal = false,
  onNavigate,
}: BuilderProps) {
  const loaded = useLoad(
    useCallback(async () => {
      const [{ template }, { versions }] = await Promise.all([
        loadTemplate(id, manageGlobal),
        loadVersions(id, manageGlobal),
      ]);
      return { currentStatus: template.status, template, versions };
    }, [id, manageGlobal]),
    "Could not load the template.",
  );
  const { setData } = loaded;
  const template = loaded.data?.template;
  const versionLoad = useAction("Could not load that version.");
  const saving = useAction("Could not save the template.");
  const [notice, setNotice] = useState<string>();
  const setTemplate = (next: FormTemplate) =>
    setData((current) => current && { ...current, template: next });

  async function selectVersion(version: number) {
    if (!template || version === template.version) return;
    setNotice(undefined);
    saving.setError(undefined);
    await versionLoad.run(async () => {
      const { template: selected } = await loadTemplate(
        id,
        manageGlobal,
        version === template.currentVersion ? undefined : version,
      );
      setTemplate(selected);
    });
  }

  async function save(status?: TemplatePublication) {
    if (!template) return;
    setNotice(undefined);
    versionLoad.setError(undefined);
    await saving.run(async () => {
      const copiedGlobal = template.scope === "global" && !manageGlobal;
      const { template: saved } = await saveTemplate(
        template,
        manageGlobal,
        status,
      );
      setData(
        (current) =>
          current && {
            ...current,
            currentStatus: saved.status,
            template: saved,
          },
      );
      setNotice(
        copiedGlobal
          ? "Organization template created. The global template is unchanged."
          : status
            ? `Template ${status}.`
            : `Version ${saved.version} saved.`,
      );
      if (saved.id !== id) {
        onNavigate(formTemplatePath(saved.id));
      }
      const { versions } = await loadVersions(saved.id, manageGlobal);
      setData((current) => current && { ...current, versions });
    });
  }

  const loadError: ErrorNotice | undefined = loaded.error
    ? { message: loaded.error, upgrade: false }
    : undefined;
  return {
    template,
    currentStatus: loaded.data?.currentStatus,
    versions: loaded.data?.versions,
    busy: versionLoad.busy || saving.busy,
    error: saving.failure ?? versionLoad.failure ?? loadError,
    notice,
    save,
    selectVersion,
    setTemplate,
    setNotice,
  };
}

export function FormTemplateBuilder({
  canPublish = false,
  id,
  manageGlobal = false,
  onNavigate,
}: BuilderProps) {
  const {
    template,
    currentStatus,
    versions,
    busy,
    error,
    notice,
    save,
    selectVersion,
    setTemplate,
    setNotice,
  } = useTemplateBuilder({ id, manageGlobal, onNavigate });
  const back = backLink(manageGlobal, onNavigate);
  const [initialTab] = useState(() => openedTab(manageGlobal));
  const tabs = useSectionTabs(
    [
      { id: "template", label: "Template" },
      // Global templates manages the template itself; projects are an organization's.
      !manageGlobal && { id: "projects", label: "Projects" },
      { id: "activity", label: "Activity" },
    ] as const,
    initialTab ? { initial: initialTab } : {},
  );
  if (!template) return <BuilderLoading back={back} error={error?.message} />;

  return (
    <Page>
      <BuilderHeader
        back={back}
        busy={busy}
        canPublish={canPublish}
        manageGlobal={manageGlobal}
        currentStatus={currentStatus ?? template.status}
        onSave={save}
        onVersionChange={selectVersion}
        tabs={tabs.tabs}
        template={template}
        versions={versions ?? []}
      />
      <BuilderBody
        busy={busy}
        error={error}
        manageGlobal={manageGlobal}
        notice={notice}
        onChange={(nextTemplate) => {
          setTemplate(nextTemplate);
          setNotice(undefined);
        }}
        onNavigate={onNavigate}
        panel={tabs.panel}
        template={template}
      />
    </Page>
  );
}

type BuilderSections = SectionTabState<"activity" | "template" | "projects">;

/**
 * `?tab=projects` (Assign projects on Forms) opens the Projects tab once,
 * then leaves the address, so reloading or sharing it opens the template.
 */
function openedTab(manageGlobal: boolean) {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.get("tab") !== "projects") return undefined;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname,
  );
  return manageGlobal ? undefined : ("projects" as const);
}

/** A global template being managed returns to Global templates. */
function backLink(
  manageGlobal: boolean,
  onNavigate: (pathname: string) => void,
): BackLink {
  return manageGlobal
    ? {
        label: "Global templates",
        onBack: () => onNavigate(globalTemplatesPath()),
      }
    : { label: "Forms", onBack: () => onNavigate("/forms") };
}

function BuilderBody({
  busy,
  error,
  manageGlobal,
  notice,
  onChange: change,
  onNavigate,
  panel,
  template,
}: {
  /**
   * A save or version load in flight. Its result replaces the template, so the
   * template holds still until it lands instead of dropping later edits: the
   * fieldset disables the fields, and changes from anywhere else (dragging
   * or arrow keys on a reorder handle) are ignored.
   */
  busy: boolean;
  error: ErrorNotice | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  onChange: (template: FormTemplate) => void;
  onNavigate: (pathname: string) => void;
  panel: BuilderSections["panel"];
  template: FormTemplate;
}) {
  const onChange = (next: FormTemplate) => {
    if (!busy) change(next);
  };
  const sections = template.definition.sections;
  const updateSections = (nextSections: FormTemplateSection[]) =>
    onChange({
      ...template,
      definition: { ...template.definition, sections: nextSections },
    });
  const moveSection = (from: number, to: number, focus: FocusTarget) => {
    const moved = sections[from];
    if (!moved || to < 0 || to >= sections.length) return;
    updateSections(moveEntry(sections, from, to));
    refocus(focus, moved.id);
  };
  const sectionDrag = useReorderDrag(
    sections.map(({ id }) => id),
    (from, to) => moveSection(from, to, "handle"),
  );
  return (
    <PageBody>
      <BuilderNotices
        error={error}
        manageGlobal={manageGlobal}
        notice={notice}
        onNavigate={onNavigate}
        template={template}
      />
      {panel(
        "template",
        <fieldset className="fieldset formBuilderFields" disabled={busy}>
          <TemplateDetails template={template} update={onChange} />
          <div className="stack">
            <div className="sectionHeader">
              <h2 className="sectionTitle">Sections</h2>
              <span className="sectionCount">
                {countLabel(sections.length, "section")} ·{" "}
                {countLabel(questionCount(sections), "question")}
              </span>
            </div>
            {sections.map((section, index) => (
              <SectionEditor
                canRemove={sections.length > 1}
                count={sections.length}
                entry={sectionDrag.entryState(index)}
                handle={sectionDrag.handleProps(index)}
                index={index}
                key={section.id}
                onShift={(step) => moveSection(index, index + step, "number")}
                onChange={(nextSection) =>
                  updateSections(replaceById(sections, nextSection))
                }
                onRemove={() =>
                  updateSections(
                    sections.filter((candidate) => candidate.id !== section.id),
                  )
                }
                section={section}
              />
            ))}
            <Button
              block
              className="formAddButton"
              icon="add"
              onClick={() => updateSections([...sections, newSection()])}
            >
              Add section
            </Button>
          </div>
        </fieldset>,
      )}
      {panel(
        "projects",
        <TemplateProjects
          templateName={template.name}
          onNavigate={onNavigate}
          refreshKey={`${template.currentVersion}:${template.status}`}
          templateId={template.id}
        />,
      )}
      {panel(
        "activity",
        <ActivityFeed
          refreshKey={template.currentVersion}
          source={{
            id: template.id,
            type: manageGlobal ? "global_form_template" : "form_template",
          }}
        />,
      )}
    </PageBody>
  );
}

function BuilderNotices({
  error,
  manageGlobal,
  notice,
  onNavigate,
  template,
}: {
  error: ErrorNotice | undefined;
  manageGlobal: boolean;
  notice: string | undefined;
  onNavigate: (pathname: string) => void;
  template: FormTemplate;
}) {
  const isGlobal = template.scope === "global";
  return (
    <>
      <ErrorToast error={error} onNavigate={onNavigate} />
      {notice && <Toast tone="success">{notice}</Toast>}
      {isGlobal && !manageGlobal && (
        <Banner announce={false} icon="copy" tone="info">
          Changes will be saved as a new template for this organization. The
          global template and its version history will stay unchanged.
        </Banner>
      )}
      {isGlobal && manageGlobal && (
        <Banner announce={false} tone="warning">
          You are managing the shared global template. Published templates are
          available to every organization. Draft and unpublished templates stay
          private to root admins.
        </Banner>
      )}
      {template.version < template.currentVersion && (
        <Banner announce={false} icon="layers" tone="neutral">
          {template.scope === "organization" || manageGlobal ? (
            <>
              You are viewing version {template.version}. Saving changes will
              create version {template.currentVersion + 1}; this version will
              stay unchanged.
            </>
          ) : (
            <>
              You are using global version {template.version} as the starting
              point. The latest global version is {template.currentVersion}.
            </>
          )}
        </Banner>
      )}
    </>
  );
}

function BuilderHeader({
  back,
  busy,
  canPublish,
  currentStatus,
  manageGlobal,
  onSave,
  onVersionChange,
  tabs,
  template,
  versions,
}: {
  back: BackLink;
  busy: boolean;
  canPublish: boolean;
  currentStatus: string;
  manageGlobal: boolean;
  onSave: (status?: TemplatePublication) => Promise<void>;
  onVersionChange: (version: number) => Promise<void>;
  tabs: BuilderSections["tabs"];
  template: FormTemplate;
  versions: FormTemplateVersion[];
}) {
  const customizing = template.scope === "global" && !manageGlobal;
  return (
    <PageHeader
      actions={
        <div className="formVersionControls">
          {manageGlobal ? (
            <GlobalFormControls
              busy={busy}
              onDiscarded={back.onBack}
              onSave={onSave}
              status={currentStatus}
              template={template}
            />
          ) : (
            !customizing && (
              <PublicationControls
                busy={busy}
                onSave={canPublish ? onSave : undefined}
                status={currentStatus}
              />
            )
          )}
          <label className="formVersionPicker">
            <span className="formVersionLabel">Version</span>
            <Select
              className="formVersionSelect"
              disabled={busy || versions.length === 0}
              onChange={(event) =>
                void onVersionChange(Number(event.target.value))
              }
              value={template.version}
            >
              {versions.map((version) => (
                <option key={version.version} value={version.version}>
                  v{version.version} · {formatDate(version.createdAt)} ·{" "}
                  {version.createdBy.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            busy={busy}
            icon="check"
            onClick={() => void onSave()}
            variant="primary"
          >
            {busy
              ? "Saving…"
              : customizing
                ? "Save organization copy"
                : `Save as version ${template.currentVersion + 1}`}
          </Button>
        </div>
      }
      back={<BackButton {...back} />}
      eyebrow={
        <>
          {template.scope === "global"
            ? "Global template"
            : "Organization template"}
          {" · "}Version {template.version} of {template.currentVersion}
        </>
      }
      tabs={tabs}
      tabsKind="panels"
      tabsLabel="Template sections"
      title={customizing ? "Customize template" : "Edit template"}
    />
  );
}

function BackButton({ label, onBack }: BackLink) {
  return (
    <Button
      className="formBack"
      icon="arrowLeft"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      {label}
    </Button>
  );
}

function TemplateDetails({
  template,
  update,
}: {
  template: FormTemplate;
  update: (template: FormTemplate) => void;
}) {
  return (
    <Card title="Details">
      <div className="formGrid">
        <Field label="Template name">
          <input
            className="input"
            maxLength={formLimits.name}
            onChange={(event) =>
              update({ ...template, name: event.target.value })
            }
            required
            value={template.name}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            className="textarea formDescriptionInput"
            maxLength={formLimits.description}
            onChange={(event) =>
              update({ ...template, description: event.target.value })
            }
            placeholder="What should someone know before filling this in?"
            rows={3}
            value={template.description}
          />
        </Field>
      </div>
    </Card>
  );
}

function SectionEditor({
  canRemove,
  count,
  entry,
  handle,
  index,
  onChange,
  onRemove,
  onShift,
  section,
}: ReorderableProps & {
  canRemove: boolean;
  onChange: (section: FormTemplateSection) => void;
  onRemove: () => void;
  section: FormTemplateSection;
}) {
  const updateItem = (item: FormTemplateItem) =>
    onChange({ ...section, items: replaceById(section.items, item) });
  const moveQuestion = (from: number, to: number, focus: FocusTarget) => {
    const moved = section.items[from];
    if (!moved || to < 0 || to >= section.items.length) return;
    onChange({ ...section, items: moveEntry(section.items, from, to) });
    refocus(focus, moved.id);
  };
  const questionDrag = useReorderDrag(
    section.items.map(({ id }) => id),
    (from, to) => moveQuestion(from, to, "handle"),
  );
  const label = `Section ${index + 1}`;
  return (
    <article {...entryProps(entry, "card formSectionCard")}>
      <header className="formSectionHeader">
        <ReorderHandle entryId={section.id} handle={handle} label={label} />
        <PositionMenu
          className="formSectionNumber"
          count={count}
          entryId={section.id}
          index={index}
          label={label}
          onShift={onShift}
        >
          {String(index + 1).padStart(2, "0")}
        </PositionMenu>
        <input
          aria-label={`Section ${index + 1} title`}
          className="input formSectionTitle"
          maxLength={formLimits.sectionTitle}
          onChange={(event) =>
            onChange({ ...section, title: event.target.value })
          }
          value={section.title}
        />
        <Button
          aria-label={`Remove section ${index + 1}`}
          className="formRemoveButton"
          disabled={!canRemove}
          icon="trash"
          iconOnly
          onClick={onRemove}
          size="sm"
          title="Remove section"
          variant="ghost"
        />
      </header>
      {section.items.length > 0 ? (
        <div className="formQuestionList">
          {section.items.map((item, itemIndex) => (
            <QuestionEditor
              count={section.items.length}
              entry={questionDrag.entryState(itemIndex)}
              handle={questionDrag.handleProps(itemIndex)}
              index={itemIndex}
              item={item}
              key={item.id}
              onChange={updateItem}
              onShift={(step) =>
                moveQuestion(itemIndex, itemIndex + step, "number")
              }
              onRemove={() =>
                onChange({
                  ...section,
                  items: section.items.filter(
                    (candidate) => candidate.id !== item.id,
                  ),
                })
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          className="formQuestionEmpty"
          compact
          icon="template"
          plain
          title="No questions in this section"
        />
      )}
      <div className="formSectionFooter">
        <Button
          block
          className="formAddButton"
          icon="add"
          onClick={() =>
            onChange({ ...section, items: [...section.items, newItem()] })
          }
          size="sm"
        >
          Add question
        </Button>
      </div>
    </article>
  );
}

function QuestionEditor({
  count,
  entry,
  handle,
  index,
  item,
  onChange,
  onRemove,
  onShift,
}: ReorderableProps & {
  item: FormTemplateItem;
  onChange: (item: FormTemplateItem) => void;
  onRemove: () => void;
}) {
  const label = `Question ${index + 1}`;
  return (
    <div {...entryProps(entry, "formQuestion")}>
      <ReorderHandle entryId={item.id} handle={handle} label={label} />
      <PositionMenu
        className="formQuestionNumber"
        count={count}
        entryId={item.id}
        index={index}
        label={label}
        onShift={onShift}
      >
        {index + 1}
      </PositionMenu>
      <textarea
        aria-label={`Question ${index + 1}`}
        className="textarea formQuestionPrompt"
        maxLength={formLimits.prompt}
        onChange={(event) => onChange({ ...item, prompt: event.target.value })}
        rows={2}
        value={item.prompt}
      />
      <div className="formQuestionControls">
        <Select
          aria-label="Response type"
          className="inputSm formResponseType"
          onChange={(event) =>
            onChange({
              ...item,
              responseType: event.target.value === "text" ? "text" : "check",
            })
          }
          value={item.responseType}
        >
          <option value="check">Pass / fail / N/A</option>
          <option value="text">Text answer</option>
        </Select>
        <label className="check formRequired">
          <input
            checked={item.required}
            onChange={(event) =>
              onChange({ ...item, required: event.target.checked })
            }
            type="checkbox"
          />
          Required
        </label>
      </div>
      <Button
        aria-label={`Delete question ${index + 1}`}
        className="formRemoveButton formQuestionRemove"
        icon="trash"
        iconOnly
        onClick={onRemove}
        size="sm"
        title="Delete question"
        variant="ghost"
      />
    </div>
  );
}

type ReorderDrag = ReturnType<typeof useReorderDrag>;

interface ReorderableProps {
  count: number;
  entry: ReturnType<ReorderDrag["entryState"]>;
  handle: ReturnType<ReorderDrag["handleProps"]>;
  index: number;
  /** Moves the entry one place up (-1) or down (1). */
  onShift: (step: -1 | 1) => void;
}

type FocusTarget = "handle" | "number";

/**
 * Moving an entry re-inserts its element, which drops focus. Put focus back
 * on the control that moved it once the new order is drawn.
 */
function refocus(target: FocusTarget, entryId: string) {
  const key = `${target}-${entryId}`;
  requestAnimationFrame(() => {
    // Compared, not interpolated into a selector, so any ID is safe.
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-reorder-focus]",
    )) {
      if (element.getAttribute("data-reorder-focus") === key) element.focus();
    }
  });
}

/** Marks a reorderable entry, and shows it lifted or as the drop point. */
function entryProps(
  entry: ReturnType<ReorderDrag["entryState"]>,
  className: string,
) {
  return {
    className: cx(
      className,
      "formReorderEntry",
      entry.dragging && "formDragging",
      entry.drop === "before" && "formDropBefore",
      entry.drop === "after" && "formDropAfter",
    ),
    "data-reorder-item": "",
    style: entry.dragging
      ? { transform: `translateY(${entry.offset}px)` }
      : undefined,
  };
}

/** Drags the entry; the arrow keys move it one place at a time too. */
function ReorderHandle({
  entryId,
  handle,
  label,
}: {
  entryId: string;
  handle: ReturnType<ReorderDrag["handleProps"]>;
  label: string;
}) {
  return (
    <button
      {...handle}
      aria-label={`Reorder ${label.toLowerCase()}`}
      className="formDragHandle"
      data-reorder-focus={`handle-${entryId}`}
      title="Drag, or use the arrow keys, to reorder"
      type="button"
    >
      <Icon name="drag" size={16} />
    </button>
  );
}

/** The entry's number, which opens Move up and Move down. */
function PositionMenu({
  children,
  className,
  count,
  entryId,
  index,
  label,
  onShift,
}: {
  children: ReactNode;
  className: string;
  count: number;
  entryId: string;
  index: number;
  label: string;
  onShift: (step: -1 | 1) => void;
}) {
  return (
    <ContextMenu
      items={[
        {
          disabled: index === 0,
          icon: "arrowUp",
          id: "up",
          label: "Move up",
          onSelect: () => onShift(-1),
        },
        {
          disabled: index === count - 1,
          icon: "arrowDown",
          id: "down",
          label: "Move down",
          onSelect: () => onShift(1),
        },
      ]}
      label={`${label} order`}
      openOnClick
    >
      {(props) => (
        <button
          {...props}
          aria-haspopup="menu"
          aria-label={`${label} order`}
          className={className}
          data-reorder-focus={`number-${entryId}`}
          type="button"
        >
          {children}
        </button>
      )}
    </ContextMenu>
  );
}

function BuilderLoading({
  back,
  error,
}: {
  back: BackLink;
  error: string | undefined;
}) {
  const returnButton = (
    <Button
      icon="arrowLeft"
      onClick={back.onBack}
      size={error ? "sm" : "md"}
      variant={error ? "secondary" : "ghost"}
    >
      Return to {back.label.toLowerCase()}
    </Button>
  );
  return (
    <Page>
      <PageBody>
        {error ? (
          <Banner actions={returnButton} tone="danger">
            {error}
          </Banner>
        ) : (
          <div className="formBuilderState">
            <LoadingState label="Loading template…" />
            {returnButton}
          </div>
        )}
      </PageBody>
    </Page>
  );
}

function newItem(): FormTemplateItem {
  return {
    id: crypto.randomUUID(),
    prompt: "Untitled question",
    required: true,
    responseType: "check",
  };
}

function newSection(): FormTemplateSection {
  return { id: crypto.randomUUID(), items: [newItem()], title: "New section" };
}

function replaceById<T extends { id: string }>(items: T[], replacement: T) {
  return items.map((item) => (item.id === replacement.id ? replacement : item));
}

function questionCount(sections: FormTemplateSection[]) {
  return sections.reduce((count, section) => count + section.items.length, 0);
}
