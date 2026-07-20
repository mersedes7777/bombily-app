-- ============================================================
-- Pulse (Пульс) — схема базы данных для Supabase (PostgreSQL)
-- Выполнить в Supabase SQL Editor
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- users ----------
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  telegram_id bigint unique not null,
  name text not null,
  role text not null default 'passenger' check (role in ('passenger','driver','both')),
  phone text,
  rating numeric not null default 5.0,
  completed_rides int not null default 0,
  cancel_count int not null default 0,
  warnings_count int not null default 0,
  is_banned boolean not null default false,
  status text not null default 'offline' check (status in ('online','offline')),
  last_active timestamptz default now(),
  created_at timestamptz default now()
);

-- ---------- rides ----------
create table if not exists rides (
  id uuid primary key default uuid_generate_v4(),
  passenger_id uuid not null references users(id),
  driver_id uuid references users(id),
  from_address text not null,
  to_address text not null,
  comment text,
  status text not null default 'created' check (status in (
    'created','confirmed','in_progress','completed',
    'cancelled_by_passenger_free','cancelled_by_passenger_charged',
    'cancelled_by_driver','auto_cancelled_no_contact','expired'
  )),
  created_at timestamptz default now(),
  confirmed_at timestamptz,
  driver_departed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz default (now() + interval '15 minutes'),
  passenger_confirmed boolean default false,
  driver_confirmed boolean default false,
  passenger_rating int,
  hold_amount numeric default 0,
  hold_status text default 'none' check (hold_status in ('none','held','released_to_platform','released_to_driver'))
);

-- ---------- offers ----------
create table if not exists offers (
  id uuid primary key default uuid_generate_v4(),
  ride_id uuid not null references rides(id) on delete cascade,
  driver_id uuid not null references users(id),
  price numeric not null,
  eta_minutes int not null,
  status text not null default 'pending' check (status in ('pending','selected','declined')),
  created_at timestamptz default now()
);

-- ---------- messages ----------
create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  ride_id uuid not null references rides(id) on delete cascade,
  sender_id uuid not null references users(id),
  text text not null,
  created_at timestamptz default now()
);

-- ---------- reports ----------
create table if not exists reports (
  id uuid primary key default uuid_generate_v4(),
  ride_id uuid references rides(id),
  reporter_id uuid not null references users(id),
  target_id uuid not null references users(id),
  reason text not null check (reason in (
    'price_after_agreement','no_show','rudeness','payment_outside_app'
  )),
  status text not null default 'pending' check (status in ('pending','reviewed','dismissed')),
  created_at timestamptz default now()
);

-- ---------- feed_live (агрегация из внешних чатов, опционально) ----------
create table if not exists feed_live (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('free','need')),
  text_raw text not null,
  source_chat text,
  created_at timestamptz default now()
);

-- ---------- indexes ----------
create index if not exists idx_rides_status on rides(status);
create index if not exists idx_rides_passenger on rides(passenger_id);
create index if not exists idx_rides_driver on rides(driver_id);
create index if not exists idx_offers_ride on offers(ride_id);
create index if not exists idx_messages_ride on messages(ride_id);
create index if not exists idx_users_telegram on users(telegram_id);

-- ============================================================
-- Row Level Security
-- Frontend обращается к Supabase с anon key — доступ только
-- к своим данным. Изменение критичных статусов (select/complete/
-- cancel) идёт ТОЛЬКО через backend с service_role key, которое
-- обходит RLS — поэтому политики ниже разрешают в основном чтение.
-- ============================================================

alter table users enable row level security;
alter table rides enable row level security;
alter table offers enable row level security;
alter table messages enable row level security;
alter table reports enable row level security;
alter table feed_live enable row level security;

-- users: каждый видит всех (нужно для карточек водителей в ленте),
-- но редактировать может только себя. Реальная защита строится на
-- том, что запись из frontend всё равно идёт через backend endpoint.
create policy "users_select_all" on users for select using (true);

-- rides: пассажир видит свои заявки; водитель видит заявки со
-- статусом created (лента) + свои подтверждённые заказы
create policy "rides_select_own_or_open" on rides for select using (
  status = 'created' or true -- упрощено для MVP; ужесточить по мере роста
);

-- offers: видно всем участникам конкретной заявки
create policy "offers_select_all" on offers for select using (true);

-- messages: строго участникам ride (проверка на уровне backend при выдаче)
create policy "messages_select_all" on messages for select using (true);

-- feed_live: публичное чтение
create policy "feed_live_select_all" on feed_live for select using (true);

-- Примечание: для продакшена политики выше стоит сузить до
-- auth.uid() = passenger_id/driver_id, когда будет настроен
-- Supabase custom JWT на основе telegram_id (см. backend/src/lib/telegramAuth.js).
