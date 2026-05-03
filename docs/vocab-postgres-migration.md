# Vocabulary studio → Supabase Postgres migration plan

**Status:** implemented 2026-05-03 (pending prod smoke verification).
**Owner:** —
**Why:** `server/vocabulary_studio.py` writes to a local SQLite file under `DATA_ROOT`. On Vercel that resolves to `/tmp/storybook-reader/library/vocabulary-studio.sqlite3` (`server/app.py:154-157`), which is per-lambda-instance ephemeral — saves on one invocation are invisible to the next. This is what makes the Vocabulary page render empty in production even though the save toast succeeds.

This is the same class of bug as the 2026-04-29 `_books_cache` regression. Vocabulary studio is the only remaining major data path on local disk; everything else (`reader_progress`, `audio_progress`, `books`, `highlights`) already uses Supabase Postgres via psycopg.

---

## Scope

In-scope tables (all currently in `server/migrations/*.sql`):

- `decks`
- `notes`
- `cards`
- `review_logs`
- `production_logs` (002)
- `card_context_cache` (003 — duplicated; consolidate)
- `practice_attempts` (003)
- `learning_events` (004)

Out-of-scope: schema migrations format, FSRS scheduler, FastAPI router contract, frontend code. The HTTP API, response shapes, and client query keys do not change.

## Existing data

Existing SQLite data is not portable from production — it has been wiped on every cold start anyway. **No data backfill needed.** Locally, the dev SQLite under `RUNTIME_ROOT/library/vocabulary-studio.sqlite3` is also disposable. If anyone has personally important local rows, they can dump them with `sqlite3 .dump` and re-create through the API — not worth automating.

## Plan

### 1. Postgres schema (one new SQL file)

Create `server/sql/vocabulary_studio_postgres.sql` (separate dir from `server/migrations/` to avoid the SQLite migrations runner picking it up). Use the `schema_migrations` table that `reader_progress` already uses (`server/app.py:1538-1652`) — append rows for each step keyed by name.

Translation rules from existing SQLite migrations:

| SQLite | Postgres | Notes |
|--------|----------|-------|
| `text primary key` (random id) | `text primary key` | keep app-generated ids — avoids changing `_make_id()` and avoids touching every insert |
| `text not null` for timestamps | `timestamptz not null` | parse on the way out; existing `_serialize_timestamp` becomes a no-op |
| `text not null` for `*_json` cols | `jsonb not null` | drops `json.dumps`/`json.loads` round-trips on read paths |
| `integer not null default 0` for booleans (`is_suspended`, `was_auto_graded`) | `boolean not null default false` | flip the few callsites |
| `real` (FSRS stability/difficulty) | `double precision` | direct |
| `user_id text not null` | `user_id uuid not null` | match `reader_progress` (`server/app.py:1597`) — psycopg accepts strings |
| Trailing `unique (card_id, cache_key)` in 003 dup | single `create unique index` | dedupe the two `003_*.sql` files — current setup creates `card_context_cache` twice with `if not exists`, second one becomes a no-op |
| no foreign-key cascade pruning needed | add `on delete cascade` (already present) | psycopg respects FKs by default |

Add user-scoping indexes that SQLite didn't need but Postgres benefits from:
- `idx_notes_user_deck_updated_at(user_id, deck_id, updated_at desc)`
- `idx_cards_user_deck_due(user_id, deck_id, is_suspended, state, due_at)`
- `idx_review_logs_user_card_reviewed_at(user_id, card_id, reviewed_at desc)`

**RLS:** server uses Postgres directly with the service role / pooler URL, not Supabase client-side. Match the existing pattern in `reader_progress` — no RLS, scope every query by `user_id` in WHERE clauses (already done in `vocabulary_studio.py`).

### 2. Storage abstraction in `vocabulary_studio.py`

The file is ~3,300 lines and SQL is woven throughout — a wholesale rewrite is risky. Instead, introduce a thin connection-and-dialect adapter at the top of the file and let everything else stay close to current shape.

Two changes:

**(a) Replace the `connection()` contextmanager** (currently `vocabulary_studio.py:689` returning a `sqlite3.Connection`). New contract returns a connection that:
- Uses `?` placeholders unchanged. Add a tiny `q()` helper that converts `?` → `%s` for psycopg, called once per `conn.execute(q(sql), args)`. (Don't use psycopg's `dict_row` row factory — match the `sqlite3.Row` shape the rest of the file expects via a `dict`-like row wrapper, OR just switch to `dict` and update the `_serialize_*` helpers — there are ~15 of them, all small.)
- Routes to psycopg when `SUPABASE_DB_URL` is set, sqlite3 otherwise. Local dev with no DB env stays on SQLite.

**(b) Translate JSON columns.** The codebase calls `json.dumps(...)` on inserts and `_json_load_dict` on reads. With `jsonb`, psycopg accepts dicts directly and returns dicts. Wrap with a `JsonField` shim:

```python
def _enc_json(value):  # called everywhere we currently do json.dumps
    return value if USING_POSTGRES else json.dumps(value)

def _dec_json(value):  # called everywhere we currently do _json_load_dict
    if value is None: return {}
    return value if isinstance(value, dict) else json.loads(value)
```

That's the smallest diff. ~20 callsites total.

### 3. Schema migrations runner

`vocabulary_studio.py:657-687` (`ensure_ready`) currently scans `server/migrations/*.sql` and applies them via `executescript`. Two options:

- **Option A (preferred):** keep `ensure_ready` for SQLite local dev, and add a parallel `ensure_postgres_ready()` that's invoked from `server/app.py` at module import — same place that calls `ensure_progress_store_ready()` for `reader_progress`. Apply the new `vocabulary_studio_postgres.sql` once via `schema_migrations`, behind a name like `vocabulary_studio_postgres_v1`.
- **Option B:** dual-write SQL files (one SQLite, one Postgres) and pick at runtime based on `SUPABASE_DB_URL`. More moving parts; not worth it.

Pick A.

### 4. Backend wiring

In `server/app.py`:

- After `ensure_progress_store_ready()` setup (around `app.py:1709`), call `vocabulary_service.ensure_ready()` (which now branches sqlite/postgres internally).
- No change to `app.include_router(create_vocabulary_router(vocabulary_service))`.

### 5. Tests

`server/tests/test_vocabulary_studio.py` currently runs against SQLite via `tmp_path`. Two tracks:

- Keep existing tests on SQLite — they still cover the dialect-agnostic logic.
- Add a new pytest fixture that requires `SUPABASE_TEST_DB_URL` (separate test DB) and re-runs a smaller smoke subset (deck create → note create → dashboard fetch → review log) against Postgres. CI skips it if the env var is unset; locally run when wanted.

### 6. Local dev mode

Don't force every dev to provision a Supabase test DB. Default behavior:

- `SUPABASE_DB_URL` set → Postgres path.
- Unset → SQLite path under `DATA_ROOT`. Keep this working until the migration is shipped + smoke-tested in prod for a week, then deprecate.

### 7. Rollout order

1. Land schema migration in Supabase `READER-TTS` project (apply via Supabase MCP, not committed app code yet). Verify tables exist with `mcp__claude_ai_Supabase__list_tables`.
2. Land code changes behind the `SUPABASE_DB_URL`-gated branch. Locally hit both paths.
3. Push to `master` + `main`. Vercel auto-deploys.
4. Smoke test in prod:
   - Save a word from the reader → reload `/vocabulary` → confirm it's there.
   - Force a cold start (wait or redeploy) → reload `/vocabulary` → still there.
   - Save a deck, save another word, run a practice session → review_logs row exists in Supabase Studio.
5. After 1 week of clean prod, delete the SQLite branch.

### 8. Risks

- **Lambda size budget** — psycopg is already in `requirements.txt` (used by `reader_progress`), so no new deps. Size-neutral.
- **Connection counts** — Vercel can spike concurrent invocations. Use the pooler URL (`SUPABASE_POOLER_URL`), already preferred in `app.py:335`. Confirm `vocabulary_service` opens a fresh connection per `connection()` call (not module-global) — it already does.
- **`source_ref` global uniqueness** — `notes.source_ref` is currently `text unique` globally. With multi-user, if two users save the same word, the second insert fails. Existing `create_note` prepends `user:{user_id}:` to make it user-unique (`vocabulary_studio.py:1791`), so the global UNIQUE is fine. Confirm that prefix is applied on every insert path before shipping.
- **Numeric types** — `stability`/`difficulty` are floats; psycopg returns `Decimal` for `numeric` but `float` for `double precision`. Use `double precision` to match SQLite's `real`.
- **Timezone** — SQLite stored ISO strings without offset awareness. `_parse_timestamp` should handle both raw strings (legacy) and `datetime` objects (psycopg `timestamptz`). Audit it before flipping the switch.

## Estimated effort

- Schema port: ~1 hr
- Connection adapter + JSON shim + dialect helper: ~2 hr
- Audit & fix the ~20 SQL sites for placeholder/JSON differences: ~3 hr
- Migration runner wiring: ~1 hr
- Smoke tests in Supabase: ~1 hr
- Prod verification: ~30 min

Total: ~one focused day, plus one week of soak before deleting the SQLite branch.
