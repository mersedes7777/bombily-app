# Пульс — Telegram Mini App

Рабочий скелет проекта по ТЗ: живая лента + заказ такси с откликами водителей,
встроенный чат, жалобы, авто-протухание заявок. Реализовано под стек
**Supabase + Railway + GitHub**.

## Структура

pulse-app/
  supabase/schema.sql     — таблицы и RLS-политики, выполнить в Supabase SQL Editor
  backend/                 — Node.js + Express (авторизация, бизнес-логика, cron, пуши)
  frontend/                — React + Vite (сам Mini App)

## Шаг 1 — Supabase

1. Создать проект на supabase.com
2. Открыть SQL Editor → вставить содержимое `supabase/schema.sql` → выполнить
3. В Project Settings → API скопировать `URL`, `anon key`, `service_role key`

## Шаг 2 — Бот в Telegram

1. В Telegram написать **@BotFather** → `/newbot` → получить `BOT_TOKEN`
2. Пока не привязывайте Mini App URL — сделаем это после деплоя фронта (шаг 4)

## Шаг 3 — Backend на Railway

1. Запушить папку `backend/` в отдельный репозиторий (или как сервис в монорепо)
2. В Railway: New Project → Deploy from GitHub → выбрать репозиторий
3. В Variables задать переменные из `backend/.env.example`
4. Railway задеплоит и выдаст публичный URL вида `https://xxx.up.railway.app`

## Шаг 4 — Frontend на Railway

1. Запушить `frontend/` отдельным сервисом
2. Переменные из `frontend/.env.example`
3. Build command: `npm run build`
4. Получить публичный HTTPS URL фронта

## Шаг 5 — Привязать Mini App к боту

1. В BotFather: `/mybots` → выбрать бота → **Bot Settings → Menu Button → Configure Menu Button**
2. Вставить URL фронта из шага 4
3. Обновить `MINI_APP_URL` у backend на `https://t.me/ваш_бот/app`

## Шаг 6 — Supabase Webhooks

1. В Supabase: Database → Webhooks → Create a new hook
2. Таблица `messages`, событие `INSERT`, URL: `https://ваш-backend.up.railway.app/notify/message`
