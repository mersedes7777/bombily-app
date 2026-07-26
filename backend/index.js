import http from 'http';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.MINI_APP_URL;
const OWNER   = Number(process.env.OWNER_ID || process.env.OWNER || 8672930773);
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
// вшиваем telegram id и имя пользователя в ссылку — чтобы апка всегда точно знала, кто открыл
function appUrl(s, u) {
  const uid = u ? u.id : '';
  const nm = u && u.first_name ? encodeURIComponent(u.first_name) : '';
  return `${APP_URL}?s=${s}&uid=${uid}&nm=${nm}`;
}
const wa = (text, s, u) => ({ text, web_app: { url: appUrl(s, u) } });
function mainKbFor(u) {
  return {
    inline_keyboard: [
      [wa('🚕 Заказать поездку', 'order', u)],
      [wa('🚗 Стать водителем', 'driver', u)],
      [wa('👤 Личный кабинет', 'profile', u)],
      [{ text: '💬 Связь с админом', callback_data: 'support' }]
    ]
  };
}
function kbFor(u) {
  return {
    keyboard: [
      [{ text: '🚕 Заказать поездку', web_app: { url: appUrl('order', u) } }],
      [{ text: '🚗 Стать водителем', web_app: { url: appUrl('driver', u) } },
       { text: '👤 Кабинет', web_app: { url: appUrl('profile', u) } }],
      [{ text: '💬 Связь с админом' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

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
  // сохраняем username телеграма для связи из админки
  if (m.from && m.from.username) {
    db.from('users').update({ tg_username: m.from.username }).eq('telegram_id', chat).then(()=>{}, ()=>{});
  }

  // ответ админа на пересланное сообщение
  if (chat === OWNER && m.reply_to_message && fwdMap.has(m.reply_to_message.message_id)) {
    const to = fwdMap.get(m.reply_to_message.message_id);
    await send(to, `<b>Ответ администратора:</b>\n${text}`);
    await send(OWNER, '✅ Отправлено');
    return;
  }

  if (text.startsWith('/start')) {
    waitingSupport.delete(chat);
    // реферальная ссылка: /start ref_CODE
    const parts = text.split(/\s+/);
    const param = parts[1] || '';
    if (param.startsWith('ref_')) {
      const code = param.slice(4).toUpperCase();
      try {
        const { data: inviter } = await db.from('users').select('id,name').eq('ref_code', code).maybeSingle();
        const { data: meRow } = await db.from('users').select('id,ref_by').eq('telegram_id', chat).maybeSingle();
        if (inviter) {
          if (meRow && inviter.id !== meRow.id && !meRow.ref_by) {
            await db.from('users').update({ ref_by: inviter.id }).eq('id', meRow.id);
            await send(chat, `👋 Вас пригласил <b>${inviter.name}</b>. Добро пожаловать в Бомбилы!`);
          } else if (!meRow) {
            // ещё не зарегистрирован — запомним код, апка подхватит
            await db.from('pending_refs').upsert({ tg_id: chat, ref_code: code });
            await send(chat, `👋 Вас пригласил <b>${inviter.name}</b>. Откройте приложение, чтобы начать.`);
          }
        }
      } catch (e) {}
    }
    await send(chat, `<b>Бомбилы</b>\nСервис для поиска машины в городе.\nКнопки внизу всегда под рукой — писать команды не нужно.`, { reply_markup: kbFor(m.from) });
    return send(chat, 'Что нужно сделать?', { reply_markup: mainKbFor(m.from) });
  }
  if (text.startsWith('/order') || text.startsWith('/driver') || text.startsWith('/profile')) {
    const s = text.slice(1).split(/[\s@]/)[0];
    return send(chat, 'Открываю приложение:', { reply_markup: { inline_keyboard: [[wa('Открыть', s, m.from)]] } });
  }
  if (text === '💬 Связь с админом' || text.startsWith('/support')) {
    waitingSupport.add(chat);
    return send(chat, 'Напишите ваше сообщение одним текстом — оно уйдёт администратору.');
  }

  // текст в режиме поддержки
  if (waitingSupport.has(chat)) {
    waitingSupport.delete(chat);
    const who = `${m.from.first_name || ''} ${m.from.username ? '@' + m.from.username : ''} (ID ${chat})`;
    // сохраним в базу для списка в панели
    try {
      const { data: uRow } = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle();
      await db.from('support_msgs').insert({ from_tg: chat, from_name: (m.from.first_name || 'Гость'), from_user: uRow ? uRow.id : null, text });
    } catch (e) {}
    const r = await send(OWNER, `📨 <b>Сообщение в поддержку</b>\nОт: ${who}\n\n${text}\n\n<i>Ответьте на это сообщение — ответ уйдёт человеку. Либо ответьте из панели.</i>`);
    if (r?.result?.message_id) fwdMap.set(r.result.message_id, chat);
    return send(chat, '✅ Сообщение отправлено администратору. Ответ придёт сюда.');
  }

  await send(chat, 'Выберите действие кнопками ниже 👇', { reply_markup: kbFor(m.from) });
  return send(chat, 'Или откройте приложение:', { reply_markup: mainKbFor(m.from) });
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

    // сообщения чата -> второй стороне
    const { data: msgs } = await db.from('messages').select('*').eq('notified', false);
    for (const msg of msgs || []) {
      const { data: ride } = await db.from('rides').select('passenger_id,driver_id').eq('id', msg.ride_id).maybeSingle();
      if (ride) {
        const other = msg.sender_id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
        if (other) {
          const tid = await tgIdOf(other);
          if (tid) await send(tid, `💬 <b>${msg.sender_name || 'Сообщение'}</b>\n${msg.text}`,
            { reply_markup: { inline_keyboard: [[wa('Ответить', 'order')]] } });
        }
      }
      await db.from('messages').update({ notified: true }).eq('id', msg.id);
    }

    // поездка завершена -> обоим
    const { data: fin } = await db.from('rides').select('*').eq('status', 'completed').eq('done_notified', false);
    for (const r of fin || []) {
      const txt = `🏁 <b>Поездка завершена</b>\n${r.from_address} → ${r.to_address}${r.price ? `\nСумма: ${r.price} ₽` : ''}`;
      for (const uid of [r.passenger_id, r.driver_id]) {
        if (!uid) continue;
        const tid = await tgIdOf(uid);
        if (tid) await send(tid, txt);
      }
      await db.from('rides').update({ done_notified: true }).eq('id', r.id);
    }

    // смена закончилась -> итог водителю
    const { data: sh } = await db.from('shifts').select('*').eq('notified', false).not('ended_at', 'is', null);
    for (const s of sh || []) {
      const tid = await tgIdOf(s.driver_id);
      if (tid) {
        const h = Math.floor((s.minutes || 0) / 60), mm = (s.minutes || 0) % 60;
        const { data: rr } = await db.from('rides')
          .select('price')
          .eq('driver_id', s.driver_id).eq('status', 'completed')
          .gte('created_at', s.started_at).lte('created_at', s.ended_at);
        const done = (rr || []).length;
        const earned = (rr || []).reduce((a, x) => a + (Number(x.price) || 0), 0);
        const perHour = s.minutes > 0 ? Math.round(earned / (s.minutes / 60)) : 0;
        await send(tid, `🏁 <b>Смена окончена</b>\nНа линии: <b>${h} ч ${mm} мин</b>\nПоездок: <b>${done}</b>\nЗаработано: <b>${earned} ₽</b>${done ? `\nВ среднем: ${Math.round(earned / done)} ₽ за поездку · ${perHour} ₽ в час` : ''}\n\nОтдыхайте, возвращайтесь когда будет удобно.`);
      }
      await db.from('shifts').update({ notified: true }).eq('id', s.id);
    }

    // водитель приехал -> пассажиру
    const { data: arr } = await db.from('rides').select('*').eq('arrived', true).eq('arrived_notified', false);
    for (const r of arr || []) {
      const tid = await tgIdOf(r.passenger_id);
      if (tid) await send(tid, `🚗 <b>Водитель на месте</b>\n${r.from_address}\nМашина ждёт вас.`);
      await db.from('rides').update({ arrived_notified: true }).eq('id', r.id);
    }

    // отзывы становятся видимыми, когда обе стороны оценили
    const { data: hidden } = await db.from('reviews').select('*').eq('visible', false);
    for (const rv of hidden || []) {
      const { data: pair } = await db.from('reviews').select('id').eq('ride_id', rv.ride_id).neq('id', rv.id).limit(1);
      const old = Date.now() - new Date(rv.created_at).getTime() > 24 * 3600 * 1000;
      if ((pair && pair.length) || old) {
        await db.from('reviews').update({ visible: true }).eq('ride_id', rv.ride_id);
      }
    }

    // новые отзывы -> уведомить того, о ком отзыв (только когда отзыв стал видимым)
    const { data: nrev } = await db.from('reviews').select('*').eq('visible', true).eq('notified', false);
    for (const rv of nrev || []) {
      const tid = await tgIdOf(rv.target_id);
      if (tid) {
        const stars = '⭐'.repeat(rv.rating);
        await send(tid, `📝 <b>Новый отзыв о вас</b>\n${stars}${rv.comment ? '\n«' + rv.comment + '»' : ''}\n\nОткройте приложение, вкладка «Отзывы».`);
      }
      await db.from('reviews').update({ notified: true }).eq('id', rv.id);
    }

    // сообщения от админа -> юзеру в бот
    const { data: ams } = await db.from('admin_msgs').select('*').eq('sent', false);
    for (const a of ams || []) {
      const tid = await tgIdOf(a.to_user);
      if (tid) await send(tid, `<b>Сообщение от администрации Бомбилы:</b>\n${a.text}`);
      await db.from('admin_msgs').update({ sent: true }).eq('id', a.id);
    }

    // одобренный возврат -> отправить промокод
    const { data: appr } = await db.from('winback_queue').select('*').eq('status', 'approved');
    for (const w of appr || []) {
      const { data: u } = await db.from('users').select('telegram_id,name').eq('id', w.user_id).maybeSingle();
      if (u && u.telegram_id) {
        const code = 'BACK' + Math.random().toString(36).slice(2, 6).toUpperCase();
        const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        await db.from('promos').insert({ code, days: 2, for_user: w.user_id, expires_at: exp });
        await db.from('users').update({ winback_sent: new Date().toISOString() }).eq('id', w.user_id);
        await send(u.telegram_id,
          `🎁 <b>Мы соскучились!</b>\nДержите промокод на <b>2 дня бесплатной работы</b>:\n\n<code>${code}</code>\n\nВведите в приложении → Профиль → Подписка → «Промокод». Действует 7 дней.`);
      }
      await db.from('winback_queue').update({ status: 'done' }).eq('id', w.id);
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


/* ---------- неактивные водители: предупреждение и снятие с линии ---------- */
async function idleLoop() {
  try {
    const warnCut = new Date(Date.now() - 120 * 60 * 1000).toISOString();  // 2 часа
    const offCut  = new Date(Date.now() - 135 * 60 * 1000).toISOString();  // ещё 15 минут

    // предупреждение
    const { data: warn } = await db.from('users').select('*')
      .eq('status', 'online').eq('idle_warned', false).lt('last_active', warnCut);
    for (const u of warn || []) {
      if (u.telegram_id) await send(u.telegram_id,
        `⚠️ <b>Вы всё ещё на линии?</b>\nПриложение не открывалось больше 2 часов. Если не отметитесь в течение 15 минут, мы автоматически снимем вас с линии и закроем смену — чтобы пассажиры не звали вас впустую.`,
        { reply_markup: { inline_keyboard: [[wa('Я на линии', 'driver')]] } });
      await db.from('users').update({ idle_warned: true }).eq('id', u.id);
    }

    // снятие
    const { data: off } = await db.from('users').select('*')
      .eq('status', 'online').lt('last_active', offCut);
    for (const u of off || []) {
      await db.from('users').update({ status: 'offline', idle_warned: false }).eq('id', u.id);
      const { data: sh } = await db.from('shifts').select('*').eq('driver_id', u.id).is('ended_at', null).limit(1);
      if (sh && sh.length) {
        const s = sh[0];
        const mins = Math.max(1, Math.round((Date.now() - new Date(s.started_at)) / 60000));
        await db.from('shifts').update({ ended_at: new Date().toISOString(), minutes: mins }).eq('id', s.id);
      }
      if (u.telegram_id) await send(u.telegram_id,
        `🌙 <b>Вы сняты с линии</b>\nПриложение долго не открывалось, смена закрыта автоматически. Когда снова выйдете на линию — заявки начнут приходить.`,
        { reply_markup: { inline_keyboard: [[wa('Выйти на линию', 'driver')]] } });
    }
  } catch (e) { console.error('idle', e.message); }
  setTimeout(idleLoop, 5 * 60 * 1000);
}


/* ---------- возврат «спящих» водителей ---------- */
async function winbackLoop() {
  try {
    const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    const sleepCut = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(); // 14 дней без активности
    const wbCut    = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(); // не чаще раза в 30 дней
    const { data: sleepers } = await db.from('users').select('*')
      .in('role', ['driver', 'both'])
      .eq('ever_paid', true)
      .lt('last_active', sleepCut);
    const now = Date.now();
    for (const u of sleepers || []) {
      if (u.winback_sent && u.winback_sent > wbCut) continue;
      if (!u.telegram_id) continue;
      // не беспокоим тех, у кого подписка ещё активна — они оплатили вперёд
      if (u.sub_until && new Date(u.sub_until).getTime() > now) continue;
      // не дублируем предложение, если уже висит в очереди
      const { data: exists } = await db.from('winback_queue').select('id').eq('user_id', u.id).in('status', ['pending', 'approved']).limit(1);
      if (exists && exists.length) continue;
      // предлагаем админу — он одобрит вручную
      await db.from('winback_queue').insert({ user_id: u.id, user_name: u.name, last_active: u.last_active });
    }
  } catch (e) { console.error('winback', e.message); }
  setTimeout(winbackLoop, 6 * 3600 * 1000); // раз в 6 часов
}

/* ---------- проверка подписи Telegram initData ---------- */
function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of [...params.entries()].sort()) pairs.push(`${k}=${v}`);
    const dataCheck = pairs.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (calc !== hash) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    // проверим срок (не старше 24ч)
    const authDate = Number(params.get('auth_date') || 0);
    if (Date.now() / 1000 - authDate > 86400) return null;
    return user; // { id, first_name, ... }
  } catch (e) { return null; }
}

// достаём запись пользователя по telegram_id из проверенных данных
async function userFromInit(initData) {
  const tgUser = verifyInitData(initData);
  if (!tgUser) return null;
  const { data } = await db.from('users').select('*').eq('telegram_id', tgUser.id).maybeSingle();
  return data || null;
}
const isStaff = u => u && ['owner', 'admin', 'moderator'].includes(u.staff_role);
const isAdminUp = u => u && ['owner', 'admin'].includes(u.staff_role);

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
  res.end(JSON.stringify(obj));
}

/* ---------- защищённый API ---------- */
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, {});
  if (req.method === 'GET') return json(res, 200, { ok: true, service: 'bombily-backend', version: 'v7-locked' });

  const body = await readBody(req);
  const me = await userFromInit(body.initData || '');
  if (!me) return json(res, 401, { error: 'auth' });

  try {
    // --- покупка подписки (сам пользователь) ---
    if (req.url === '/api/buy-sub') {
      const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
      const days = Number(body.days);
      const priceMap = { 1: st.price_1, 3: st.price_3, 7: st.price_7, 30: st.price_30 };
      const price = priceMap[days];
      if (!price) return json(res, 400, { error: 'bad_days' });
      if (st.paid_mode) {
        if ((Number(me.balance) || 0) < price) return json(res, 400, { error: 'no_funds' });
        await db.from('users').update({ balance: (Number(me.balance) || 0) - price }).eq('id', me.id);
      }
      const base = (me.sub_until && new Date(me.sub_until) > new Date()) ? new Date(me.sub_until) : new Date();
      base.setDate(base.getDate() + days);
      const upd = { sub_until: base.toISOString() };
      if (st.paid_mode && !me.ever_paid) {
        upd.ever_paid = true;
        // реферальный бонус пригласившему
        if (st.ref_enabled && me.ref_by && !me.ref_paid) {
          const { data: inv } = await db.from('users').select('id,balance,name').eq('id', me.ref_by).maybeSingle();
          if (inv) {
            await db.from('users').update({ balance: (Number(inv.balance) || 0) + (Number(st.ref_bonus) || 100) }).eq('id', inv.id);
            await db.from('payments').insert({ user_id: inv.id, user_name: inv.name, amount: Number(st.ref_bonus) || 100, kind: 'referral', note: 'бонус за ' + me.name });
            upd.ref_paid = true;
          }
        }
      }
      await db.from('users').update(upd).eq('id', me.id);
      await db.from('payments').insert({ user_id: me.id, user_name: me.name, amount: st.paid_mode ? -price : 0, kind: 'sub', days, note: st.paid_mode ? '' : 'бесплатный период' });
      return json(res, 200, { ok: true, sub_until: base.toISOString(), balance: (st.paid_mode ? (Number(me.balance) || 0) - price : me.balance) });
    }

    // --- применить промокод (сам пользователь) ---
    if (req.url === '/api/redeem-promo') {
      const code = String(body.code || '').trim().toUpperCase();
      const { data: p } = await db.from('promos').select('*').eq('code', code).maybeSingle();
      if (!p) return json(res, 400, { error: 'not_found' });
      if (p.used) return json(res, 400, { error: 'used' });
      if (p.for_user && p.for_user !== me.id) return json(res, 400, { error: 'not_yours' });
      if (p.expires_at && new Date(p.expires_at) < new Date()) return json(res, 400, { error: 'expired' });
      const upd = {};
      if (p.days > 0) {
        const base = (me.sub_until && new Date(me.sub_until) > new Date()) ? new Date(me.sub_until) : new Date();
        base.setDate(base.getDate() + p.days);
        upd.sub_until = base.toISOString();
      }
      if (Number(p.amount) > 0) upd.balance = (Number(me.balance) || 0) + Number(p.amount);
      if (Object.keys(upd).length) await db.from('users').update(upd).eq('id', me.id);
      await db.from('promos').update({ used: true, used_by: me.id }).eq('id', p.id);
      await db.from('payments').insert({ user_id: me.id, user_name: me.name, amount: Number(p.amount) || 0, kind: 'promo', days: p.days || null, note: 'промокод ' + code });
      return json(res, 200, { ok: true, days: p.days, amount: p.amount, sub_until: upd.sub_until || me.sub_until, balance: upd.balance ?? me.balance });
    }

    // --- подача заявки в водители (сам пользователь) ---
    if (req.url === '/api/apply-driver') {
      const phone = String(body.phone || '').slice(0, 30);
      if (phone.replace(/\D/g, '').length < 7) return json(res, 400, { error: 'bad_phone' });
      if (me.driver_status === 'approved') return json(res, 400, { error: 'already' });
      await db.from('users').update({ phone, driver_status: 'pending' }).eq('id', me.id);
      if (OWNER) await send(OWNER, `🚗 <b>Новая заявка в водители</b>\n${me.name} · ${phone}\nОткройте панель → Заявки.`);
      return json(res, 200, { ok: true });
    }

    // --- отправка отзыва (сам пользователь) ---
    if (req.url === '/api/review') {
      const target = body.target_id;
      if (!target || !body.ride_id) return json(res, 400, { error: 'bad_input' });
      const rating = Math.max(1, Math.min(5, Number(body.rating) || 5));
      // не даём оценить одну поездку дважды
      const { data: dup } = await db.from('reviews').select('id').eq('ride_id', body.ride_id).eq('from_id', me.id).limit(1);
      if (dup && dup.length) return json(res, 400, { error: 'already' });
      await db.from('reviews').insert({
        ride_id: body.ride_id, from_id: me.id, from_name: me.name,
        target_id: target, target_name: body.target_name || '',
        rating, kind: body.kind === 'passenger' ? 'passenger' : 'driver',
        comment: String(body.comment || '').slice(0, 500)
      });
      // пересчёт рейтинга по видимым отзывам
      const { data: all } = await db.from('reviews').select('rating').eq('target_id', target).eq('visible', true);
      if (all && all.length) {
        const avg = (all.reduce((s, r) => s + r.rating, 0) / all.length).toFixed(1);
        await db.from('users').update({ rating: avg }).eq('id', target);
      }
      return json(res, 200, { ok: true });
    }

    // --- жалоба / спор по отзыву (сам пользователь) ---
    if (req.url === '/api/complaint') {
      await db.from('complaints').insert({
        from_id: me.id, from_name: me.name,
        target_id: body.target_id || me.id, target_name: body.target_name || me.name,
        reason: String(body.reason || '').slice(0, 200),
        comment: String(body.comment || '').slice(0, 500),
        review_id: body.review_id || null,
        kind: body.kind || 'user'
      });
      return json(res, 200, { ok: true });
    }

    // --- админские операции (только staff) ---
    if (req.url === '/api/admin') {
      if (!isStaff(me)) return json(res, 403, { error: 'forbidden' });
      const act = body.action;
      const tid = body.target_id;

      if (act === 'adjust-balance' && isAdminUp(me)) {
        const { data: u } = await db.from('users').select('balance,name').eq('id', tid).single();
        await db.from('users').update({ balance: (Number(u.balance) || 0) + Number(body.amount) }).eq('id', tid);
        await db.from('payments').insert({ user_id: tid, user_name: u.name, amount: Number(body.amount), kind: 'adjust', note: body.note || 'админ' });
        return json(res, 200, { ok: true });
      }
      if (act === 'ban') {
        await db.from('users').update({ is_banned: !!body.value, status: 'offline' }).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'set-role' && me.staff_role === 'owner') {
        await db.from('users').update({ staff_role: body.role }).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'driver-status') {
        const upd = { driver_status: body.status };
        if (body.car !== undefined) upd.car = body.car;
        if (body.plate !== undefined) upd.plate = body.plate;
        if (body.status === 'approved') upd.role = 'both';
        await db.from('users').update(upd).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'edit-user' && isAdminUp(me)) {
        const f = body.fields || {};
        const allowed = {};
        ['name','phone','age','car','plate','spot','rating','role','driver_status','balance'].forEach(k => { if (f[k] !== undefined) allowed[k] = f[k]; });
        await db.from('users').update(allowed).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'del-review') {
        await db.from('reviews').delete().eq('id', body.review_id);
        const { data: all } = await db.from('reviews').select('rating').eq('target_id', tid).eq('visible', true);
        const avg = all && all.length ? (all.reduce((s, r) => s + r.rating, 0) / all.length).toFixed(1) : 5;
        await db.from('users').update({ rating: avg }).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      // --- промокоды (staff) ---
      if (act === 'create-promo') {
        let code = String(body.code || '').trim().toUpperCase();
        if (!code) code = 'BMB' + Math.random().toString(36).slice(2, 6).toUpperCase();
        const row = { code, days: Number(body.days) || 0, amount: Number(body.amount) || 0 };
        if (body.expires_days && Number(body.expires_days) > 0)
          row.expires_at = new Date(Date.now() + Number(body.expires_days) * 86400000).toISOString();
        const { error } = await db.from('promos').insert(row);
        if (error) return json(res, 400, { error: String(error.message).includes('duplicate') ? 'duplicate' : 'insert_failed' });
        return json(res, 200, { ok: true, code });
      }
      if (act === 'delete-promo') {
        await db.from('promos').delete().eq('id', body.promo_id);
        return json(res, 200, { ok: true });
      }

      // --- настройки сервиса (только owner/admin) ---
      if (act === 'save-settings' && isAdminUp(me)) {
        const f = body.fields || {};
        const allowed = {};
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus'].forEach(k => {
          if (f[k] !== undefined) allowed[k] = f[k];
        });
        if (!Object.keys(allowed).length) return json(res, 400, { error: 'nothing' });
        await db.from('settings').update(allowed).eq('id', 1);
        return json(res, 200, { ok: true });
      }

      // --- написать пользователю через бота (staff) ---
      if (act === 'send-msg') {
        if (!body.text || !String(body.text).trim()) return json(res, 400, { error: 'empty' });
        await db.from('admin_msgs').insert({ to_user: tid, text: String(body.text).slice(0, 2000) });
        return json(res, 200, { ok: true });
      }

      // --- обращения в поддержку (staff) ---
      if (act === 'support-answered') {
        await db.from('support_msgs').update({ answered: true }).eq('id', body.support_id);
        return json(res, 200, { ok: true });
      }

      // --- очередь возврата спящих (staff) ---
      if (act === 'winback') {
        const st = body.status === 'approved' ? 'approved' : 'dismissed';
        await db.from('winback_queue').update({ status: st }).eq('id', body.queue_id);
        return json(res, 200, { ok: true });
      }

      // --- жалобы (staff) ---
      if (act === 'resolve-complaint') {
        await db.from('complaints').update({ status: 'done' }).eq('id', body.complaint_id);
        if (body.ban_target) await db.from('users').update({ is_banned: true, status: 'offline' }).eq('id', body.ban_target);
        return json(res, 200, { ok: true });
      }

      // ---- промокоды ----
      if (act === 'promo-list') {
        const { data } = await db.from('promos').select('*').order('created_at', { ascending: false }).limit(60);
        return json(res, 200, { ok: true, items: data || [] });
      }
      if (act === 'promo-create' && isAdminUp(me)) {
        const row = { code: String(body.code || '').toUpperCase(), days: Number(body.days) || 0, amount: Number(body.amount) || 0 };
        if (body.expires_days > 0) row.expires_at = new Date(Date.now() + Number(body.expires_days) * 86400000).toISOString();
        const { error } = await db.from('promos').insert(row);
        if (error) return json(res, 400, { error: error.message.includes('duplicate') ? 'duplicate' : 'db' });
        return json(res, 200, { ok: true, code: row.code });
      }
      if (act === 'promo-delete' && isAdminUp(me)) {
        await db.from('promos').delete().eq('id', body.promo_id);
        return json(res, 200, { ok: true });
      }

      // ---- настройки ----
      if (act === 'settings-update' && isAdminUp(me)) {
        const f = body.fields || {};
        const allowed = {};
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus'].forEach(k => { if (f[k] !== undefined) allowed[k] = f[k]; });
        await db.from('settings').update(allowed).eq('id', 1);
        const { data } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
        return json(res, 200, { ok: true, settings: data });
      }

      // ---- обращения в поддержку ----
      if (act === 'support-list') {
        const { data } = await db.from('support_msgs').select('*').eq('answered', false).order('created_at', { ascending: false }).limit(60);
        return json(res, 200, { ok: true, items: data || [] });
      }
      if (act === 'support-count') {
        const { count } = await db.from('support_msgs').select('*', { count: 'exact', head: true }).eq('answered', false);
        return json(res, 200, { ok: true, count: count || 0 });
      }
      if (act === 'support-answer') {
        let uid = body.to_user;
        if (!uid && body.to_tg) {
          const { data: u } = await db.from('users').select('id').eq('telegram_id', body.to_tg).maybeSingle();
          if (u) uid = u.id;
        }
        if (!uid) return json(res, 400, { error: 'no_user' });
        await db.from('admin_msgs').insert({ to_user: uid, text: body.text });
        if (body.support_id) await db.from('support_msgs').update({ answered: true }).eq('id', body.support_id);
        return json(res, 200, { ok: true });
      }
      if (act === 'support-hide') {
        await db.from('support_msgs').update({ answered: true }).eq('id', body.support_id);
        return json(res, 200, { ok: true });
      }

      // ---- сообщение пользователю от администрации ----
      if (act === 'send-msg') {
        if (!body.to_user || !body.text) return json(res, 400, { error: 'bad_input' });
        await db.from('admin_msgs').insert({ to_user: body.to_user, text: body.text });
        return json(res, 200, { ok: true });
      }

      // ---- очередь возврата спящих ----
      if (act === 'winback-list') {
        const { data } = await db.from('winback_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false });
        return json(res, 200, { ok: true, items: data || [] });
      }
      if (act === 'winback-set' && isAdminUp(me)) {
        await db.from('winback_queue').update({ status: body.status }).eq('id', body.queue_id);
        return json(res, 200, { ok: true });
      }

      return json(res, 400, { error: 'bad_action' });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('api', e.message);
    return json(res, 500, { error: 'server' });
  }
}).listen(PORT, () => console.log('listening on ' + PORT));

setupBot();
poll();
notifyLoop();
expireLoop();
idleLoop();
winbackLoop();
