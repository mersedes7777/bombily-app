-- db-27: ранги и баллы водителей (backend v164, frontend v162)
-- Выполнять в проекте wygmuydnodwpbtsdfjuq. Можно запускать повторно — ничего не сломается.

-- 1) поля ранга у человека (видны всем, как рейтинг; менять может только сервер)
alter table public.users add column if not exists points_total integer not null default 0;
alter table public.users add column if not exists rank_code text;
alter table public.users add column if not exists rank_paused boolean not null default false;
alter table public.users add column if not exists rank_paused_at timestamptz;

-- 2) причина отмены и время «Я на месте» у заявки
alter table public.rides add column if not exists cancel_reason text;
alter table public.rides add column if not exists arrived_at timestamptz;

-- 3) когда водитель предложил цену (для «ответил быстрее минуты»)
alter table public.offers add column if not exists created_at timestamptz default now();

-- 4) журнал баллов: за что и сколько. Закрыт — читает и пишет только сервер.
create table if not exists public.points (
  id         bigserial primary key,
  driver_id  text not null,
  delta      integer not null default 0,
  reason     text not null,
  note       text,
  meta       text,
  ride_id    text,
  peer_id    text,
  uniq_key   text,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists points_uniq on public.points (driver_id, uniq_key) where uniq_key is not null;
create index if not exists points_drv on public.points (driver_id, created_at);
create index if not exists points_created on public.points (created_at);
create index if not exists points_peer on public.points (driver_id, peer_id, reason);

alter table public.points enable row level security;
revoke all on public.points from anon, authenticated;
revoke all on sequence public.points_id_seq from anon, authenticated;
