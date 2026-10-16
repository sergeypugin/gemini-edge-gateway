ALTER TABLE logs ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_logs_request_id ON logs(request_id);
