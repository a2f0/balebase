import { AuditHome } from "./AuditHome";
import { AuditRunPage } from "./AuditRunPage";
import { AuditTemplateBuilder } from "./AuditTemplateBuilder";
import { recordIdForPath } from "./workspacePaths";

interface AuditsProps {
  onNavigate: (pathname: string) => void;
  pathname: string;
}

export function Audits({ onNavigate, pathname }: AuditsProps) {
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  const templateId = recordIdForPath(pathname, "/audits/templates");
  if (templateId) {
    return (
      <AuditTemplateBuilder
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
