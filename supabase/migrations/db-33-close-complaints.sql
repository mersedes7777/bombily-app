-- db-33: жалобы и операции по балансу читает только сервер (backend v181, frontend v179)
-- Панель теперь получает их через сервер (complaints-list, complaints-count, payments-list),
-- поэтому публичному ключу приложения доступ больше не нужен.
-- Выполнять в проекте wygmuydnodwpbtsdfjuq ПОСЛЕ того, как Railway обновит сервер и приложение. Можно повторно.
drop policy if exists cp_sel on public.complaints;
drop policy if exists pm_sel on public.payments;
alter table public.complaints enable row level security;
alter table public.payments enable row level security;
revoke all on public.complaints from anon, authenticated;
revoke all on public.payments from anon, authenticated;
