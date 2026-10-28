-- Issue inserts now skip an assignee who has left in the statement itself,
-- and an offline receipt is written only with the record it reports, so this
-- trigger can no longer find a receipt for the issue it checks.
DROP TRIGGER offline_issue_assignee;
