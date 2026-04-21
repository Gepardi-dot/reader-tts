create table if not exists books (
    id text primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null,
    file_name text not null,
    uploaded_at timestamptz not null default now(),
    page_count integer not null default 0,
    text_chars integer not null default 0,
    excerpt text not null default '',
    latest_audio jsonb,
    audio_history jsonb not null default '[]',
    source_storage jsonb,
    source_path text,
    source_sha256 text,
    source_format text,
    created_at timestamptz not null default now()
);

create index if not exists books_user_uploaded
    on books(user_id, uploaded_at desc);

create table if not exists highlights (
    id text not null,
    book_id text not null references books(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    start_pos integer not null,
    end_pos integer not null,
    color text not null default 'amber',
    kind text not null default 'highlight',
    text text not null,
    note text,
    created_at timestamptz not null default now(),
    primary key (book_id, id)
);

create index if not exists highlights_book
    on highlights(book_id);

create index if not exists highlights_user
    on highlights(user_id);

create table if not exists reader_progress (
    book_id text not null,
    user_id uuid references auth.users(id) on delete cascade,
    page_number integer not null,
    total_pages integer not null,
    text_start integer not null,
    text_end integer not null,
    text_length integer not null,
    updated_at timestamptz not null default now()
);

create table if not exists audio_progress (
    book_id text not null,
    user_id uuid references auth.users(id) on delete cascade,
    audio_url text not null,
    playback_time double precision not null,
    was_playing boolean not null,
    updated_at timestamptz not null default now()
);

alter table books add column if not exists source_path text;
alter table books add column if not exists source_sha256 text;
alter table books add column if not exists source_format text;
alter table reader_progress add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table audio_progress add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists books_user_source_sha256
    on books(user_id, source_sha256);

create table if not exists book_text_cache (
    book_id text not null references books(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    text_content text not null,
    content_sha256 text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (book_id, user_id)
);

create index if not exists book_text_cache_user_updated
    on book_text_cache(user_id, updated_at desc);

do $$
begin
    if exists (
        select 1
        from pg_constraint
        where conrelid = 'reader_progress'::regclass
          and conname = 'reader_progress_pkey'
    ) then
        alter table reader_progress drop constraint reader_progress_pkey;
    end if;
exception
    when undefined_table then null;
end
$$;

do $$
begin
    if exists (
        select 1
        from pg_constraint
        where conrelid = 'audio_progress'::regclass
          and conname = 'audio_progress_pkey'
    ) then
        alter table audio_progress drop constraint audio_progress_pkey;
    end if;
exception
    when undefined_table then null;
end
$$;

create unique index if not exists reader_progress_user_book_unique
    on reader_progress(book_id, user_id);

create unique index if not exists audio_progress_user_book_unique
    on audio_progress(book_id, user_id);

create table if not exists book_import_cache (
    user_id uuid not null references auth.users(id) on delete cascade,
    source_sha256 text not null,
    extraction_version integer not null,
    source_format text not null,
    cleaned_text text not null,
    page_count integer not null,
    text_chars integer not null,
    excerpt text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, source_sha256, extraction_version)
);

create index if not exists book_import_cache_user_updated
    on book_import_cache(user_id, updated_at desc);
