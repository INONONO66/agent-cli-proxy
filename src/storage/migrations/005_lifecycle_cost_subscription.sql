ALTER TABLE request_logs ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'pending' CHECK(lifecycle_status IN ('pending', 'completed', 'error', 'aborted'));
ALTER TABLE request_logs ADD COLUMN cost_status TEXT NOT NULL DEFAULT 'unresolved' CHECK(cost_status IN ('unresolved', 'ok', 'pending', 'unsupported'));
ALTER TABLE request_logs ADD COLUMN subscription_code TEXT;
ALTER TABLE request_logs ADD COLUMN finalized_at TEXT;
ALTER TABLE request_logs ADD COLUMN error_message TEXT;

UPDATE request_logs
SET lifecycle_status = CASE
    WHEN incomplete = 1
      OR error_code IS NOT NULL
      OR status >= 400 THEN 'error'
    ELSE 'completed'
  END,
  finalized_at = COALESCE(finished_at, started_at),
  cost_status = CASE
    WHEN cost_usd > 0 THEN 'ok'
    ELSE 'pending'
  END;

CREATE INDEX IF NOT EXISTS idx_request_logs_lifecycle_status
  ON request_logs(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_cost_status
  ON request_logs(cost_status);
CREATE INDEX IF NOT EXISTS idx_request_logs_subscription_code
  ON request_logs(subscription_code) WHERE subscription_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS cost_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_log_id INTEGER,
  model TEXT,
  provider TEXT,
  source TEXT,
  base_cost_usd REAL,
  calc_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_log_id) REFERENCES request_logs(id)
);

CREATE INDEX IF NOT EXISTS idx_cost_audit_request_log_id
  ON cost_audit(request_log_id);
