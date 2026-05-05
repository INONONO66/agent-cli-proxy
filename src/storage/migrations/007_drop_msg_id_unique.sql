DROP INDEX IF EXISTS idx_request_logs_msg_id;

CREATE INDEX IF NOT EXISTS idx_request_logs_msg_id
  ON request_logs(msg_id) WHERE msg_id IS NOT NULL;
