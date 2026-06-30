CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_expires_idx
  ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  text_characters INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_format TEXT,
  source_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS books_user_uploaded_idx
  ON books(user_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS reader_progress (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  text_start INTEGER NOT NULL,
  text_end INTEGER NOT NULL,
  text_length INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(book_id, user_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  color TEXT NOT NULL DEFAULT 'amber',
  kind TEXT NOT NULL DEFAULT 'highlight',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS highlights_book_user_idx
  ON highlights(book_id, user_id, start_offset);

CREATE TABLE IF NOT EXISTS vocabulary_decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vocabulary_decks_user_idx
  ON vocabulary_decks(user_id, created_at);

CREATE TABLE IF NOT EXISTS vocabulary_notes (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES vocabulary_decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT,
  extra TEXT,
  hint TEXT,
  explanation TEXT,
  example_sentence TEXT,
  topic TEXT,
  source_book_id TEXT,
  source_book_title TEXT,
  mnemonic TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vocabulary_notes_deck_idx
  ON vocabulary_notes(deck_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS vocabulary_notes_unique_front_idx
  ON vocabulary_notes(deck_id, lower(front));

CREATE TABLE IF NOT EXISTS vocabulary_cards (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES vocabulary_notes(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES vocabulary_decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_type TEXT NOT NULL DEFAULT 'basic',
  state TEXT NOT NULL DEFAULT 'new',
  cue TEXT NOT NULL,
  answer TEXT NOT NULL,
  due_at TEXT NOT NULL,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vocabulary_cards_deck_due_idx
  ON vocabulary_cards(deck_id, user_id, due_at);
