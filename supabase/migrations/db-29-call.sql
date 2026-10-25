-- db-29: «Зов на линию» — бот зовёт водителей, когда заявки ждут (backend v168, frontend v165)
-- Выполнять в проекте wygmuydnodwpbtsdfjuq. Можно запускать повторно — ничего не сломается.

-- водитель сам решает, звать ли его (по умолчанию — да, ночью — нет); когда звали последний раз
alter table public.users add column if not exists call_on boolean not null default true;
alter table public.users add column if not exists call_night boolean not null default false;
alter table public.users add column if not exists call_at timestamptz;

-- правила, которые меняет владелец в панели
alter table public.settings add column if not exists call_cfg jsonb;

-- каждый «зов»: город, сколько заявок ждало, скольким написали, чем кончилось
create table if not exists public.call_log (
  id         bigserial primary key,
  city       text not null,
  created_at timestamptz not null default now(),
  waiting    integer not null default 0,
  free       integer not null default 0,
  sent       integer not null default 0,
  ride_ids   text,
  closed_at  timestamptz,
  outcome    text
);
create index if not exists call_log_city on public.call_log (city, created_at);
create index if not exists call_log_open on public.call_log (closed_at) where closed_at is null;

-- кому написали, вышел ли на линию, какой заказ потом довёз
create table if not exists public.call_sent (
  id        bigserial primary key,
  call_id   bigint not null,
  user_id   text not null,
  tg_id     bigint,
  msg_id    bigint,
  sent_at   timestamptz not null default now(),
  online_at timestamptz,
  ride_id   text,
  bonus     boolean not null default false
);
create index if not exists call_sent_call on public.call_sent (call_id);
create index if not exists call_sent_user on public.call_sent (user_id, sent_at);

-- закрываем от публичного ключа: читает и пишет только сервер
alter table public.call_log enable row level security;
alter table public.call_sent enable row level security;
revoke all on public.call_log from anon, authenticated;
revoke all on public.call_sent from anon, authenticated;
revoke all on sequence public.call_log_id_seq from anon, authenticated;
revoke all on sequence public.call_sent_id_seq from anon, authenticated;
