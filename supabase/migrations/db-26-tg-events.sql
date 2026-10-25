-- v163: журнал «кто вступил в группы и пришёл в бота»
-- можно запускать сколько угодно раз
create table if not exists public.tg_events (
  id bigserial primary key,
  kind text not null,              -- join | leave | start
  tg_id bigint,
  name text,
  username text,
  chat_id bigint,
  city text,
  chat_type text,                  -- city | drivers
  source text,                     -- метка, реклама, ссылка-приглашение
  is_new boolean,
  created_at timestamptz not null default now()
);
create index if not exists tg_events_created on public.tg_events (created_at);
create index if not exists tg_events_tg on public.tg_events (tg_id, kind);
alter table public.tg_events enable row level security;
revoke all on public.tg_events from anon, authenticated;
