create table if not exists learning_events (
    id text primary key,
    user_id text not null,
    event_type text not null,
    xp_delta integer not null default 0,
    book_id text,
    deck_id text,
    card_id text,
    label text not null,
    detail text,
    payload_json text not null default '{}',
    created_at text not null
);

create index if not exists idx_learning_events_user_created_at
    on learning_events (user_id, created_at desc);
