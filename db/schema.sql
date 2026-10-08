CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  model TEXT,
  key_id TEXT,
  status INTEGER,
  duration_ms INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);

CREATE TABLE IF NOT EXISTS keys_cache (
  key_id TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL DEFAULT 1,
  status_code INTEGER DEFAULT 200,
  checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matrix_state (
  model TEXT,
  key_id TEXT,
  status TEXT,
  updated_at INTEGER,
  PRIMARY KEY (model, key_id)
);

CREATE TRIGGER IF NOT EXISTS prune_old_logs_trigger
AFTER INSERT ON logs
WHEN (NEW.id % 100 = 0 AND NEW.id > 5000)
BEGIN
  DELETE FROM logs WHERE id <= (NEW.id - 5000);
END;
