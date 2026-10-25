-- db-28: ранги — настройки в панели, приглашения в группу (backend v165, frontend v163)
-- Выполнять в проекте wygmuydnodwpbtsdfjuq. Включает всё из db-27 — если её не запускали,
-- достаточно этой. Можно запускать повторно — ничего не сломается.

-- ===== из db-27: ранги и журнал баллов =====
alter table public.users add column if not exists points_total integer not null default 0;
alter table public.users add column if not exists rank_code text;
alter table public.users add column if not exists rank_paused boolean not null default false;
alter table public.users add column if not exists rank_paused_at timestamptz;
alter table public.rides add column if not exists cancel_reason text;
alter table public.rides add column if not exists arrived_at timestamptz;
alter table public.offers add column if not exists created_at timestamptz default now();

-- ===== новое: правила рангов, которые меняет владелец =====
alter table public.settings add column if not exists rank_cfg jsonb;

-- приглашения: личные ссылки водителей и кто по ним пришёл (закрыто — только сервер)
create table if not exists public.inv_links (
  code       text primary key,
  driver_id  text not null,
  chat_id    bigint not null,
  link       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists inv_links_drv on public.inv_links (driver_id, chat_id);

create table if not exists public.invitees (
  tg_id      bigint primary key,
  inviter_id text not null,
  chat_id    bigint,
  city       text,
  name       text,
  how        text,
  status     text not null default 'wait',
  joined_at  timestamptz not null default now(),
  checked_at timestamptz,
  join_pts   boolean not null default false,
  ride_pts   boolean not null default false
);
create index if not exists invitees_inv on public.invitees (inviter_id, joined_at);
create index if not exists invitees_wait on public.invitees (status, joined_at);

-- журнал баллов (последней — сервер включает ранги, когда видит эту таблицу)
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
create index if not exists points_reason on public.points (reason, created_at);

-- закрываем от публичного ключа
alter table public.points enable row level security;
alter table public.inv_links enable row level security;
alter table public.invitees enable row level security;
revoke all on public.points from anon, authenticated;
revoke all on public.inv_links from anon, authenticated;
revoke all on public.invitees from anon, authenticated;
revoke all on sequence public.points_id_seq from anon, authenticated;
