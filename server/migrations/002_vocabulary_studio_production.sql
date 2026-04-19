create table if not exists production_logs (
    id text primary key,
    card_id text not null references cards(id) on delete cascade,
    user_id text not null,
    created_at text not null,
    sentences_json text not null
);

create index if not exists idx_production_logs_card_created_at
    on production_logs (card_id, created_at desc);
