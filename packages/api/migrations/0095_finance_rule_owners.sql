-- Each categorization rule names the person who created it. Rules from
-- before take the creator their creation event recorded.
ALTER TABLE finance_categorization_rules
  ADD COLUMN created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;

UPDATE finance_categorization_rules
SET created_by = (
  SELECT event.actor_user_id
  FROM activity_events AS event
  JOIN "user" AS creator ON creator.id = event.actor_user_id
  WHERE event.action = 'finance.categorization_rule_created'
    AND event.subject_type = 'finance_categorization_rule'
    AND event.subject_id = finance_categorization_rules.id
    AND event.organization_id = finance_categorization_rules.organization_id
  ORDER BY event.id
  LIMIT 1
)
WHERE created_by IS NULL;

-- Applying a rule to existing transactions recorded each one's category
-- change as the person's, without the rule. Name it, as imports do: the
-- change shares the application's moment, person, category, and payee.
UPDATE activity_events
SET details = json_set(
  activity_events.details,
  '$.ruleId', applied.subject_id,
  '$.rulePayeeName', json_extract(applied.details, '$.payeeName')
)
FROM activity_events AS applied
WHERE activity_events.action = 'finance.transaction_categorized'
  AND applied.action = 'finance.categorization_rule_applied'
  AND applied.subject_type = 'finance_categorization_rule'
  AND activity_events.organization_id = applied.organization_id
  AND activity_events.occurred_at = applied.occurred_at
  AND activity_events.actor_user_id = applied.actor_user_id
  AND activity_events.root_label = json_extract(applied.details, '$.payeeName')
  AND json_extract(activity_events.details, '$.after')
    = json_extract(applied.details, '$.categoryId')
  AND json_extract(activity_events.details, '$.ruleId') IS NULL;
