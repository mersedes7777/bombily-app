-- Текущее устройство базы «Бомбилы» (Supabase wygmuydnodwpbtsdfjuq), выгружено 25.10.2026 запросом export-schema.sql.
-- Только устройство (таблицы, ограничения, индексы, функции, триггеры, политики, права), без данных.
-- Для нового проекта: SQL Editor → выполнить этот файл целиком.

-- устройство базы на 2026-10-25

create sequence if not exists public.call_log_id_seq;

create sequence if not exists public.call_sent_id_seq;

create sequence if not exists public.cities_id_seq;

create extension if not exists pg_stat_statements;

create extension if not exists pgcrypto;

create sequence if not exists public.points_id_seq;

create extension if not exists supabase_vault;

create sequence if not exists public.tg_events_id_seq;

create extension if not exists "uuid-ossp";

create table if not exists public.admin_msgs (
  id uuid not null default uuid_generate_v4(),
  to_user uuid,
  text text,
  sent boolean default false,
  created_at timestamp with time zone default now()
);

create table if not exists public.ask_wait (
  tg bigint not null,
  ride_id uuid not null,
  peer_tg bigint not null,
  role text not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.audit_log (
  id uuid not null default uuid_generate_v4(),
  actor_id uuid,
  actor_name text,
  actor_role text,
  action text,
  target_id uuid,
  target_name text,
  details text,
  created_at timestamp with time zone default now()
);

create table if not exists public.biz_orders (
  ride_id uuid not null,
  biz_id uuid not null,
  created_by uuid,
  recipient_phone text,
  recipient_name text,
  details text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.biz_staff (
  biz_id uuid not null,
  user_id uuid not null,
  role text not null default 'staff'::text,
  added_at timestamp with time zone not null default now()
);

create table if not exists public.bot_replies (
  message_id bigint not null,
  staff_tg bigint,
  target_tg bigint,
  support_id uuid,
  created_at timestamp with time zone default now()
);

create table if not exists public.broadcasts (
  id uuid not null default uuid_generate_v4(),
  text text,
  audience text,
  city text,
  btn_text text,
  btn_url text,
  total integer default 0,
  sent integer default 0,
  failed integer default 0,
  blocked integer default 0,
  status text default 'queued'::text,
  created_by uuid,
  created_by_name text,
  created_at timestamp with time zone default now(),
  finished_at timestamp with time zone
);

create table if not exists public.businesses (
  id uuid not null default gen_random_uuid(),
  name text not null,
  kind text,
  city text not null,
  address text not null,
  phone text,
  owner_id uuid not null,
  status text not null default 'pending'::text,
  invite_code text,
  note text,
  created_at timestamp with time zone not null default now(),
  decided_at timestamp with time zone,
  decided_by text
);

create table if not exists public.call_log (
  id bigint not null default nextval('call_log_id_seq'::regclass),
  city text not null,
  created_at timestamp with time zone not null default now(),
  waiting integer not null default 0,
  free integer not null default 0,
  sent integer not null default 0,
  ride_ids text,
  closed_at timestamp with time zone,
  outcome text
);

create table if not exists public.call_sent (
  id bigint not null default nextval('call_sent_id_seq'::regclass),
  call_id bigint not null,
  user_id text not null,
  tg_id bigint,
  msg_id bigint,
  sent_at timestamp with time zone not null default now(),
  online_at timestamp with time zone,
  ride_id text,
  bonus boolean not null default false
);

create table if not exists public.cars (
  id uuid not null default uuid_generate_v4(),
  user_id uuid,
  brand text,
  plate text,
  photo text,
  approved boolean default false,
  is_active boolean default false,
  created_at timestamp with time zone default now(),
  kind text default 'car'::text,
  doc_pts text,
  doc_license text,
  docs_checked_at timestamp with time zone,
  docs_checked_by text,
  docs_wipe_at timestamp with time zone
);

create table if not exists public.chat_draft (
  id uuid not null default gen_random_uuid(),
  tg bigint not null,
  city text,
  from_address text,
  to_address text,
  raw_text text,
  stage text not null default 'confirm'::text,
  created_at timestamp with time zone not null default now(),
  price integer,
  kind text,
  to_city text,
  scheduled_at timestamp with time zone,
  comment text
);

create table if not exists public.cities (
  id integer not null default nextval('cities_id_seq'::regclass),
  name text not null,
  slug text,
  group_link text,
  group_id bigint,
  description text,
  image text,
  active boolean default true,
  sort integer default 100,
  created_at timestamp with time zone default now(),
  driver_group_id bigint
);

create table if not exists public.complaints (
  id uuid not null default uuid_generate_v4(),
  ride_id uuid,
  from_id uuid,
  from_name text,
  target_id uuid,
  target_name text,
  reason text not null,
  comment text,
  status text not null default 'pending'::text,
  created_at timestamp with time zone default now(),
  review_id uuid,
  kind text default 'user'::text
);

create table if not exists public.contacts (
  user_id uuid not null,
  phone text,
  updated_at timestamp with time zone default now(),
  full_name text,
  places text,
  photo_url text,
  photo_path text
);

create table if not exists public.driver_posts (
  driver_id uuid not null,
  city text not null,
  chat_id bigint not null,
  message_id bigint,
  last_post_at timestamp with time zone,
  last_status text,
  created_at timestamp with time zone default now()
);

create table if not exists public.feed_live (
  id uuid not null default uuid_generate_v4(),
  kind text not null,
  text_raw text not null,
  source_chat text,
  created_at timestamp with time zone default now()
);

create table if not exists public.group_pins (
  city_name text not null,
  chat_id bigint,
  message_id bigint,
  last_text text,
  updated_at timestamp with time zone default now(),
  renewed_at timestamp with time zone default now()
);

create table if not exists public.inv_links (
  code text not null,
  driver_id text not null,
  chat_id bigint not null,
  link text not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.invitees (
  tg_id bigint not null,
  inviter_id text not null,
  chat_id bigint,
  city text,
  name text,
  how text,
  status text not null default 'wait'::text,
  joined_at timestamp with time zone not null default now(),
  checked_at timestamp with time zone,
  join_pts boolean not null default false,
  ride_pts boolean not null default false
);

create table if not exists public.messages (
  id uuid not null default uuid_generate_v4(),
  ride_id uuid not null,
  sender_id uuid not null,
  text text not null,
  created_at timestamp with time zone default now(),
  sender_name text
);

create table if not exists public.offers (
  id uuid not null default uuid_generate_v4(),
  ride_id uuid not null,
  driver_id uuid not null,
  price numeric not null,
  eta_minutes integer not null,
  status text not null default 'pending'::text,
  created_at timestamp with time zone default now(),
  driver_name text,
  car text,
  notified boolean default false,
  notify_msg_id bigint,
  notify_chat bigint
);

create table if not exists public.payments (
  id uuid not null default uuid_generate_v4(),
  user_id uuid,
  user_name text,
  amount numeric not null,
  kind text not null,
  days integer,
  note text,
  status text default 'done'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.pending_refs (
  tg_id bigint not null,
  ref_code text,
  created_at timestamp with time zone default now()
);

create table if not exists public.pending_src (
  tg bigint not null,
  code text,
  created_at timestamp with time zone default now()
);

create table if not exists public.points (
  id bigint not null default nextval('points_id_seq'::regclass),
  driver_id text not null,
  delta integer not null default 0,
  reason text not null,
  note text,
  meta text,
  ride_id text,
  peer_id text,
  uniq_key text,
  created_by text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.promos (
  id uuid not null default uuid_generate_v4(),
  code text,
  days integer default 0,
  amount numeric default 0,
  for_user uuid,
  used_by uuid,
  used boolean default false,
  created_at timestamp with time zone default now(),
  expires_at timestamp with time zone,
  created_by uuid,
  created_by_name text
);

create table if not exists public.reports (
  id uuid not null default uuid_generate_v4(),
  ride_id uuid,
  reporter_id uuid not null,
  target_id uuid not null,
  reason text not null,
  status text not null default 'pending'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.reviews (
  id uuid not null default uuid_generate_v4(),
  ride_id uuid,
  from_id uuid,
  from_name text,
  target_id uuid,
  target_name text,
  rating integer not null,
  comment text,
  created_at timestamp with time zone default now(),
  visible boolean default false,
  kind text default 'driver'::text,
  seen_by_target boolean default false,
  notified boolean default false
);

create table if not exists public.ride_ask (
  id uuid not null default gen_random_uuid(),
  ride_id uuid not null,
  from_id uuid,
  to_id uuid,
  from_role text not null,
  text text not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.ride_feed (
  ride_id uuid not null,
  chat_id bigint not null,
  message_id bigint not null,
  state text default 'open'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.ride_feed_group (
  ride_id uuid not null,
  chat_id bigint not null,
  message_id bigint not null,
  state text not null default 'open'::text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.ride_notify (
  id uuid not null default gen_random_uuid(),
  ride_id uuid not null,
  driver_id uuid not null,
  sent_at timestamp with time zone not null default now(),
  delivered boolean not null default true,
  responded boolean not null default false,
  responded_at timestamp with time zone
);

create table if not exists public.rides (
  id uuid not null default uuid_generate_v4(),
  passenger_id uuid not null,
  driver_id uuid,
  from_address text not null,
  to_address text not null,
  comment text,
  status text not null default 'created'::text,
  created_at timestamp with time zone default now(),
  confirmed_at timestamp with time zone,
  driver_departed_at timestamp with time zone,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone default (now() + '00:15:00'::interval),
  passenger_confirmed boolean default false,
  driver_confirmed boolean default false,
  passenger_rating integer,
  hold_amount numeric default 0,
  hold_status text default 'none'::text,
  passenger_name text,
  target_driver_id uuid,
  price numeric,
  notified boolean default false,
  driver_notified boolean default false,
  arrived boolean default false,
  arrived_notified boolean default false,
  city text,
  passenger_price numeric,
  kind text default 'ride'::text,
  cancel_notified boolean default false,
  cancelled_by text,
  to_city text,
  review_nudged boolean default false,
  scheduled_at timestamp with time zone,
  remind_sent boolean default false,
  nodriver_sent boolean default false,
  early_sent boolean default false,
  auto_closed boolean not null default false,
  source text,
  cancel_reason text,
  arrived_at timestamp with time zone,
  biz_id uuid,
  biz_name text,
  biz_payer text,
  picked_at timestamp with time zone
);

create table if not exists public.settings (
  id integer not null default 1,
  paid_mode boolean default false,
  price_1 numeric default 150,
  price_3 numeric default 400,
  price_7 numeric default 800,
  price_30 numeric default 3000,
  ref_enabled boolean default false,
  ref_bonus numeric default 100,
  idle_hours integer default 5,
  community_enabled boolean default false,
  group_moderate boolean default false,
  group_clean_service boolean default true,
  group_welcome boolean default false,
  pin_enabled boolean default false,
  pin_minutes integer default 5,
  require_sub boolean default false,
  pin_renew_hours integer default 24,
  group_del_sec integer default 90,
  group_welcome_sec integer default 120,
  docs_keep_days integer default 3,
  dpost_minutes integer default 30,
  driver_feed_enabled boolean default true,
  winback_users_on boolean not null default true,
  winback_first_days integer not null default 14,
  winback_next_days integer not null default 30,
  antispam_on boolean not null default true,
  antispam_ban boolean not null default true,
  antispam_links boolean not null default true,
  group_order_mode text not null default 'delete'::text,
  group_orders_on boolean not null default false,
  report_daily_on boolean not null default true,
  report_weekly_on boolean not null default true,
  report_daily_last text,
  report_weekly_last text,
  rank_cfg jsonb,
  call_cfg jsonb
);

create table if not exists public.shifts (
  id uuid not null default uuid_generate_v4(),
  driver_id uuid,
  started_at timestamp with time zone default now(),
  ended_at timestamp with time zone,
  minutes integer,
  notified boolean default false,
  planned_end timestamp with time zone,
  auto_closed boolean default false
);

create table if not exists public.sources (
  code text not null,
  title text,
  note text,
  created_at timestamp with time zone default now()
);

create table if not exists public.spam_log (
  id uuid not null default gen_random_uuid(),
  chat_id bigint,
  city text,
  tg_id bigint,
  user_name text,
  text text,
  score integer,
  reasons text,
  action text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.staff_reply (
  staff_tg bigint not null,
  target_tg bigint,
  support_id uuid,
  created_at timestamp with time zone default now()
);

create table if not exists public.support_msgs (
  id uuid not null default uuid_generate_v4(),
  from_tg bigint,
  from_name text,
  from_user uuid,
  text text,
  answered boolean default false,
  created_at timestamp with time zone default now(),
  from_username text,
  photo text,
  answered_by uuid,
  answered_by_name text
);

create table if not exists public.support_wait (
  tg bigint not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.tg_events (
  id bigint not null default nextval('tg_events_id_seq'::regclass),
  kind text not null,
  tg_id bigint,
  name text,
  username text,
  chat_id bigint,
  city text,
  chat_type text,
  source text,
  is_new boolean,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.users (
  id uuid not null default uuid_generate_v4(),
  telegram_id bigint not null,
  name text not null,
  role text not null default 'passenger'::text,
  phone text,
  rating numeric not null default 5.0,
  completed_rides integer not null default 0,
  cancel_count integer not null default 0,
  warnings_count integer not null default 0,
  is_banned boolean not null default false,
  status text not null default 'offline'::text,
  last_active timestamp with time zone default now(),
  created_at timestamp with time zone default now(),
  staff_role text,
  driver_status text default 'none'::text,
  car text,
  plate text,
  age integer,
  spot text,
  places text,
  favs text,
  doc_license text,
  doc_pts text,
  doc_car text,
  cancel_as_passenger integer default 0,
  cancel_as_driver integer default 0,
  idle_warned boolean default false,
  onboarded boolean default false,
  city text,
  balance numeric default 0,
  sub_until timestamp with time zone,
  remove_logo boolean default false,
  tg_username text,
  ref_code text,
  ref_by uuid,
  ref_paid boolean default false,
  ever_paid boolean default false,
  winback_sent timestamp with time zone,
  has_phone boolean default false,
  full_name text,
  delivery boolean default false,
  intercity boolean default false,
  admin_note text,
  vehicle_type text default 'car'::text,
  community_seen text,
  no_broadcast boolean default false,
  avatar text,
  source text,
  remind_before integer default 120,
  theme text,
  docs_checked_at timestamp with time zone,
  docs_checked_by text,
  docs_wipe_at timestamp with time zone,
  perms text[] default '{}'::text[],
  show_in_group boolean default false,
  winback_count integer not null default 0,
  points_total integer not null default 0,
  rank_code text,
  rank_paused boolean not null default false,
  rank_paused_at timestamp with time zone,
  call_on boolean not null default true,
  call_night boolean not null default false,
  call_at timestamp with time zone
);

create table if not exists public.winback_queue (
  id uuid not null default uuid_generate_v4(),
  user_id uuid,
  user_name text,
  last_active timestamp with time zone,
  status text default 'pending'::text,
  created_at timestamp with time zone default now()
);

alter table admin_msgs add constraint admin_msgs_pkey PRIMARY KEY (id);

alter table ask_wait add constraint ask_wait_pkey PRIMARY KEY (tg);

alter table audit_log add constraint audit_log_pkey PRIMARY KEY (id);

alter table biz_orders add constraint biz_orders_pkey PRIMARY KEY (ride_id);

alter table biz_staff add constraint biz_staff_pkey PRIMARY KEY (biz_id, user_id);

alter table bot_replies add constraint bot_replies_pkey PRIMARY KEY (message_id);

alter table broadcasts add constraint broadcasts_pkey PRIMARY KEY (id);

alter table businesses add constraint businesses_pkey PRIMARY KEY (id);

alter table call_log add constraint call_log_pkey PRIMARY KEY (id);

alter table call_sent add constraint call_sent_pkey PRIMARY KEY (id);

alter table cars add constraint cars_pkey PRIMARY KEY (id);

alter table chat_draft add constraint chat_draft_pkey PRIMARY KEY (id);

alter table cities add constraint cities_name_key UNIQUE (name);

alter table cities add constraint cities_pkey PRIMARY KEY (id);

alter table complaints add constraint complaints_pkey PRIMARY KEY (id);

alter table contacts add constraint contacts_pkey PRIMARY KEY (user_id);

alter table driver_posts add constraint driver_posts_pkey PRIMARY KEY (driver_id);

alter table feed_live add constraint feed_live_kind_check CHECK ((kind = ANY (ARRAY['free'::text, 'need'::text])));

alter table feed_live add constraint feed_live_pkey PRIMARY KEY (id);

alter table group_pins add constraint group_pins_pkey PRIMARY KEY (city_name);

alter table inv_links add constraint inv_links_pkey PRIMARY KEY (code);

alter table invitees add constraint invitees_pkey PRIMARY KEY (tg_id);

alter table messages add constraint messages_pkey PRIMARY KEY (id);

alter table offers add constraint offers_pkey PRIMARY KEY (id);

alter table offers add constraint offers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'selected'::text, 'declined'::text])));

alter table payments add constraint payments_pkey PRIMARY KEY (id);

alter table pending_refs add constraint pending_refs_pkey PRIMARY KEY (tg_id);

alter table pending_src add constraint pending_src_pkey PRIMARY KEY (tg);

alter table points add constraint points_pkey PRIMARY KEY (id);

alter table promos add constraint promos_code_key UNIQUE (code);

alter table promos add constraint promos_pkey PRIMARY KEY (id);

alter table reports add constraint reports_pkey PRIMARY KEY (id);

alter table reports add constraint reports_reason_check CHECK ((reason = ANY (ARRAY['price_after_agreement'::text, 'no_show'::text, 'rudeness'::text, 'payment_outside_app'::text])));

alter table reports add constraint reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'dismissed'::text])));

alter table reviews add constraint reviews_pkey PRIMARY KEY (id);

alter table ride_ask add constraint ride_ask_pkey PRIMARY KEY (id);

alter table ride_feed add constraint ride_feed_pkey PRIMARY KEY (ride_id);

alter table ride_feed_group add constraint ride_feed_group_pkey PRIMARY KEY (ride_id);

alter table ride_notify add constraint ride_notify_pkey PRIMARY KEY (id);

alter table rides add constraint rides_hold_status_check CHECK ((hold_status = ANY (ARRAY['none'::text, 'held'::text, 'released_to_platform'::text, 'released_to_driver'::text])));

alter table rides add constraint rides_pkey PRIMARY KEY (id);

alter table rides add constraint rides_status_check CHECK ((status = ANY (ARRAY['created'::text, 'confirmed'::text, 'in_progress'::text, 'completed'::text, 'cancelled_by_passenger_free'::text, 'cancelled_by_passenger_charged'::text, 'cancelled_by_driver'::text, 'auto_cancelled_no_contact'::text, 'expired'::text])));

alter table settings add constraint settings_pkey PRIMARY KEY (id);

alter table shifts add constraint shifts_pkey PRIMARY KEY (id);

alter table sources add constraint sources_pkey PRIMARY KEY (code);

alter table spam_log add constraint spam_log_pkey PRIMARY KEY (id);

alter table staff_reply add constraint staff_reply_pkey PRIMARY KEY (staff_tg);

alter table support_msgs add constraint support_msgs_pkey PRIMARY KEY (id);

alter table support_wait add constraint support_wait_pkey PRIMARY KEY (tg);

alter table tg_events add constraint tg_events_pkey PRIMARY KEY (id);

alter table users add constraint users_pkey PRIMARY KEY (id);

alter table users add constraint users_role_check CHECK ((role = ANY (ARRAY['passenger'::text, 'driver'::text, 'both'::text])));

alter table users add constraint users_staff_role_chk CHECK (((staff_role IS NULL) OR (staff_role = ANY (ARRAY['owner'::text, 'admin'::text, 'moderator'::text, 'none'::text]))));

alter table users add constraint users_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text])));

alter table users add constraint users_telegram_id_key UNIQUE (telegram_id);

alter table users add constraint users_theme_chk CHECK (((theme IS NULL) OR (theme = ANY (ARRAY['green'::text, 'orange'::text, 'light'::text, 'mono'::text, 'blue'::text]))));

alter table winback_queue add constraint winback_queue_pkey PRIMARY KEY (id);

alter table driver_posts add constraint driver_posts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE;

alter table messages add constraint messages_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table messages add constraint messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);

alter table offers add constraint offers_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id);

alter table offers add constraint offers_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table reports add constraint reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES users(id);

alter table reports add constraint reports_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id);

alter table reports add constraint reports_target_id_fkey FOREIGN KEY (target_id) REFERENCES users(id);

alter table ride_ask add constraint ride_ask_from_id_fkey FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE SET NULL;

alter table ride_ask add constraint ride_ask_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table ride_ask add constraint ride_ask_to_id_fkey FOREIGN KEY (to_id) REFERENCES users(id) ON DELETE SET NULL;

alter table ride_feed add constraint ride_feed_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table ride_feed_group add constraint ride_feed_group_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table ride_notify add constraint ride_notify_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE;

alter table ride_notify add constraint ride_notify_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE;

alter table rides add constraint rides_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id);

alter table rides add constraint rides_passenger_id_fkey FOREIGN KEY (passenger_id) REFERENCES users(id);

CREATE INDEX audit_log_created_idx ON public.audit_log USING btree (created_at DESC);

CREATE INDEX biz_orders_biz ON public.biz_orders USING btree (biz_id, created_at);

CREATE INDEX biz_staff_user ON public.biz_staff USING btree (user_id);

CREATE INDEX businesses_owner ON public.businesses USING btree (owner_id);

CREATE INDEX businesses_status ON public.businesses USING btree (status, created_at);

CREATE UNIQUE INDEX businesses_invite ON public.businesses USING btree (invite_code) WHERE (invite_code IS NOT NULL);

CREATE INDEX call_log_city ON public.call_log USING btree (city, created_at);

CREATE INDEX call_log_open ON public.call_log USING btree (closed_at) WHERE (closed_at IS NULL);

CREATE INDEX call_sent_call ON public.call_sent USING btree (call_id);

CREATE INDEX call_sent_user ON public.call_sent USING btree (user_id, sent_at);

CREATE INDEX chat_draft_time ON public.chat_draft USING btree (created_at DESC);

CREATE UNIQUE INDEX chat_draft_tg ON public.chat_draft USING btree (tg);

CREATE UNIQUE INDEX inv_links_drv ON public.inv_links USING btree (driver_id, chat_id);

CREATE INDEX invitees_inv ON public.invitees USING btree (inviter_id, joined_at);

CREATE INDEX invitees_wait ON public.invitees USING btree (status, joined_at);

CREATE INDEX idx_messages_ride ON public.messages USING btree (ride_id);

CREATE INDEX idx_offers_ride ON public.offers USING btree (ride_id);

CREATE INDEX points_created ON public.points USING btree (created_at);

CREATE INDEX points_drv ON public.points USING btree (driver_id, created_at);

CREATE INDEX points_peer ON public.points USING btree (driver_id, peer_id, reason);

CREATE INDEX points_reason ON public.points USING btree (reason, created_at);

CREATE UNIQUE INDEX points_uniq ON public.points USING btree (driver_id, uniq_key) WHERE (uniq_key IS NOT NULL);

CREATE INDEX ride_ask_from ON public.ride_ask USING btree (from_id, created_at DESC);

CREATE INDEX ride_ask_ride ON public.ride_ask USING btree (ride_id, created_at);

CREATE INDEX ride_notify_driver ON public.ride_notify USING btree (driver_id, sent_at DESC);

CREATE INDEX ride_notify_ride ON public.ride_notify USING btree (ride_id);

CREATE UNIQUE INDEX ride_notify_uniq ON public.ride_notify USING btree (ride_id, driver_id);

CREATE INDEX idx_rides_driver ON public.rides USING btree (driver_id);

CREATE INDEX idx_rides_passenger ON public.rides USING btree (passenger_id);

CREATE INDEX idx_rides_status ON public.rides USING btree (status);

CREATE INDEX rides_biz ON public.rides USING btree (biz_id, created_at) WHERE (biz_id IS NOT NULL);

CREATE INDEX rides_open_confirmed ON public.rides USING btree (status, confirmed_at) WHERE (status = ANY (ARRAY['confirmed'::text, 'in_progress'::text]));

CREATE INDEX rides_sched_idx ON public.rides USING btree (scheduled_at) WHERE (scheduled_at IS NOT NULL);

CREATE INDEX spam_log_time ON public.spam_log USING btree (created_at DESC);

CREATE INDEX tg_events_created ON public.tg_events USING btree (created_at);

CREATE INDEX tg_events_tg ON public.tg_events USING btree (tg_id, kind);

CREATE INDEX idx_users_telegram ON public.users USING btree (telegram_id);

CREATE INDEX users_last_active ON public.users USING btree (last_active);

CREATE INDEX users_source_idx ON public.users USING btree (source);

CREATE OR REPLACE FUNCTION public.guard_privileged_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or current_setting('role', true) = 'service_role' then
    return new;
  end if;

  new.staff_role    := old.staff_role;
  new.balance       := old.balance;
  new.sub_until     := old.sub_until;
  new.driver_status := old.driver_status;
  new.is_banned     := old.is_banned;
  new.rating        := old.rating;
  new.ever_paid     := old.ever_paid;
  new.ref_paid      := old.ref_paid;
  new.ref_by        := old.ref_by;
  new.role          := old.role;
  new.telegram_id   := old.telegram_id;
  new.phone         := old.phone;
  new.has_phone     := old.has_phone;
  new.full_name     := old.full_name;
  new.places        := old.places;
  new.car           := old.car;
  new.plate         := old.plate;
  new.admin_note    := old.admin_note;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_user_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_service_call() then
    return old;
  end if;
  raise exception 'delete_forbidden';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_user_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- backend имеет право создавать кого угодно
  if public.is_service_call() then
    return new;
  end if;

  -- всё, что пришло снаружи, приводим к безопасному виду
  new.staff_role    := null;
  new.role          := 'passenger';
  new.driver_status := null;
  new.balance       := 0;
  new.sub_until     := null;
  new.is_banned     := false;
  new.rating        := 5;
  new.phone         := null;
  new.has_phone     := false;
  new.full_name     := null;
  new.places        := null;
  new.car           := null;
  new.plate         := null;
  new.admin_note    := null;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_user_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claim_role text;
begin
  claim_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), ''),
    ''
  );

  -- backend и прямое подключение к базе — доверяем
  if claim_role in ('service_role', '') then
    return new;
  end if;

  -- снаружи: строки персонала не трогаем
  if old.staff_role is not null then
    raise exception 'protected_row';
  end if;
  if new.staff_role is not null then
    raise exception 'protected_field';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_service_call()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), ''),
    ''
  ) in ('service_role', '');
$function$
;

CREATE TRIGGER guard_user_delete_trg BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION guard_user_delete();

CREATE TRIGGER guard_user_insert_trg BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION guard_user_insert();

CREATE TRIGGER guard_user_update_trg BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION guard_user_update();

CREATE TRIGGER trg_guard_privileged BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION guard_privileged_fields();

alter table public.admin_msgs enable row level security;

alter table public.ask_wait enable row level security;

alter table public.audit_log enable row level security;

alter table public.biz_orders enable row level security;

alter table public.biz_staff enable row level security;

alter table public.bot_replies enable row level security;

alter table public.broadcasts enable row level security;

alter table public.businesses enable row level security;

alter table public.call_log enable row level security;

alter table public.call_sent enable row level security;

alter table public.cars enable row level security;

alter table public.chat_draft enable row level security;

alter table public.cities enable row level security;

alter table public.complaints enable row level security;

alter table public.contacts enable row level security;

alter table public.driver_posts enable row level security;

alter table public.feed_live enable row level security;

alter table public.group_pins enable row level security;

alter table public.inv_links enable row level security;

alter table public.invitees enable row level security;

alter table public.messages enable row level security;

alter table public.offers enable row level security;

alter table public.payments enable row level security;

alter table public.pending_refs enable row level security;

alter table public.pending_src enable row level security;

alter table public.points enable row level security;

alter table public.promos enable row level security;

alter table public.reports enable row level security;

alter table public.reviews enable row level security;

alter table public.ride_ask enable row level security;

alter table public.ride_feed enable row level security;

alter table public.ride_feed_group enable row level security;

alter table public.ride_notify enable row level security;

alter table public.rides enable row level security;

alter table public.settings enable row level security;

alter table public.shifts enable row level security;

alter table public.sources enable row level security;

alter table public.spam_log enable row level security;

alter table public.staff_reply enable row level security;

alter table public.support_msgs enable row level security;

alter table public.support_wait enable row level security;

alter table public.tg_events enable row level security;

alter table public.users enable row level security;

alter table public.winback_queue enable row level security;

create policy cities_sel on public.cities as PERMISSIVE for SELECT to public using (true);

create policy cp_sel on public.complaints as PERMISSIVE for SELECT to public using (true);

create policy feed_live_select_all on public.feed_live as PERMISSIVE for SELECT to public using (true);

create policy messages_select_all on public.messages as PERMISSIVE for SELECT to public using (true);

create policy ms_sel on public.messages as PERMISSIVE for SELECT to public using (true);

create policy offers_select_all on public.offers as PERMISSIVE for SELECT to public using (true);

create policy pm_sel on public.payments as PERMISSIVE for SELECT to public using (true);

create policy prf_sel on public.pending_refs as PERMISSIVE for SELECT to public using (true);

create policy rv_sel on public.reviews as PERMISSIVE for SELECT to public using (true);

create policy rides_select_own_or_open on public.rides as PERMISSIVE for SELECT to public using (true);

create policy st_sel on public.settings as PERMISSIVE for SELECT to public using (true);

create policy sh_sel on public.shifts as PERMISSIVE for SELECT to public using (true);

create policy users_select_all on public.users as PERMISSIVE for SELECT to public using (true);

revoke all on public.admin_msgs from anon, authenticated;

revoke all on public.ask_wait from anon, authenticated;

revoke all on public.audit_log from anon, authenticated;

revoke all on public.biz_orders from anon, authenticated;

revoke all on public.biz_staff from anon, authenticated;

revoke all on public.bot_replies from anon, authenticated;

revoke all on public.broadcasts from anon, authenticated;

revoke all on public.businesses from anon, authenticated;

revoke all on public.call_log from anon, authenticated;

revoke all on public.call_sent from anon, authenticated;

revoke all on public.cars from anon, authenticated;

revoke all on public.chat_draft from anon, authenticated;

revoke all on public.cities from anon, authenticated;

revoke all on public.complaints from anon, authenticated;

revoke all on public.contacts from anon, authenticated;

revoke all on public.driver_posts from anon, authenticated;

revoke all on public.feed_live from anon, authenticated;

revoke all on public.group_pins from anon, authenticated;

revoke all on public.inv_links from anon, authenticated;

revoke all on public.invitees from anon, authenticated;

revoke all on public.messages from anon, authenticated;

revoke all on public.offers from anon, authenticated;

revoke all on public.payments from anon, authenticated;

revoke all on public.pending_refs from anon, authenticated;

revoke all on public.pending_src from anon, authenticated;

revoke all on public.points from anon, authenticated;

revoke all on public.promos from anon, authenticated;

revoke all on public.reports from anon, authenticated;

revoke all on public.reviews from anon, authenticated;

revoke all on public.ride_ask from anon, authenticated;

revoke all on public.ride_feed from anon, authenticated;

revoke all on public.ride_feed_group from anon, authenticated;

revoke all on public.ride_notify from anon, authenticated;

revoke all on public.rides from anon, authenticated;

revoke all on public.settings from anon, authenticated;

revoke all on public.shifts from anon, authenticated;

revoke all on public.sources from anon, authenticated;

revoke all on public.spam_log from anon, authenticated;

revoke all on public.staff_reply from anon, authenticated;

revoke all on public.support_msgs from anon, authenticated;

revoke all on public.support_wait from anon, authenticated;

revoke all on public.tg_events from anon, authenticated;

revoke all on public.users from anon, authenticated;

revoke all on public.winback_queue from anon, authenticated;

grant SELECT on public.admin_msgs to anon;

grant SELECT on public.admin_msgs to authenticated;

grant SELECT on public.audit_log to anon;

grant SELECT on public.audit_log to authenticated;

grant SELECT on public.bot_replies to anon;

grant SELECT on public.bot_replies to authenticated;

grant SELECT on public.broadcasts to anon;

grant SELECT on public.broadcasts to authenticated;

grant SELECT on public.cars to anon;

grant SELECT on public.cars to authenticated;

grant SELECT on public.cities to anon;

grant SELECT on public.cities to authenticated;

grant SELECT on public.complaints to anon;

grant SELECT on public.complaints to authenticated;

grant SELECT on public.contacts to anon;

grant SELECT on public.contacts to authenticated;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.driver_posts to anon;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.driver_posts to authenticated;

grant SELECT on public.feed_live to anon;

grant SELECT on public.feed_live to authenticated;

grant SELECT on public.group_pins to anon;

grant SELECT on public.group_pins to authenticated;

grant SELECT on public.messages to anon;

grant SELECT on public.messages to authenticated;

grant SELECT on public.offers to anon;

grant SELECT on public.offers to authenticated;

grant SELECT on public.payments to anon;

grant SELECT on public.payments to authenticated;

grant SELECT on public.pending_refs to anon;

grant SELECT on public.pending_refs to authenticated;

grant SELECT on public.pending_src to anon;

grant SELECT on public.pending_src to authenticated;

grant SELECT on public.promos to anon;

grant SELECT on public.promos to authenticated;

grant SELECT on public.reports to anon;

grant SELECT on public.reports to authenticated;

grant SELECT on public.reviews to anon;

grant SELECT on public.reviews to authenticated;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.ride_feed to anon;

grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.ride_feed to authenticated;

grant SELECT on public.rides to anon;

grant SELECT on public.rides to authenticated;

grant SELECT on public.settings to anon;

grant SELECT on public.settings to authenticated;

grant SELECT on public.shifts to anon;

grant SELECT on public.shifts to authenticated;

grant SELECT on public.sources to anon;

grant SELECT on public.sources to authenticated;

grant SELECT on public.staff_reply to anon;

grant SELECT on public.staff_reply to authenticated;

grant SELECT on public.support_msgs to anon;

grant SELECT on public.support_msgs to authenticated;

grant SELECT on public.support_wait to anon;

grant SELECT on public.support_wait to authenticated;

grant SELECT on public.users to anon;

grant SELECT on public.users to authenticated;

grant SELECT on public.winback_queue to anon;

grant SELECT on public.winback_queue to authenticated;
