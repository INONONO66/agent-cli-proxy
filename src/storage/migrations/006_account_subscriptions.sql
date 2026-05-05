CREATE TABLE IF NOT EXISTS account_subscriptions (
  cliproxy_account TEXT PRIMARY KEY,
  subscription_code TEXT NOT NULL,
  bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_subscription_code
  ON account_subscriptions(subscription_code);
