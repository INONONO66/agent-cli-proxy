CREATE INDEX IF NOT EXISTS idx_request_logs_provider_cliproxy_account_started_at
ON request_logs(provider, cliproxy_account, started_at);
