-- db-23-no-ads.sql
-- Запрет рекламы, анкет и номеров телефонов в общем чате.
-- Работает и без этой колонки (по умолчанию включено) — миграция нужна,
-- чтобы правило можно было выключить тумблером в панели.
-- Idempotent: можно запускать повторно.

alter table settings add column if not exists group_no_ads boolean not null default true;
