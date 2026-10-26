-- db-32: защита от спама заявками — настройки пауз и «снять паузу» (backend v176, frontend v174)
-- Выполнять в проекте wygmuydnodwpbtsdfjuq. Можно запускать повторно — ничего не сломается.
-- Без этой миграции паузы всё равно работают (3/7/15 мин, 1/3/12 ч), но в панели их нельзя менять и снимать.
alter table public.settings add column if not exists guard_cfg jsonb;
alter table public.users add column if not exists cancel_reset_at timestamptz;
