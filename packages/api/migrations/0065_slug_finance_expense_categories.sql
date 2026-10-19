-- Each expense category gets a URL slug, unique within its organization, for
-- bookmarkable /finance/expenses/category/<slug> routes. "uncategorized" names
-- the bucket of expenses without a category, so no category may use it.
-- SQLite cannot add a NOT NULL column without a default; the API sets the slug
-- whenever it writes a category, and the trigger below covers older Workers.
ALTER TABLE finance_expense_categories ADD COLUMN slug TEXT;

-- Existing names become lowercase ASCII letters and digits separated by single
-- hyphens, as the API slugs ASCII names. Repeats within an organization are
-- numbered in creation order.
WITH RECURSIVE characters (id, name, position, slug) AS (
  SELECT id, lower(name), 1, '' FROM finance_expense_categories
  UNION ALL
  SELECT id, name, position + 1,
         CASE
           WHEN substr(name, position, 1) GLOB '[a-z0-9]'
             THEN slug || substr(name, position, 1)
           WHEN slug = '' OR slug GLOB '*-' THEN slug
           ELSE slug || '-'
         END
  FROM characters
  WHERE position <= length(name)
),
bases AS (
  SELECT category.id, category.organization_id, category.created_at,
         COALESCE(NULLIF(rtrim(characters.slug, '-'), ''), 'category') AS base
  FROM characters
  JOIN finance_expense_categories AS category ON category.id = characters.id
  WHERE characters.position = length(characters.name) + 1
),
candidates AS (
  SELECT id, organization_id, number,
         CASE number WHEN 1 THEN base ELSE base || '-' || number END AS slug
  FROM (
    SELECT id, organization_id, base,
           ROW_NUMBER() OVER (
             PARTITION BY organization_id, base ORDER BY created_at, id
           ) + (base = 'uncategorized') AS number
    FROM bases
  )
)
UPDATE finance_expense_categories
SET slug = (
  SELECT CASE
           -- A numbered slug can repeat another category's: "Meals/drinks"
           -- after "Meals & drinks" and "Meals drinks 2" would both take
           -- meals-drinks-2. Names never slug to a double hyphen, and ids
           -- are unique, so the numbered one adds "--" and its id.
           WHEN candidate.number > 1 AND EXISTS (
             SELECT 1 FROM candidates AS other
             WHERE other.organization_id = candidate.organization_id
               AND other.slug = candidate.slug
               AND other.id <> candidate.id
           ) THEN candidate.slug || '--' || candidate.id
           ELSE candidate.slug
         END
  FROM candidates AS candidate
  WHERE candidate.id = finance_expense_categories.id
);

CREATE UNIQUE INDEX finance_expense_categories_slug_idx
ON finance_expense_categories (organization_id, slug);

-- The Worker running while this migration deploys inserts categories without
-- a slug. They take their id until a rename slugs the name.
CREATE TRIGGER finance_expense_categories_default_slug
AFTER INSERT ON finance_expense_categories
WHEN NEW.slug IS NULL
BEGIN
  UPDATE finance_expense_categories SET slug = NEW.id WHERE id = NEW.id;
END;
