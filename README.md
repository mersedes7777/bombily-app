# Пульс — Telegram Mini App

Рабочий скелет проекта по ТЗ: живая лента + заказ такси с откликами водителей,
встроенный чат, жалобы, авто-протухание заявок. Реализовано под стек
**Supabase + Railway + GitHub**.

## Структура

```
pulse-app/
  supabase/schema.sql     — таблицы и RLS-политики, выполнить в Supabase SQL Editor
  backend/                 — Node.js + Express (авторизация, бизнес-логика, cron, пуши)
  frontend/                — React + Vite (сам Mini App)
```

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
3. В Variables задать переменные из `backend/.env.example`:
   - `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `MINI_APP_URL` (заполнить после шага 4)
4. Railway задеплоит и выдаст публичный URL вида `https://xxx.up.railway.app`

## Шаг 4 — Frontend на Railway

1. Запушить `frontend/` отдельным сервисом
2. Переменные из `frontend/.env.example`:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_BACKEND_URL` (URL из шага 3)
3. Build command: `npm run build`, старт — раздача папки `dist` (Railway обычно определяет Vite-проект автоматически; если нет — добавить `serve` как старт-команду)
4. Получить публичный HTTPS URL фронта

## Шаг 5 — Привязать Mini App к боту

1. В BotFather: `/mybots` → выбрать бота → **Bot Settings → Menu Button → Configure Menu Button**
2. Вставить URL фронта из шага 4
3. Вернуться в Railway backend и обновить `MINI_APP_URL` на `https://t.me/ваш_бот/app`

## Шаг 6 — Supabase Webhooks (пуши на новые сообщения)

1. В Supabase: Database → Webhooks → Create a new hook
2. Таблица `messages`, событие `INSERT`, URL: `https://ваш-backend.up.railway.app/notify/message`
3. (По желанию) аналогично для других событий — расширить `backend/src/routes/notify.js`

## Локальная разработка

```bash
# backend
cd backend
npm install
cp .env.example .env   # заполнить значения
npm run dev

# frontend
cd frontend
npm install
cp .env.example .env
npm run dev
```

Frontend вне Telegram (просто в браузере) не получит `initData` — авторизация
не пройдёт, но вёрстку и переключение вкладок можно проверять и так.
Для полноценного теста открывайте через кнопку меню в самом Telegram
(на телефоне или в Telegram Desktop).

## Что уже реализовано по ТЗ

- Авторизация через проверку `initData` (backend/src/lib/telegramAuth.js)
- Таблицы и связи `users / rides / offers / messages / reports` (supabase/schema.sql)
- Стейт-машина заказа: created → confirmed → in_progress → completed / отмены
- Двойное подтверждение завершения заказа + рейтинг
- Правила отмены: бесплатно первые 2 минуты, иначе холд не возвращается
- Cron-протухание: заявки 15 мин, авто-отмена 7 мин без контакта, оффлайн через 30 мин
- Встроенный чат на Supabase Realtime + жалобы с 4 причинами
- Push-уведомления через Bot API с диплинками на конкретный заказ
- Экраны: Лента, Заказать (форма → ожидание → подтверждено → чат), Поездки, Профиль

## Что осталось доделать перед реальным запуском

- Реальное наполнение `feed_live` (агрегация внешних чатов) — сейчас таблица пустая, наполняется вручную/через отдельный парсер, который в ТЗ помечен опциональным на старте
- Сузить RLS-политики под auth.uid(), когда появится Supabase custom JWT (сейчас чтение открыто всем — упрощение для MVP)
- Экран истории поездок (Trips) — сейчас заглушка
- Холд 30₽ — поля в схеме уже есть, но реальное списание/возврат денег требует
  подключения платёжного провайдера (например, Telegram Payments) — в коде
  только фиксируются статусы holdа, реальных транзакций нет
- Соревновательный режим/медальки — не реализовано, отложено на этап 3 по ТЗ
