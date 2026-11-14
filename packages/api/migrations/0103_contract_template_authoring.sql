-- Previously available PDF versions remain available. New API-created versions
-- explicitly start as drafts; subsequent saves append their publication state.
ALTER TABLE contract_template_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'unpublished'));
ALTER TABLE contract_template_versions ADD COLUMN authoring_json TEXT
  CHECK (authoring_json IS NULL OR json_valid(authoring_json));
-- The immutable version edited to produce this version, including history edits.
ALTER TABLE contract_template_versions ADD COLUMN source_version INTEGER
  CHECK (source_version IS NULL OR source_version >= 1);
