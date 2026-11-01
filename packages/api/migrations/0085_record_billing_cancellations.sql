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
