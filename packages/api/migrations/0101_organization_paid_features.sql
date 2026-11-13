ALTER TABLE organization ADD COLUMN paid_features_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (paid_features_enabled IN (0, 1));
