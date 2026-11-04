import {
  Badge,
  type BadgeTone,
  Card,
  EmptyState,
  Icon,
  type IconName,
} from "@balebase/ui/react";
import type {
  AuditTemplate,
  AuditTemplateScope,
} from "@balebase/validators/audits";
import type { ReactNode } from "react";
import { countLabel, formatLabel } from "../shared/labels";
import type { AuditTemplateView } from "./auditTemplateView";

/** A form as the collections show it, with its audit count when known. */
export type ListedTemplate = AuditTemplate & { auditCount?: number };

/**
 * What a collection shows beside each form: a card's footer or a row's end,
 * or nothing when it returns null.
 */
export type TemplateActionsRender = (
  template: ListedTemplate,
  layout: AuditTemplateView,
) => ReactNode;

interface CollectionCopy {
  description: string;
  emptyMessage?: string | undefined;
  emptyTitle: string;
  title: string;
}

/**
 * Global forms, then the organization's own, each as its own collection in
 * the chosen layout.
 */
export function TemplateCollections({
  actions,
  copy,
  templates,
  view,
}: {
  actions?: TemplateActionsRender | undefined;
  copy: Record<AuditTemplateScope, CollectionCopy>;
  templates: ListedTemplate[];
  view: AuditTemplateView;
}) {
  return (
    <div className="auditCollections">
      {(["global", "organization"] as const).map((scope) => (
        <TemplateCollection
          {...copy[scope]}
          actions={actions}
          key={scope}
          templates={templates.filter((template) => template.scope === scope)}
          view={view}
        />
      ))}
    </div>
  );
}

const templateViews: {
  icon: IconName;
  label: string;
  view: AuditTemplateView;
}[] = [
  { icon: "grid", label: "Grid", view: "grid" },
  { icon: "list", label: "List", view: "list" },
];

export function TemplateViewSwitcher({
  onChange,
  view,
}: {
  onChange: (view: AuditTemplateView) => void;
  view: AuditTemplateView;
}) {
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Checklist layout</legend>
      {templateViews.map((option) => (
        <button
          aria-pressed={view === option.view}
          key={option.view}
          onClick={() => onChange(option.view)}
          type="button"
        >
          <Icon name={option.icon} size={16} />
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function TemplateCollection({
  actions,
  description,
  emptyMessage,
  emptyTitle,
  templates,
  title,
  view,
}: CollectionCopy & {
  actions?: TemplateActionsRender | undefined;
  templates: ListedTemplate[];
  view: AuditTemplateView;
}) {
  return (
    <section className="auditCollection">
      <div className="auditCollectionHeading">
        <h3 className="auditCollectionTitle">
          {title}
          <Badge>{templates.length}</Badge>
        </h3>
        <p className="textSm textMuted">{description}</p>
      </div>
      {templates.length === 0 ? (
        <EmptyState compact icon="checklist" title={emptyTitle}>
          {emptyMessage}
        </EmptyState>
      ) : view === "list" ? (
        <Card className="auditTemplateList" flush>
          <ul className="rowList">
            {templates.map((template) => (
              <TemplateRow
                actions={actions?.(template, "list")}
                key={template.id}
                template={template}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <div className="gridAuto auditTemplateGrid">
          {templates.map((template) => (
            <TemplateCard
              actions={actions?.(template, "grid")}
              key={template.id}
              template={template}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TemplateCard({
  actions,
  template,
}: {
  actions: ReactNode;
  template: ListedTemplate;
}) {
  return (
    <article className="card auditTemplateCard">
      <div className="auditTemplateBody">
        <div className="cluster">
          <Badge dot tone={templateStatusTone(template.status)}>
            {formatLabel(template.status)}
          </Badge>
          <Badge tone="info">{scopeLabel(template.scope)}</Badge>
        </div>
        <h4 className="auditTemplateName">{template.name}</h4>
        <p className="auditTemplateDescription">
          {template.description || "A custom checklist."}
        </p>
        <p className="auditTemplateMeta">
          <TemplateStats auditCount={template.auditCount} template={template} />
        </p>
      </div>
      {actions && (
        <div className="cardFooter auditTemplateFooter">{actions}</div>
      )}
    </article>
  );
}

function TemplateRow({
  actions,
  template,
}: {
  actions: ReactNode;
  template: ListedTemplate;
}) {
  return (
    <li className="row auditTemplateRow">
      <span className="rowMain">
        <span className="rowTitle">{template.name}</span>
        <span className="rowMeta">
          {template.description || "A custom checklist."}
        </span>
      </span>
      <span className="auditTemplateRowStats">
        <Badge dot tone={templateStatusTone(template.status)}>
          {formatLabel(template.status)}
        </Badge>
        <TemplateStats auditCount={template.auditCount} template={template} />
      </span>
      {actions && (
        <span className="rowActions auditTemplateRowActions">{actions}</span>
      )}
    </li>
  );
}

/** A form's size and version, and how many audits it has when given. */
export function TemplateStats({
  auditCount,
  template,
}: {
  auditCount?: number | undefined;
  template: AuditTemplate;
}) {
  return (
    <>
      <span className="cluster auditTemplateStat">
        <Icon name="checklist" size={16} />
        {countLabel(itemCount(template), "item")}
      </span>
      <span className="cluster auditTemplateStat">
        <Icon name="layers" size={16} />
        {countLabel(template.definition.sections.length, "section")}
      </span>
      <span className="auditTemplateStat mono">v{template.version}</span>
      {auditCount !== undefined && (
        <span className="cluster auditTemplateStat">
          <Icon name="audits" size={16} />
          {countLabel(auditCount, "audit")}
        </span>
      )}
    </>
  );
}

function itemCount(template: AuditTemplate) {
  return template.definition.sections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
}

export function templateStatusTone(value: string): BadgeTone {
  if (value === "published") return "success";
  return "neutral";
}

function scopeLabel(scope: AuditTemplateScope) {
  return scope === "global" ? "Global" : "Organization";
}
