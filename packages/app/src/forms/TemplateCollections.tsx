import {
  Badge,
  type BadgeTone,
  Card,
  ContextMenu,
  EmptyState,
  Icon,
  type IconName,
  MenuButton,
} from "@balebase/ui/react";
import type {
  FormTemplate,
  FormTemplateScope,
} from "@balebase/validators/forms";
import type { ComponentProps, ReactNode } from "react";
import { countLabel, formatLabel } from "../shared/labels";
import type { FormTemplateView } from "./formTemplateView";

/** A template as the collections show it, with its form count when known. */
export type ListedTemplate = FormTemplate & { formCount?: number };

/**
 * What a collection shows beside each template: a card's footer or a row's end,
 * or nothing when it returns null.
 */
export type TemplateActionsRender = (
  template: ListedTemplate,
  layout: FormTemplateView,
) => ReactNode;

/**
 * A template's menu, opened from its menu button or by right-clicking (or the
 * menu key) anywhere on its card or row.
 */
export type TemplateMenuRender = (template: ListedTemplate) => {
  items: ComponentProps<typeof ContextMenu>["items"];
  label: string;
};

interface CollectionCopy {
  description: string;
  emptyMessage?: string | undefined;
  emptyTitle: string;
  title: string;
}

/**
 * Global templates, then the organization's own, each as its own collection in
 * the chosen layout.
 */
export function TemplateCollections({
  actions,
  copy,
  menu,
  templates,
  view,
}: {
  actions?: TemplateActionsRender | undefined;
  copy: Record<FormTemplateScope, CollectionCopy>;
  menu?: TemplateMenuRender | undefined;
  templates: ListedTemplate[];
  view: FormTemplateView;
}) {
  return (
    <div className="formCollections">
      {(["global", "organization"] as const).map((scope) => (
        <TemplateCollection
          {...copy[scope]}
          actions={actions}
          key={scope}
          menu={menu}
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
  view: FormTemplateView;
}[] = [
  { icon: "grid", label: "Grid", view: "grid" },
  { icon: "list", label: "List", view: "list" },
];

export function TemplateViewSwitcher({
  onChange,
  view,
}: {
  onChange: (view: FormTemplateView) => void;
  view: FormTemplateView;
}) {
  return (
    <fieldset className="segmented">
      <legend className="srOnly">Template layout</legend>
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
  menu,
  templates,
  title,
  view,
}: CollectionCopy & {
  actions?: TemplateActionsRender | undefined;
  menu?: TemplateMenuRender | undefined;
  templates: ListedTemplate[];
  view: FormTemplateView;
}) {
  return (
    <section className="formCollection">
      <div className="formCollectionHeading">
        <h3 className="formCollectionTitle">
          {title}
          <Badge>{templates.length}</Badge>
        </h3>
        <p className="textSm textMuted">{description}</p>
      </div>
      {templates.length === 0 ? (
        <EmptyState compact icon="template" title={emptyTitle}>
          {emptyMessage}
        </EmptyState>
      ) : view === "list" ? (
        <Card className="formTemplateList" flush>
          <ul className="rowList">
            {templates.map((template) => (
              <TemplateMenu key={template.id} menu={menu} template={template}>
                {(target, menuButton) => (
                  <TemplateRow
                    actions={withMenu(actions?.(template, "list"), menuButton)}
                    target={target}
                    template={template}
                  />
                )}
              </TemplateMenu>
            ))}
          </ul>
        </Card>
      ) : (
        <div className="gridAuto formTemplateGrid">
          {templates.map((template) => (
            <TemplateMenu key={template.id} menu={menu} template={template}>
              {(target, menuButton) => (
                <TemplateCard
                  actions={withMenu(actions?.(template, "grid"), menuButton)}
                  target={target}
                  template={template}
                />
              )}
            </TemplateMenu>
          ))}
        </div>
      )}
    </section>
  );
}

/** A card's or row's own actions followed by its menu button, if any. */
function withMenu(actions: ReactNode, menuButton: ReactNode) {
  if (!menuButton) return actions;
  return (
    <>
      {actions}
      {menuButton}
    </>
  );
}

type MenuTarget = Parameters<ComponentProps<typeof ContextMenu>["children"]>[0];

/**
 * Wraps a card or row in its template's menu, passing the target handlers and the
 * menu button; without a menu it passes neither.
 */
function TemplateMenu({
  children,
  menu,
  template,
}: {
  children: (
    target: MenuTarget | undefined,
    menuButton: ReactNode,
  ) => ReactNode;
  menu: TemplateMenuRender | undefined;
  template: ListedTemplate;
}) {
  if (!menu) return children(undefined, null);
  const { items, label } = menu(template);
  return (
    <ContextMenu items={items} label={label}>
      {(target, menuButton) =>
        children(target, <MenuButton {...menuButton} label={label} />)
      }
    </ContextMenu>
  );
}

function TemplateCard({
  actions,
  target,
  template,
}: {
  actions: ReactNode;
  target: MenuTarget | undefined;
  template: ListedTemplate;
}) {
  return (
    <article className="card formTemplateCard" {...target}>
      <div className="formTemplateBody">
        <div className="cluster">
          <Badge dot tone={templateStatusTone(template.status)}>
            {formatLabel(template.status)}
          </Badge>
          <Badge tone="info">{scopeLabel(template.scope)}</Badge>
        </div>
        <h4 className="formTemplateName">{template.name}</h4>
        <p className="formTemplateDescription">
          {template.description || "A custom template."}
        </p>
        <p className="formTemplateMeta">
          <TemplateStats formCount={template.formCount} template={template} />
        </p>
      </div>
      {actions && (
        <div className="cardFooter formTemplateFooter">{actions}</div>
      )}
    </article>
  );
}

function TemplateRow({
  actions,
  target,
  template,
}: {
  actions: ReactNode;
  target: MenuTarget | undefined;
  template: ListedTemplate;
}) {
  return (
    <li className="row formTemplateRow" {...target}>
      <span className="rowMain">
        <span className="rowTitle">{template.name}</span>
        <span className="rowMeta">
          {template.description || "A custom template."}
        </span>
      </span>
      <span className="formTemplateRowStats">
        <Badge dot tone={templateStatusTone(template.status)}>
          {formatLabel(template.status)}
        </Badge>
        <TemplateStats formCount={template.formCount} template={template} />
      </span>
      {actions && (
        <span className="rowActions formTemplateRowActions">{actions}</span>
      )}
    </li>
  );
}

/** A template's size and version, and how many forms it has when given. */
export function TemplateStats({
  formCount,
  template,
}: {
  formCount?: number | undefined;
  template: FormTemplate;
}) {
  return (
    <>
      <span className="cluster formTemplateStat">
        <Icon name="template" size={16} />
        {countLabel(itemCount(template), "item")}
      </span>
      <span className="cluster formTemplateStat">
        <Icon name="layers" size={16} />
        {countLabel(template.definition.sections.length, "section")}
      </span>
      <span className="formTemplateStat mono">v{template.version}</span>
      {formCount !== undefined && (
        <span className="cluster formTemplateStat">
          <Icon name="forms" size={16} />
          {countLabel(formCount, "form")}
        </span>
      )}
    </>
  );
}

function itemCount(template: FormTemplate) {
  return template.definition.sections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
}

export function templateStatusTone(value: string): BadgeTone {
  if (value === "published") return "success";
  return "neutral";
}

function scopeLabel(scope: FormTemplateScope) {
  return scope === "global" ? "Global" : "Organization";
}
