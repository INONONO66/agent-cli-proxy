-- Add CLIProxyAPI account attribution
ALTER TABLE request_logs ADD COLUMN cliproxy_account TEXT;
ALTER TABLE request_logs ADD COLUMN cliproxy_auth_index TEXT;
ALTER TABLE request_logs ADD COLUMN cliproxy_source TEXT;
ALTER TABLE request_logs ADD COLUMN request_id TEXT;
ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN actual_model TEXT;
ALTER TABLE request_logs ADD COLUMN user_agent TEXT;
ALTER TABLE request_logs ADD COLUMN source_ip TEXT;
ALTER TABLE request_logs ADD COLUMN correlated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_account
  ON request_logs(cliproxy_account);
CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_auth_index
  ON request_logs(cliproxy_auth_index);
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id
  ON request_logs(request_id);

-- Daily usage breakdown by cliproxy account
CREATE TABLE IF NOT EXISTS daily_account_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cliproxy_account TEXT NOT NULL,
  cliproxy_auth_index TEXT,
  request_count INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  PRIMARY KEY (day, provider, model, cliproxy_account)
);

CREATE INDEX IF NOT EXISTS idx_daily_account_usage_day
  ON daily_account_usage(day);
CREATE INDEX IF NOT EXISTS idx_daily_account_usage_account
  ON daily_account_usage(cliproxy_account);
