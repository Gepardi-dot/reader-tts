Offline dictionary assets live in `dictionary/offline/`.

Expected SQLite database path:

- `dictionary/offline/dictionary.sqlite3`

Expected schema:

```sql
create table if not exists entries (
  lookup_term text not null,
  term text not null,
  pronunciation text,
  part_of_speech text,
  definition text not null,
  examples_json text,
  register text,
  notes text,
  source text,
  priority integer not null default 0
);

create index if not exists idx_entries_lookup_term on entries (lookup_term);
```

Notes:

- `lookup_term` should be the normalized casefolded search term.
- `examples_json` should be a JSON array of strings.
- Do not commit extracted proprietary dictionary databases to git.

Samsung bridge:

- If `ADB_EXE` is configured or `adb` is installed, the API can query a connected Samsung phone's built-in dictionary app over ADB.
- Successful lookups are cached into `dictionary/offline/dictionary.sqlite3`, so repeated words become instant local lookups.
- `SAMSUNG_DICTIONARY_DEVICE_ID` is optional; set it only if you have multiple devices connected and want to pin one device.

Standalone fallback:

- If Samsung is not connected, the API falls back to Open English WordNet via NLTK.
- The WordNet corpus is downloaded once into `dictionary/open-wordnet/` and then works without the phone.
- WordNet results are also cached into `dictionary/offline/dictionary.sqlite3`.
