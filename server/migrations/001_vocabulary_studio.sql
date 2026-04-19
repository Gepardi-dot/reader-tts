create table if not exists decks (
    id text primary key,
    user_id text not null,
    title text not null,
    description text,
    config_json text not null,
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_decks_user_updated_at
    on decks (user_id, updated_at desc);

create table if not exists notes (
    id text primary key,
    deck_id text not null references decks(id) on delete cascade,
    user_id text not null,
    note_type text not null,
    front text not null,
    back text,
    extra text,
    hint text,
    explanation text,
    example_sentence text,
    image_url text,
    audio_url text,
    tags_json text not null,
    topic text,
    source_ref text unique,
    metadata_json text not null,
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_notes_deck_updated_at
    on notes (deck_id, updated_at desc);

create table if not exists cards (
    id text primary key,
    deck_id text not null references decks(id) on delete cascade,
    note_id text not null references notes(id) on delete cascade,
    user_id text not null,
    card_type text not null,
    state text not null,
    due_at text not null,
    last_review_at text,
    stability real,
    difficulty real,
    elapsed_days integer not null default 0,
    scheduled_days integer not null default 0,
    reps integer not null default 0,
    lapses integer not null default 0,
    learning_step_index integer,
    is_suspended integer not null default 0,
    position integer not null default 0,
    cloze_index integer,
    cue text not null,
    answer text not null,
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_cards_deck_due
    on cards (deck_id, is_suspended, state, due_at);

create index if not exists idx_cards_note
    on cards (note_id, position);

create table if not exists review_logs (
    id text primary key,
    card_id text not null references cards(id) on delete cascade,
    user_id text not null,
    reviewed_at text not null,
    rating text not null,
    state_before text not null,
    state_after text not null,
    due_before text not null,
    due_after text not null,
    elapsed_days integer not null,
    scheduled_days_before integer not null,
    scheduled_days_after integer not null,
    response_ms integer,
    answer_mode text not null,
    was_auto_graded integer not null default 0,
    typed_response text,
    created_at text not null
);

create index if not exists idx_review_logs_card_reviewed_at
    on review_logs (card_id, reviewed_at desc);

create index if not exists idx_review_logs_reviewed_at
    on review_logs (reviewed_at desc);
