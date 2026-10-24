import { Banner, PageSection } from "@balebase/ui/react";
import type { AuditIssueImage } from "@balebase/validators/audits";
import { useEffect, useState } from "react";
import { ApiImage } from "./ApiImage";
import { api } from "./apiClient";

export function IssueImages({ issueId }: { issueId: string }) {
  const [images, setImages] = useState<AuditIssueImage[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void api.offline
      .images(issueId)
      .then((data) => {
        if (active) setImages(data.images);
      })
      .catch(() => {
        if (active) setError("Could not load issue photos.");
      });
    return () => {
      active = false;
    };
  }, [issueId]);
  if (!images.length && !error) return null;
  return (
    <PageSection title="Photos">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="cluster">
        {images.map((image) => (
          <ApiImage
            key={image.id}
            alt={image.filename}
            src={api.audits.issueImageUrl(issueId, image.id)}
            width={180}
            height={180}
            style={{ objectFit: "contain" }}
          />
        ))}
      </div>
    </PageSection>
  );
}
