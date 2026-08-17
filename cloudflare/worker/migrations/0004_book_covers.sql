-- Persist a cover pointer so the library does not re-query the internet.
-- Values: data URL, remote URL, "stored" (bytes in R2), or empty after a failed lookup.
ALTER TABLE books ADD COLUMN cover_url TEXT;
