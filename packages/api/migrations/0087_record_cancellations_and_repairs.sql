-- Who is about to cancel a subscription, stored before Stripe is asked to
-- cancel it while deleting an organization. The write that persists the
-- cancellation records `billing.subscription_canceled` from this row and
-- deletes it, whether that is the deleting request or, when the request's
-- write fails after Stripe canceled, the webhook that reports it. An API key
-- is a link only; its name is read when the event is recorded.
CREATE TABLE billing_cancellation_intents (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  api_key_id TEXT,
  api_key_channel TEXT CHECK (api_key_channel IN ('mcp', 'rest')),
  via TEXT NOT NULL CHECK (via IN ('owner', 'root_admin')),
  reason TEXT NOT NULL CHECK (reason = 'organization_deletion'),
  previous_status TEXT,
  -- Unix seconds.
  created_at INTEGER NOT NULL
);

-- An update-mode Plaid Link session a person opened for a connection. The
-- app's report that it repaired the login (`finance.connection_repaired`)
-- must name one, by its link token, and consumes it, so a report cannot be
-- replayed or made without opening Link. Only the token's hash is kept.
CREATE TABLE finance_login_repair_sessions (
  link_token_hash TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES plaid_items (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
