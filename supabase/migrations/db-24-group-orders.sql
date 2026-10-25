-- db-24-group-orders.sql
-- Карточки заказов в общей группе города: без адреса, с кнопкой «Взять заказ».
-- Взять могут только проверенные водители, остальным бот предлагает верификацию.
-- Idempotent: можно запускать повторно.

alter table settings add column if not exists group_orders_on boolean not null default false;

create table if not exists ride_feed_group (
  ride_id    uuid primary key references rides(id) on delete cascade,
  chat_id    bigint not null,
  message_id bigint not null,
  state      text not null default 'open',
  created_at timestamptz not null default now()
);

alter table ride_feed_group enable row level security;
revoke all on ride_feed_group from anon, authenticated;
