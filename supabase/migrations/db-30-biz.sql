-- db-30: доставка для точек — магазины, аптеки, кафе вызывают курьера (backend v169, frontend v166)
-- Выполнять в проекте wygmuydnodwpbtsdfjuq. Можно запускать повторно — ничего не сломается.

-- точки: работают только после проверки владельцем (status: pending → active / rejected / blocked)
create table if not exists public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text,
  city        text not null,
  address     text not null,
  phone       text,
  owner_id    uuid not null,
  status      text not null default 'pending',
  invite_code text,
  note        text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text
);
alter table public.businesses enable row level security;
revoke all on public.businesses from anon, authenticated;
create unique index if not exists businesses_invite on public.businesses (invite_code) where invite_code is not null;
create index if not exists businesses_owner on public.businesses (owner_id);
create index if not exists businesses_status on public.businesses (status, created_at);

-- кто может вызывать курьера от имени точки (хозяин и сотрудники)
create table if not exists public.biz_staff (
  biz_id   uuid not null,
  user_id  uuid not null,
  role     text not null default 'staff',
  added_at timestamptz not null default now(),
  primary key (biz_id, user_id)
);
alter table public.biz_staff enable row level security;
revoke all on public.biz_staff from anon, authenticated;
create index if not exists biz_staff_user on public.biz_staff (user_id);

-- получатель: телефон, имя, подъезд/квартира — видит только курьер, который взял заказ
create table if not exists public.biz_orders (
  ride_id         uuid primary key,
  biz_id          uuid not null,
  created_by      uuid,
  recipient_phone text,
  recipient_name  text,
  details         text,
  created_at      timestamptz not null default now()
);
alter table public.biz_orders enable row level security;
revoke all on public.biz_orders from anon, authenticated;
create index if not exists biz_orders_biz on public.biz_orders (biz_id, created_at);

-- в заявке — только то, что можно показать всем водителям: название точки и кто платит
alter table public.rides add column if not exists biz_id uuid;
alter table public.rides add column if not exists biz_name text;
alter table public.rides add column if not exists biz_payer text;
alter table public.rides add column if not exists picked_at timestamptz;
create index if not exists rides_biz on public.rides (biz_id, created_at) where biz_id is not null;
