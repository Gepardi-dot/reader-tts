CREATE TABLE IF NOT EXISTS notion_connections (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  workspace_id TEXT,
  workspace_name TEXT,
  bot_id TEXT,
  parent_page_id TEXT,
  parent_kind TEXT NOT NULL DEFAULT 'page',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notion_book_pages (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS notion_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notion_synced_highlights (
  user_id TEXT NOT NULL,
  highlight_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  PRIMARY KEY (user_id, highlight_id)
);
