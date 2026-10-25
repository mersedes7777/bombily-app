-- db-31: закрыть переписку водителя и пассажира от публичного ключа
-- Найдено 25.10.2026 по выгрузке устройства базы: у таблицы messages остались старые
-- правила «читать всем» (messages_select_all, ms_sel) — любой с ключом из приложения мог
-- прочитать чаты. Приложение читает чат только через сервер (/api/chat-list), поэтому
-- закрытие ничего не ломает. Выполнять в проекте wygmuydnodwpbtsdfjuq. Можно повторно.
drop policy if exists messages_select_all on public.messages;
drop policy if exists ms_sel on public.messages;
alter table public.messages enable row level security;
revoke all on public.messages from anon, authenticated;
