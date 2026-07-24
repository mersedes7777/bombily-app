import http from 'http';
import { createClient } from '@supabase/supabase-js';

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.MINI_APP_URL;
const OWNER   = Number(process.env.OWNER_ID || 8672930773);
const PORT    = process.env.PORT || 3000;

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = m => `https://api.telegram.org/bot${TOKEN}/${m}`;

async function tg(method, body) {
  try {
    const r = await fetch(API(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { console.error('tg', method, e.message); return null; }
}
const send = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

/* ---------- кнопки ---------- */
const wa = (text, s) => ({ text, web_app: { url: `${APP_URL}?s=${s}` } });
const mainKb = {
  inline_keyboard: [
    [wa('🚕 Заказать поездку', 'order')],
    [wa('🚗 Стать водителем', 'driver')],
    [wa('👤 Личный кабинет', 'profile')],
    [{ text: '💬 Связь с админом', callback_data: 'support' }]
  ]
};

async function setupBot() {
  await tg('setMyCommands', { commands: [
    { command: 'start',   description: 'Главное меню' },
    { command: 'order',   description: 'Заказать поездку' },
    { command: 'driver',  description: 'Стать водителем' },
    { command: 'profile', description: 'Личный кабинет' },
    { command: 'support', description: 'Связь с админом' }
  ]});
  if (APP_URL && APP_URL.startsWith('https'))
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } } });
  console.log('bot commands set');
}

/* ---------- поддержка ---------- */
const waitingSupport = new Set();   // кто сейчас пишет админу
const fwdMap = new Map();           // message_id у админа -> telegram_id пользователя

async function onUpdate(u) {
  if (u.callback_query) {
    const cq = u.callback_query, chat = cq.from.id;
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data === 'support') {
      waitingSupport.add(chat);
      await send(chat, 'Напишите ваше сообщение одним текстом — оно уйдёт администратору. Ответ придёт сюда же.');
    }
    return;
  }

  const m = u.message;
  if (!m || !m.text) return;
  const chat = m.chat.id, text = m.text.trim();

  // ответ админа на пересланное сообщение
  if (chat === OWNER && m.reply_to_message && fwdMap.has(m.reply_to_message.message_id)) {
    const to = fwdMap.get(m.reply_to_message.message_id);
    await send(to, `<b>Ответ администратора:</b>\n${text}`);
    await send(OWNER, '✅ Отправлено');
    return;
  }

  if (text.startsWith('/start')) {
    waitingSupport.delete(chat);
    return send(chat, `<b>Бомбилы</b>\nСервис для поиска машины в городе.\n\nВыберите, что нужно:`, { reply_markup: mainKb });
  }
  if (text.startsWith('/order') || text.startsWith('/driver') || text.startsWith('/profile')) {
    const s = text.slice(1).split(/[\s@]/)[0];
    return send(chat, 'Открываю приложение:', { reply_markup: { inline_keyboard: [[wa('Открыть', s)]] } });
  }
  if (text.startsWith('/support')) {
    waitingSupport.add(chat);
    return send(chat, 'Напишите ваше сообщение одним текстом — оно уйдёт администратору.');
  }

  // текст в режиме поддержки
  if (waitingSupport.has(chat)) {
    waitingSupport.delete(chat);
    const who = `${m.from.first_name || ''} ${m.from.username ? '@' + m.from.username : ''} (ID ${chat})`;
    const r = await send(OWNER, `📨 <b>Сообщение в поддержку</b>\nОт: ${who}\n\n${text}\n\n<i>Ответьте на это сообщение — ответ уйдёт человеку.</i>`);
    if (r?.result?.message_id) fwdMap.set(r.result.message_id, chat);
    return send(chat, '✅ Сообщение отправлено администратору. Ответ придёт сюда.');
  }

  return send(chat, 'Не понял команду. Нажмите /start', { reply_markup: mainKb });
}

/* ---------- long polling ---------- */
let offset = 0;
async function poll() {
  try {
    const r = await fetch(API('getUpdates') + `?timeout=30&offset=${offset}`);
    const j = await r.json();
    if (j.ok) for (const u of j.result) { offset = u.update_id + 1; await onUpdate(u); }
  } catch (e) { /* сеть моргнула — продолжаем */ }
  setTimeout(poll, 300);
}

/* ---------- уведомления ---------- */
const tgIdOf = async id => (await db.from('users').select('telegram_id').eq('id', id).maybeSingle()).data?.telegram_id;

async function notifyLoop() {
  try {
    // новая заявка -> водителям
    const { data: rides } = await db.from('rides').select('*').eq('status', 'created').eq('notified', false);
    for (const r of rides || []) {
      let q = db.from('users').select('telegram_id').eq('status', 'online').in('role', ['driver', 'both']);
      if (r.target_driver_id) q = db.from('users').select('telegram_id').eq('id', r.target_driver_id);
      const { data: drv } = await q;
      const head = r.target_driver_id ? '🎯 <b>Заявка лично вам</b>' : '🚕 <b>Новая заявка</b>';
      for (const d of drv || [])
        if (d.telegram_id) await send(d.telegram_id, `${head}\n${r.from_address} → ${r.to_address}\nОт: ${r.passenger_name || 'пассажир'}`,
          { reply_markup: { inline_keyboard: [[wa('Открыть заявку', 'driver')]] } });
      await db.from('rides').update({ notified: true }).eq('id', r.id);
    }

    // отклик -> пассажиру
    const { data: offs } = await db.from('offers').select('*').eq('notified', false).eq('status', 'pending');
    for (const o of offs || []) {
      const { data: ride } = await db.from('rides').select('passenger_id,to_address').eq('id', o.ride_id).maybeSingle();
      if (ride) {
        const tid = await tgIdOf(ride.passenger_id);
        if (tid) await send(tid, `💰 <b>${o.driver_name || 'Водитель'} назвал цену: ${o.price} ₽</b>\nМаршрут: ${ride.to_address}`,
          { reply_markup: { inline_keyboard: [[wa('Посмотреть', 'order')]] } });
      }
      await db.from('offers').update({ notified: true }).eq('id', o.id);
    }

    // выбрали -> водителю
    const { data: conf } = await db.from('rides').select('*').eq('status', 'confirmed').eq('driver_notified', false);
    for (const r of conf || []) {
      if (r.driver_id) {
        const tid = await tgIdOf(r.driver_id);
        if (tid) await send(tid, `✅ <b>Вас выбрали!</b>\n${r.from_address} → ${r.to_address}\nПассажир: ${r.passenger_name || '—'}`,
          { reply_markup: { inline_keyboard: [[wa('Открыть заказ', 'driver')]] } });
      }
      await db.from('rides').update({ driver_notified: true }).eq('id', r.id);
    }
  } catch (e) { console.error('notify', e.message); }
  setTimeout(notifyLoop, 4000);
}

/* ---------- истечение заявок (10 минут) ---------- */
async function expireLoop() {
  try {
    const cut = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: old } = await db.from('rides').select('*').eq('status', 'created').lt('created_at', cut);
    for (const r of old || []) {
      await db.from('rides').update({ status: 'expired' }).eq('id', r.id);
      const tid = await tgIdOf(r.passenger_id);
      if (tid) await send(tid, `⌛️ <b>Заявка устарела</b>\n${r.from_address} → ${r.to_address}\nНикто не откликнулся за 10 минут. Если поездка ещё нужна — создайте новую.`,
        { reply_markup: { inline_keyboard: [[wa('Создать новую', 'order')]] } });
    }
  } catch (e) { console.error('expire', e.message); }
  setTimeout(expireLoop, 60000);
}

/* ---------- health ---------- */
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'bombily-backend' }));
}).listen(PORT, () => console.log('listening on ' + PORT));

setupBot();
poll();
notifyLoop();
expireLoop();
