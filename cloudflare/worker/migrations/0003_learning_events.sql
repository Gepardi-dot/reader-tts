-- XP + streak events for vocabulary practice
CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  xp_delta INTEGER NOT NULL DEFAULT 0,
  book_id TEXT,
  deck_id TEXT,
  card_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  detail TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS learning_events_user_created_idx
  ON learning_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS learning_events_user_type_created_idx
  ON learning_events (user_id, event_type, created_at DESC);
