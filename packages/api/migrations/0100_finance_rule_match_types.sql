-- Existing rules become exact matches.
-- Retain the unique organization/payee index for the previous Worker.
ALTER TABLE finance_categorization_rules
ADD COLUMN match_type TEXT NOT NULL DEFAULT 'exact'
CHECK (match_type IN ('exact', 'startsWith', 'contains'));
