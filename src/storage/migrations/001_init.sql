CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  actual_model TEXT,
  actual_provider TEXT,
  proxy_api_key_id INTEGER REFERENCES api_keys(id),
  tool TEXT DEFAULT 'unknown',
  client_id TEXT DEFAULT 'unknown',
  agent TEXT,
  source TEXT DEFAULT 'proxy',
  msg_id TEXT,
  path TEXT NOT NULL,
  streamed INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK(cost_status IN ('unresolved', 'ok', 'pending', 'unsupported')),
  lifecycle_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(lifecycle_status IN ('pending', 'completed', 'error', 'aborted')),
  incomplete INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  finalized_at TEXT,
  meta_json TEXT,
  user_agent TEXT,
  source_ip TEXT,
  cliproxy_account TEXT,
  cliproxy_auth_index TEXT,
  cliproxy_source TEXT,
  correlated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_logs_started_at ON request_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_tool ON request_logs(tool);
CREATE INDEX IF NOT EXISTS idx_request_logs_client_id ON request_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_account ON request_logs(cliproxy_account);
CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_auth_index ON request_logs(cliproxy_auth_index);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider_cliproxy_account_started_at ON request_logs(provider, cliproxy_account, started_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_logs_msg_id ON request_logs(msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_lifecycle_status ON request_logs(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_cost_status ON request_logs(cost_status);

CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_count INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_day ON daily_usage(day);

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

CREATE INDEX IF NOT EXISTS idx_daily_account_usage_day ON daily_account_usage(day);
CREATE INDEX IF NOT EXISTS idx_daily_account_usage_account ON daily_account_usage(cliproxy_account);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  quota_type TEXT NOT NULL,
  model TEXT,
  used_pct REAL,
  remaining REAL,
  remaining_raw TEXT,
  resets_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_snapshots_provider ON quota_snapshots(provider, account, timestamp);

CREATE TABLE IF NOT EXISTS cost_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_log_id INTEGER REFERENCES request_logs(id),
  model TEXT,
  provider TEXT,
  source TEXT,
  base_cost_usd REAL,
  calc_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cost_audit_request_log_id ON cost_audit(request_log_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_used_at TEXT,
  allowed_accounts TEXT,
  allowed_providers TEXT
);
