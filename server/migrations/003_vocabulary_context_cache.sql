create table if not exists card_context_cache (
    id text primary key,
    card_id text not null references cards(id) on delete cascade,
    user_id text not null,
    cache_key text not null,
    payload_json text not null,
    source text not null,
    created_at text not null,
    updated_at text not null
);

create unique index if not exists idx_card_context_cache_card_key
    on card_context_cache (card_id, cache_key);

create index if not exists idx_card_context_cache_card_updated_at
    on card_context_cache (card_id, updated_at desc);
