CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  path TEXT NOT NULL,
  streamed INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  latency_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  meta_json TEXT
);

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

CREATE INDEX IF NOT EXISTS idx_request_logs_started_at ON request_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_daily_usage_day ON daily_usage(day);
