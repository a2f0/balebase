import { recordIdForPath } from "../workspace/workspacePaths";
import { AuditHome } from "./AuditHome";
import { AuditRunPage } from "./AuditRunPage";
import { AuditTemplateBuilder } from "./AuditTemplateBuilder";

interface AuditsProps {
  /** Whether the person can publish and unpublish the organization's forms. */
  canPublish: boolean;
  onNavigate: (pathname: string) => void;
  pathname: string;
}

export function Audits({ canPublish, onNavigate, pathname }: AuditsProps) {
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  const templateId = recordIdForPath(pathname, "/audits/templates");
  if (templateId) {
    return (
      <AuditTemplateBuilder
        canPublish={canPublish}
        id={templateId}
        key={templateId}
        onNavigate={onNavigate}
      />
    );
  }
  const auditId = recordIdForPath(pathname, "/audits/runs");
  if (auditId) {
    return <AuditRunPage id={auditId} key={auditId} onNavigate={onNavigate} />;
  }
  return <AuditHome onNavigate={onNavigate} />;
}
