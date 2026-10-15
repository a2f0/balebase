-- Before publication controls, every global version was shared, even when
-- its stored status was 'draft'. Preserve that availability during upgrade;
-- global drafts created after this migration remain private.
UPDATE audit_template_versions
SET status = 'published'
WHERE status = 'draft'
  AND template_id IN (
    SELECT id FROM audit_template_families WHERE scope = 'global'
  );
