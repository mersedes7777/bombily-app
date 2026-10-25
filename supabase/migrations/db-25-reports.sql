-- v162: сводки в Telegram (утренняя владельцу и итоги недели водителям)
-- можно запускать сколько угодно раз
alter table public.settings add column if not exists report_daily_on boolean not null default true;
alter table public.settings add column if not exists report_weekly_on boolean not null default true;
alter table public.settings add column if not exists report_daily_last text;
alter table public.settings add column if not exists report_weekly_last text;
