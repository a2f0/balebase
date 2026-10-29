import { Banner, PageSection } from "@balebase/ui/react";
import { useCallback } from "react";
import { ApiImage } from "./shared/ApiImage";
import { api } from "./shared/apiClient";
import { useLoad } from "./shared/useLoad";

export function IssueImages({ issueId }: { issueId: string }) {
  const loaded = useLoad(
    useCallback(
      async () => (await api.offline.images(issueId)).images,
      [issueId],
    ),
    "Could not load issue photos.",
  );
  const images = loaded.data ?? [];
  const error = loaded.error && "Could not load issue photos.";
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
