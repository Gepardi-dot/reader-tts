create table if not exists card_context_cache (
    id text primary key,
    card_id text not null references cards(id) on delete cascade,
    user_id text not null,
    cache_key text not null,
    payload_json text not null,
    source text not null,
    created_at text not null,
    updated_at text not null,
    unique (card_id, cache_key)
);

create index if not exists idx_card_context_cache_card_updated_at
    on card_context_cache (card_id, updated_at desc);

create table if not exists practice_attempts (
    id text primary key,
    card_id text not null references cards(id) on delete cascade,
    user_id text not null,
    mode text not null,
    step text not null,
    turn_index integer not null default 0,
    provider text not null,
    learner_input_json text,
    ai_payload_json text not null,
    verdict text,
    suggested_rating text,
    created_at text not null
);

create index if not exists idx_practice_attempts_card_created_at
    on practice_attempts (card_id, created_at desc);

create index if not exists idx_practice_attempts_mode_step
    on practice_attempts (mode, step, created_at desc);
