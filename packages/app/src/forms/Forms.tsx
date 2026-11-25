import { recordIdForPath } from "../workspace/workspacePaths";
import { FormHome } from "./FormHome";
import { FormRunPage } from "./FormRunPage";
import { FormTemplateBuilder } from "./FormTemplateBuilder";

interface FormsProps {
  /** Whether the person can publish and unpublish the organization's templates. */
  canPublish: boolean;
  onNavigate: (pathname: string) => void;
  pathname: string;
}

export function Forms({ canPublish, onNavigate, pathname }: FormsProps) {
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  const templateId = recordIdForPath(pathname, "/forms/templates");
  if (templateId) {
    return (
      <FormTemplateBuilder
        canPublish={canPublish}
        id={templateId}
        key={templateId}
        onNavigate={onNavigate}
      />
    );
  }
  const formId = recordIdForPath(pathname, "/forms/runs");
  if (formId) {
    return <FormRunPage id={formId} key={formId} onNavigate={onNavigate} />;
  }
  return <FormHome onNavigate={onNavigate} />;
}
