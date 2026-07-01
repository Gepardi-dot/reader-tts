CREATE TABLE IF NOT EXISTS performance_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT,
  event_name TEXT NOT NULL,
  provider TEXT,
  duration_ms INTEGER,
  value REAL,
  cache_hit INTEGER,
  cache_storage TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS performance_events_user_created_idx
  ON performance_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS performance_events_name_created_idx
  ON performance_events(event_name, created_at DESC);
