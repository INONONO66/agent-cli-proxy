-- Add agent attribution columns to request_logs
ALTER TABLE request_logs ADD COLUMN agent TEXT;
ALTER TABLE request_logs ADD COLUMN source TEXT DEFAULT 'proxy';
ALTER TABLE request_logs ADD COLUMN msg_id TEXT;

-- Unique index for dedup (only for non-null msg_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_logs_msg_id 
  ON request_logs(msg_id) WHERE msg_id IS NOT NULL;

-- Quota snapshots table
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  quota_type TEXT NOT NULL,
  used_pct REAL,
  remaining REAL,
  remaining_raw TEXT,
  resets_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_snapshots_provider 
  ON quota_snapshots(provider, account, timestamp);
