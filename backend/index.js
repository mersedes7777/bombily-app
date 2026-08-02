import http from 'http';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.MINI_APP_URL;
const OWNER   = Number(process.env.OWNER_ID || process.env.OWNER || 8672930773);
const PORT    = process.env.PORT || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME || 'bombily_bot';

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
function appUrl(s, u, extra) {
  const uid = u ? u.id : '';
  const nm = u && u.first_name ? encodeURIComponent(u.first_name) : '';
  let url = `${APP_URL}?s=${s}&uid=${uid}&nm=${nm}`;
  if (extra) for (const [k, v] of Object.entries(extra)) url += `&${k}=${encodeURIComponent(v)}`;
  return url;
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
const fwdMap = new Map();
async function setStaffReply(staffTg, targetTg, supportId){
  try { await db.from('staff_reply').upsert({ staff_tg: staffTg, target_tg: targetTg, support_id: supportId || null, created_at: new Date().toISOString() }); } catch(e){}
}
async function getStaffReply(staffTg){
  try { const { data } = await db.from('staff_reply').select('*').eq('staff_tg', staffTg).maybeSingle(); return data || null; } catch(e){ return null; }
}
async function clearStaffReply(staffTg){
  try { await db.from('staff_reply').delete().eq('staff_tg', staffTg); } catch(e){}
}
async function deliverStaffReply(staffChat, link, m, text, hasPhoto){
  const staff = await staffByTg(staffChat);
  if (!staff) { await send(staffChat, '⛔ Отвечать могут только администраторы.'); return true; }
  const photoId = hasPhoto ? m.photo[m.photo.length - 1].file_id : null;
  if (photoId) {
    await tg('sendPhoto', { chat_id: link.target_tg, photo: photoId, caption: `<b>Ответ администрации</b>${text ? '\n' + text : ''}`, parse_mode: 'HTML' });
  } else {
    if (!text) { await send(staffChat, 'Напишите текст ответа.'); return true; }
    await send(link.target_tg, `<b>Ответ администрации:</b>\n${text}`);
  }
  if (link.support_id) {
    try {
      await db.from('support_msgs').update({ answered: true, answered_by: staff.id, answered_by_name: staff.name }).eq('id', link.support_id);
    } catch (e) {}
  }
  await send(staffChat, '✅ Ответ отправлен');
  return true;
}
async function setWait(tgid){ waitingSupport.add(tgid); try{ await db.from('support_wait').upsert({ tg: tgid, created_at: new Date().toISOString() }); }catch(e){} }
async function isWaiting(tgid){
  if (waitingSupport.has(tgid)) return true;
  try { const { data } = await db.from('support_wait').select('tg').eq('tg', tgid).maybeSingle(); return !!data; } catch(e){ return false; }
}
async function clearWait(tgid){ waitingSupport.delete(tgid); try{ await db.from('support_wait').delete().eq('tg', tgid); }catch(e){} }
async function staffByTg(tgid) {
  try {
    const { data } = await db.from('users').select('id,name,staff_role,telegram_id').eq('telegram_id', tgid).maybeSingle();
    if (!data) return null;
    if (String(tgid) === String(OWNER)) return data;
    if (['owner', 'admin', 'moderator'].includes(data.staff_role)) return data;
    return null;
  } catch (e) { return null; }
}           // message_id у админа -> telegram_id пользователя

async function onUpdate(u) {
  if (u.callback_query) {
    const cq = u.callback_query, chat = cq.from.id;
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data && cq.data.startsWith('rep:')) {
      const staff = await staffByTg(chat);
      if (!staff) { await send(chat, '⛔ Отвечать могут только администраторы.'); return; }
      const parts = cq.data.split(':');
      const targetTg = Number(parts[1]);
      const supportId = parts[2] && parts[2] !== '0' ? parts[2] : null;
      await setStaffReply(chat, targetTg, supportId);
      await send(chat, '✍️ Напишите ответ — он уйдёт человеку. Можно отправить и фото.\n\nЧтобы отменить, напишите /cancel');
      return;
    }
    if (cq.data === 'support') {
      await setWait(chat);
      await send(chat, 'Напишите сообщение или пришлите фото — всё уйдёт администрации. Ответ придёт сюда же.');
    }
    return;
  }

  const m = u.message;
  if (!m) return;
  if (m.chat && (m.chat.type === 'group' || m.chat.type === 'supergroup')) {
    try { await onGroupMessage(m); } catch (e) { console.error('group', e.message); }
    return;
  }
  const hasPhoto = !!(m.photo && m.photo.length);
  if (!m.text && !hasPhoto) return;           // стикеры, голосовые и прочее пропускаем
  const chat = m.chat.id;
  const text = String(m.text || m.caption || '').trim();
  // сохраняем username телеграма для связи из админки
  if (m.from && m.from.username) {
    db.from('users').update({ tg_username: m.from.username }).eq('telegram_id', chat).then(()=>{}, ()=>{});
  }

  // отмена режима ответа
  if (text === '/cancel') { await clearStaffReply(chat); return send(chat, 'Отменено.'); }

  if (text === '/stop') {
    await db.from('users').update({ no_broadcast: true }).eq('telegram_id', chat);
    return send(chat, 'Больше не будем присылать общие сообщения. Уведомления по вашим заказам продолжат приходить.\n\nВернуть рассылку — /start');
  }

  // сотрудник нажал «Ответить» и теперь пишет ответ
  const pending = await getStaffReply(chat);
  if (pending && pending.target_tg && !text.startsWith('/')) {
    await clearStaffReply(chat);
    await deliverStaffReply(chat, pending, m, text, hasPhoto);
    return;
  }

  // ответ сотрудника цитатой на пересланное обращение
  if (m.reply_to_message) {
    let link = null;
    try {
      const { data } = await db.from('bot_replies').select('*').eq('message_id', m.reply_to_message.message_id).maybeSingle();
      link = data || null;
    } catch (e) {}
    if (!link && fwdMap.has(m.reply_to_message.message_id)) {
      link = { target_tg: fwdMap.get(m.reply_to_message.message_id), support_id: null };
    }
    if (link && link.target_tg) {
      const staff = await staffByTg(chat);
      if (!staff) { await send(chat, '⛔ Отвечать могут только администраторы.'); return; }
      const photoId = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : null;
      if (photoId) {
        await tg('sendPhoto', { chat_id: link.target_tg, photo: photoId, caption: `<b>Ответ администрации</b>${text ? '\n' + text : ''}`, parse_mode: 'HTML' });
      } else {
        if (!text) { await send(chat, 'Напишите текст ответа.'); return; }
        await send(link.target_tg, `<b>Ответ администрации:</b>\n${text}`);
      }
      if (link.support_id) {
        try {
          await db.from('support_msgs').update({ answered: true, answered_by: staff.id, answered_by_name: staff.name })
            .eq('id', link.support_id);
        } catch (e) {}
      }
      await send(chat, '✅ Ответ отправлен');
      return;
    }
  }

  if (text.startsWith('/start')) {
    await clearWait(chat);
    db.from('users').update({ no_broadcast: false }).eq('telegram_id', chat).then(() => {}, () => {});
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
    await setWait(chat);
    return send(chat, 'Напишите сообщение или пришлите фото — всё уйдёт администрации.');
  }

  // сообщение в режиме поддержки (текст и/или фото)
  if (await isWaiting(chat)) {
    const photoId = hasPhoto ? m.photo[m.photo.length - 1].file_id : null;
    if (!text && !photoId) return send(chat, 'Напишите сообщение текстом или пришлите фото.');
    await clearWait(chat);

    let uRow = null;
    try { const r0 = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle(); uRow = r0.data || null; } catch (e) {}

    // фото сохраняем в закрытое хранилище, чтобы было видно в панели
    let photoPath = null;
    if (photoId) photoPath = await saveTgPhoto(photoId, uRow ? uRow.id : chat);

    let supportId = null;
    try {
      const ins = await db.from('support_msgs').insert({
        from_tg: chat, from_name: (m.from.first_name || 'Гость'),
        from_username: m.from.username || null,
        from_user: uRow ? uRow.id : null,
        text: text || '(фото)', photo: photoPath
      }).select().single();
      if (ins.data) supportId = ins.data.id;
    } catch (e) {}

    const who = `${m.from.first_name || ''} ${m.from.username ? '@' + m.from.username : ''} (ID ${chat})`;
    const head = `📨 <b>Сообщение в поддержку</b>\nОт: ${who}\n\n${text || ''}\n\n<i>Нажмите «Ответить» ниже или ответьте на это сообщение.</i>`;

    // уведомляем всю модерацию, каждому запоминаем связку для ответа
    const { data: staff } = await db.from('users').select('telegram_id')
      .in('staff_role', ['owner', 'admin', 'moderator']);
    const ids = new Set((staff || []).map(s => s.telegram_id).filter(Boolean));
    if (OWNER) ids.add(Number(OWNER));
    for (const sid of ids) {
      try {
        const kb = { reply_markup: { inline_keyboard: [
          [{ text: '✍️ Ответить', callback_data: `rep:${chat}:${supportId || 0}` }],
          [wa('Открыть панель', 'admin')]
        ] } };
        let sent;
        if (photoId) {
          sent = await tg('sendPhoto', { chat_id: sid, photo: photoId, caption: head, parse_mode: 'HTML', reply_markup: kb.reply_markup });
        } else {
          sent = await send(sid, head, kb);
        }
        const mid = sent && sent.result && sent.result.message_id;
        if (mid) {
          fwdMap.set(mid, chat);
          await db.from('bot_replies').insert({ message_id: mid, staff_tg: sid, target_tg: chat, support_id: supportId });
        }
      } catch (e) {}
    }
    return send(chat, '✅ Сообщение отправлено администрации. Ответ придёт сюда.');
  }

  await send(chat, 'Кнопки внизу экрана 👇 Если нужна помощь — «💬 Связь с админом».', { reply_markup: kbFor(m.from) });
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
        if (r.kind === 'delivery') q = q.or('delivery.eq.true,vehicle_type.eq.moto'); // мотокурьеры получают доставку всегда
        else q = q.or('vehicle_type.is.null,vehicle_type.eq.car');  // мотоциклы возят только доставку
        if (r.to_city) q = q.eq('intercity', true);
        if (r.target_driver_id) q = db.from('users').select('telegram_id').eq('id', r.target_driver_id);
        const { data: drv } = await q;
        const isDel = r.kind === 'delivery';
        const isInter = !!r.to_city;
        const head = r.target_driver_id
          ? (isDel ? '🎯 <b>Доставка лично вам</b>' : isInter ? '🎯 <b>Межгород лично вам</b>' : '🎯 <b>Заявка лично вам</b>')
          : (isDel ? '📦 <b>Новая доставка</b>' : isInter ? `🛣 <b>Межгород в ${r.to_city}</b>` : '🚕 <b>Новая заявка</b>');
        const extra = `${r.to_city ? `\n🛣 Город назначения: <b>${r.to_city}</b>` : ''}${r.passenger_price ? `\n💰 Пассажир предлагает: <b>${r.passenger_price} ₽</b>` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}`;
        for (const d of drv || [])
          if (d.telegram_id) await send(d.telegram_id, `${head}\n📍 ${r.from_address}\n🏁 ${r.to_address}\nОт: ${r.passenger_name || 'пассажир'}${extra}`,
            { reply_markup: { inline_keyboard: [[wa('Открыть заявку', 'driver')]] } });
        await db.from('rides').update({ notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['новая заявка -> водителям'] = e.message; console.error('notify:новая заявка -> водителям', e.message); }

    try {
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

    } catch (e) { notifyErrors['отклик -> пассажиру'] = e.message; console.error('notify:отклик -> пассажиру', e.message); }

    try {
      // выбрали -> водителю
      const { data: conf } = await db.from('rides').select('*').eq('status', 'confirmed').eq('driver_notified', false);
      for (const r of conf || []) {
        const route = `📍 <b>Откуда:</b> ${r.from_address}\n🏁 <b>Куда:</b> ${r.to_address}${r.price ? `\n💰 <b>Цена:</b> ${r.price} ₽` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}`;

        // водителю — контакты пассажира
        if (r.driver_id) {
          const tid = await tgIdOf(r.driver_id);
          if (tid) {
            const card = await contactCard(r.passenger_id, 'Пассажир');
            await send(tid, `✅ <b>Вас выбрали!</b>\n\n${route}${card}`,
              { reply_markup: { inline_keyboard: [[wa('Открыть заказ', 'driver')]] } });
          }
        }
        // пассажиру — контакты водителя
        if (r.passenger_id) {
          const tid = await tgIdOf(r.passenger_id);
          if (tid) {
            const card = await contactCard(r.driver_id, 'Водитель');
            await send(tid, `🚕 <b>Водитель принял заказ</b>\n\n${route}${card}`,
              { reply_markup: { inline_keyboard: [[wa('Открыть поездку', 'order')]] } });
          }
        }
        await db.from('rides').update({ driver_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['выбрали -> водителю'] = e.message; console.error('notify:выбрали -> водителю', e.message); }

    try {
      // сообщения чата -> второй стороне
      const { data: msgs } = await db.from('messages').select('*').eq('notified', false);
      for (const msg of msgs || []) {
        const { data: ride } = await db.from('rides').select('passenger_id,driver_id').eq('id', msg.ride_id).maybeSingle();
        if (ride) {
          const other = msg.sender_id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
          if (other) {
            const tid = await tgIdOf(other);
            if (tid) await send(tid, `💬 <b>${msg.sender_name || 'Новое сообщение'}</b>\n${msg.text}`,
              { reply_markup: { inline_keyboard: [[{ text: '💬 Ответить', web_app: { url: `${APP_URL}?s=chat&ride=${msg.ride_id}` } }]] } });
          }
        }
        await db.from('messages').update({ notified: true }).eq('id', msg.id);
      }

    } catch (e) { notifyErrors['сообщения чата -> второй стороне'] = e.message; console.error('notify:сообщения чата -> второй стороне', e.message); }

    try {
      // поездка завершена -> обоим
      const { data: fin } = await db.from('rides').select('*').eq('status', 'completed').eq('done_notified', false);
      for (const r of fin || []) {
        const kindTxt = r.kind === 'delivery' ? '📦 Доставка выполнена' : '🏁 Поездка завершена';
        const when = new Date(r.created_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const base = `<b>${kindTxt}</b>\n\n📍 <b>Откуда:</b> ${r.from_address}\n🏁 <b>Куда:</b> ${r.to_address}${r.to_city ? `\n🛣 <b>Город:</b> ${r.to_city}` : ''}${r.price ? `\n💰 <b>Сумма:</b> ${r.price} ₽` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}\n🕒 ${when}`;
        // пассажиру
        let drvName = '', drvCar = '';
        if (r.driver_id) {
          const { data: dv } = await db.from('users').select('name,car,plate').eq('id', r.driver_id).maybeSingle();
          if (dv) { drvName = dv.name || ''; drvCar = `${dv.car || ''}${dv.plate ? ' · ' + dv.plate : ''}`; }
        }
        if (r.passenger_id) {
          const tid = await tgIdOf(r.passenger_id);
          if (tid) await send(tid,
            `${base}${drvName ? `\n👤 <b>Водитель:</b> ${drvName}${drvCar ? ` (${drvCar})` : ''}` : ''}\n\nОцените поездку — это поможет другим пассажирам.`,
            { reply_markup: { inline_keyboard: [[wa('Оценить', 'order')]] } });
        }
        if (r.driver_id) {
          const tid = await tgIdOf(r.driver_id);
          if (tid) await send(tid,
            `${base}${r.passenger_name ? `\n👤 <b>Пассажир:</b> ${r.passenger_name}` : ''}\n\nСпасибо за работу!`,
            { reply_markup: { inline_keyboard: [[wa('К заявкам', 'driver')]] } });
        }
        await db.from('rides').update({ done_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['поездка завершена -> обоим'] = e.message; console.error('notify:поездка завершена -> обоим', e.message); }

    try {
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

    } catch (e) { notifyErrors['смена закончилась -> итог водителю'] = e.message; console.error('notify:смена закончилась -> итог водителю', e.message); }

    try {
      // водитель приехал -> пассажиру
      const { data: arr } = await db.from('rides').select('*').eq('arrived', true).eq('arrived_notified', false);
      for (const r of arr || []) {
        const tid = await tgIdOf(r.passenger_id);
        if (tid) await send(tid, `🚗 <b>Водитель на месте</b>\n${r.from_address}\nМашина ждёт вас.`);
        await db.from('rides').update({ arrived_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['водитель приехал -> пассажиру'] = e.message; console.error('notify:водитель приехал -> пассажиру', e.message); }

    try {
      // отзывы становятся видимыми, когда обе стороны оценили
      const { data: hidden } = await db.from('reviews').select('*').eq('visible', false);
      for (const rv of hidden || []) {
        const { data: pair } = await db.from('reviews').select('id').eq('ride_id', rv.ride_id).neq('id', rv.id).limit(1);
        const old = Date.now() - new Date(rv.created_at).getTime() > 24 * 3600 * 1000;
        if ((pair && pair.length) || old) {
          await db.from('reviews').update({ visible: true }).eq('ride_id', rv.ride_id);
        }
      }

    } catch (e) { notifyErrors['отзывы становятся видимыми, когда обе ст'] = e.message; console.error('notify:отзывы становятся видимыми, когда обе ст', e.message); }

    try {
      // новые отзывы -> уведомить того, о ком отзыв (только когда отзыв стал видимым)
      // уведомляем не сразу, а через 5 минут после того, как отзыв оставили
      const revCut = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: nrev } = await db.from('reviews').select('*')
        .eq('visible', true).eq('notified', false).lt('created_at', revCut);
      for (const rv of nrev || []) {
        const tid = await tgIdOf(rv.target_id);
        if (tid) {
          const stars = '⭐'.repeat(rv.rating);
          await send(tid, `📝 <b>Новый отзыв о вас</b>\n${stars}${rv.comment ? '\n«' + rv.comment + '»' : ''}\n\nОткройте приложение, вкладка «Отзывы».`);
        }
        await db.from('reviews').update({ notified: true }).eq('id', rv.id);
      }

    } catch (e) { notifyErrors['новые отзывы -> уведомить того, о ком от'] = e.message; console.error('notify:новые отзывы -> уведомить того, о ком от', e.message); }

    try {
      // сообщения от админа -> юзеру в бот
      const { data: ams } = await db.from('admin_msgs').select('*').eq('sent', false);
      for (const a of ams || []) {
        const tid = await tgIdOf(a.to_user);
        if (tid) await send(tid, `<b>Сообщение от администрации Бомбилы:</b>\n${a.text}`);
        await db.from('admin_msgs').update({ sent: true }).eq('id', a.id);
      }

    } catch (e) { notifyErrors['сообщения от админа -> юзеру в бот'] = e.message; console.error('notify:сообщения от админа -> юзеру в бот', e.message); }

    try {
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

    } catch (e) { notifyErrors['одобренный возврат -> отправить промокод'] = e.message; console.error('notify:одобренный возврат -> отправить промокод', e.message); }

    try {
      // отмена заказа -> уведомляем вторую сторону
      const { data: canc } = await db.from('rides').select('*')
        .like('status', 'cancelled%').eq('cancel_notified', false);
      for (const r of canc || []) {
        const byPassenger = String(r.status).includes('passenger');
        const route = `${r.from_address} → ${r.to_address}`;
        if (byPassenger && r.driver_id) {
          const tid = await tgIdOf(r.driver_id);
          if (tid) await send(tid, `❌ <b>Пассажир отменил заказ</b>\n${route}\n\nМожете принимать другие заявки.`,
            { reply_markup: { inline_keyboard: [[wa('К заявкам', 'driver')]] } });
        } else if (!byPassenger && r.passenger_id) {
          const tid = await tgIdOf(r.passenger_id);
          if (tid) await send(tid, `❌ <b>Заказ отменён</b>\n${route}\n\nПопробуйте отправить заявку снова — на линии есть другие водители.`,
            { reply_markup: { inline_keyboard: [[wa('Заказать снова', 'order')]] } });
        }
        await db.from('rides').update({ cancel_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['отмена заказа -> уведомляем вторую сторо'] = e.message; console.error('notify:отмена заказа -> уведомляем вторую сторо', e.message); }

    try {
      // водитель отказался: заявка вернулась в общий пул -> сообщаем пассажиру
      const { data: back } = await db.from('rides').select('*')
        .eq('status', 'created').eq('cancelled_by', 'driver').eq('cancel_notified', false);
      for (const r of back || []) {
        if (r.passenger_id) {
          const tid = await tgIdOf(r.passenger_id);
          if (tid) await send(tid, `↩️ <b>Водитель отказался от заказа</b>\n${r.from_address} → ${r.to_address}\n\nЗаявка снова активна — ждём других водителей.`,
            { reply_markup: { inline_keyboard: [[wa('Открыть заявку', 'order')]] } });
        }
        await db.from('rides').update({ cancel_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['водитель отказался: заявка вернулась в о'] = e.message; console.error('notify:водитель отказался: заявка вернулась в о', e.message); }
    try {
      // одна сторона оценила -> напоминаем второй
      const cut2 = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data: fin2 } = await db.from('rides').select('*')
        .eq('status', 'completed').eq('review_nudged', false).lt('created_at', new Date().toISOString()).limit(50);
      for (const r of fin2 || []) {
        if (!r.driver_id || !r.passenger_id) continue;
        const { data: revs } = await db.from('reviews').select('from_id,created_at').eq('ride_id', r.id);
        if (!revs || revs.length === 0) continue;
        if (revs.length >= 2) { await db.from('rides').update({ review_nudged: true }).eq('id', r.id); continue; }
        // прошло ли 2 минуты с момента первого отзыва
        if (revs[0].created_at > cut2) continue;
        const who = revs[0].from_id;
        const other = who === r.passenger_id ? r.driver_id : r.passenger_id;
        const tid = await tgIdOf(other);
        if (tid) {
          const isDrv = other === r.driver_id;
          await send(tid,
            `⭐ <b>Оцените ${isDrv ? 'пассажира' : 'поездку'}</b>\n${r.from_address} → ${r.to_address}\n\nВторая сторона уже оставила оценку. Оставьте свою — отзывы откроются обоим.`,
            { reply_markup: { inline_keyboard: [[wa('Оценить', isDrv ? 'driver' : 'order')]] } });
        }
        await db.from('rides').update({ review_nudged: true }).eq('id', r.id);
      }
    } catch (e) { notifyErrors['review-nudge'] = e.message; console.error('notify:review-nudge', e.message); }

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
    // сколько часов простоя терпим — настраивается в панели, 0 = не снимать
    let idleH = 5;
    try {
      const { data: st } = await db.from('settings').select('idle_hours').eq('id', 1).maybeSingle();
      if (st && st.idle_hours !== null && st.idle_hours !== undefined) idleH = Number(st.idle_hours);
    } catch (e) {}
    if (idleH && idleH > 0) {
    const warnMin = idleH * 60;
    const warnCut = new Date(Date.now() - warnMin * 60 * 1000).toISOString();
    const offCut  = new Date(Date.now() - (warnMin + 20) * 60 * 1000).toISOString();

    // предупреждение
    const { data: warn } = await db.from('users').select('*')
      .eq('status', 'online').eq('idle_warned', false).lt('last_active', warnCut);
    for (const u of warn || []) {
      if (u.telegram_id) await send(u.telegram_id,
        `⚠️ <b>Вы всё ещё на линии?</b>\nПриложение не открывалось больше ${idleH} ч. Если не отметитесь в течение 20 минут, мы автоматически снимем вас с линии и закроем смену — чтобы пассажиры не звали вас впустую.`,
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


/* ---------- смена по расписанию: закрываем по времени ---------- */
async function shiftLoop() {
  try {
    const now = new Date().toISOString();
    const { data: due } = await db.from('shifts').select('*')
      .is('ended_at', null).not('planned_end', 'is', null).lt('planned_end', now);
    for (const s of due || []) {
      const mins = Math.max(1, Math.round((Date.now() - new Date(s.started_at)) / 60000));
      await db.from('shifts').update({ ended_at: new Date().toISOString(), minutes: mins, auto_closed: true }).eq('id', s.id);
      await db.from('users').update({ status: 'offline' }).eq('id', s.driver_id);
      await db.from('offers').update({ status: 'cancelled' }).eq('driver_id', s.driver_id).eq('status', 'pending');
      const tid = await tgIdOf(s.driver_id);
      if (tid) {
        const { data: rr } = await db.from('rides').select('price')
          .eq('driver_id', s.driver_id).eq('status', 'completed')
          .gte('created_at', s.started_at).lte('created_at', new Date().toISOString());
        const done = (rr || []).length;
        const earned = (rr || []).reduce((a, x) => a + (Number(x.price) || 0), 0);
        const h = Math.floor(mins / 60), mm = mins % 60;
        await send(tid,
          `🌙 <b>Смена окончена по расписанию</b>\nВы отработали: <b>${h} ч ${mm} мин</b>\nПоездок: <b>${done}</b>\nЗаработано: <b>${earned} ₽</b>\n\nОтдыхайте. Захотите продолжить — выходите на линию снова.`,
          { reply_markup: { inline_keyboard: [[wa('Выйти на линию', 'driver')]] } });
      }
    }
  } catch (e) { console.error('shiftLoop', e.message); }
  setTimeout(shiftLoop, 60 * 1000);
}


/* ================= работа в городских группах ================= */

// ---------- распознавание попыток заказать в чате ----------

// нормализуем: нижний регистр, ё→е, лишние знаки в пробелы
function norm(t) {
  return String(t || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9+]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// сообщение целиком — короткий сигнал («такси», «такси?», «машина»)
const SOLO = ['такси','таксы','машина','машину','бомбила','бомбилу','водитель','водителя',
              'кто свободен','свободен','свободные','есть свободные','кто работает','работает кто',
              'кто таксует','таксует кто','кто на линии','кто на смене','нужна машина','нужно такси'];

// прямые фразы — удаляем без раздумий
const PHRASES = [
  // кто свободен / работает
  'кто свободен','кто свободный','кто свободна','кто свободны','есть свободные','есть свободный',
  'кто работает','кто то работает','кто нибудь работает','работает кто','кто из вас работает',
  'кто таксует','кто то таксует','кто нибудь таксует','таксует кто','кто таксуе',
  'кто на линии','есть кто на линии','кто на смене','кто катает','кто то катает','кто возит',
  'кто в рейсе','кто работет','кто рабоает',
  // нужна машина
  'нужна машина','нужно такси','нужен водитель','нужен бомбила','нужна тачка','нужно машину',
  'надо такси','такси надо','такси нужно','машина нужна','тачка нужна','нужен транспорт',
  'ищу машину','ищу водителя','ищу такси','ищу бомбилу','ищу транспорт',
  'требуется машина','требуется водитель','срочно машина','срочно такси','срочно нужна машина',
  // кто отвезёт
  'кто отвезет','кто подвезет','кто довезет','кто заберет','кто закинет','кто подкинет',
  'кто подбросит','кто отвезет меня','кто может отвезти','кто может подвезти','кто может забрать',
  'кто сможет отвезти','кто сможет подвезти','кто отвезет до','кто подвезет до',
  'подкиньте до','подбросьте до','подвезите до','отвезите до','заберите с','заберите из',
  'нужно забрать','надо забрать','надо отвезти','нужно отвезти','надо доставить','нужно доставить',
  'кто доставит','кто привезет','надо подвезти','нужно подвезти',
  // есть ли машина
  'есть водитель','есть машина','есть тачка','есть кто с машиной','машина есть','водитель есть',
  'кто с машиной','у кого машина','кто за рулем',
  // поездка куда-то
  'надо доехать','нужно доехать','надо добраться','нужно добраться','как доехать до',
  'кто едет в','кто поедет в','едет кто в','попутка','нужна попутка','ищу попутку'
];

// просьба + поездка
const ASK_RE  = /(нужн|надо|ищу|требуетс|срочно|помогите|подскажите|можно ли|кто|кому|есть)/;
const TRIP_RE = /(такси|машин|тачк|водител|бомбил|подвез|отвез|довез|увез|привез|забер|забрать|закин|подкин|подброс|доставит|поездк|подвезт|отвезт|катает|катаеш|таксу|попутк|рейс|доехат|доеха|добрат|подброс)/;
// «кто ...» + «работает / свободен / таксует»
const WHO_RE  = /(кто|кто то|кто нибудь|ктонибудь|кому|у кого|есть кто)/;
const WORK_RE = /(свободен|свободн|работает|работаеш|работаете|таксует|таксуеш|таксуете|таксу|на линии|на смене|катает|катаеш|возит|за рулем|в рейсе)/;

// разговор о прошлом, о ценах, благодарности — не трогаем
const PAST_RE = /(вчера|позавчера|на днях|(^| )ехал|(^| )ездил|ездили|приехал|доехал|отвез меня|подорожал|подешевел|цены|стоило|стоил|было|раньше|спасибо|благодар|обсужд|как думаете|мнение|видел|слышал|говорят|расскажит|напомин|история)/;
// вопрос не про поездку: «кто работает в аптеке»
const OTHER_RE = /(магазин|аптек|поликлин|больниц|мэри|администрац|школ|садик|банк|почт|парикмахер|шиномонтаж|сто |мастер|ремонт|электрик|сантехник|кафе|столов|рынок|базар|салон|нотариус|мфц)/;

// ответы водителей: «приму», «беру», «отвезу», «пиши в лс»
const REPLY_SOLO = ['приму','примите','приняли','беру','возьму','я возьму','я приму','взял',
  'отвезу','подвезу','довезу','заберу','закину','подкину','подброшу','отвезем','подвезем',
  'я свободен','свободен я','я на линии','я работаю','я таксую','работаю','таксую','катаю',
  'могу отвезти','могу подвезти','могу забрать','могу','подъеду','выезжаю','еду','уже еду',
  'на месте','буду через 5','буду через 10','где вы','куда ехать','откуда забирать','адрес',
  'сколько','сколько заплатите','за сколько','триста','двести','500','300','200'];
const REPLY_PHRASES = ['пиши в лс','пишите в лс','напиши в лс','в личку','пиши в личку',
  'скину номер','мой номер','звони','звоните','набери','наберите','буду через',
  'подъеду через','я подъеду','уже выехал','выехал','на подходе','я рядом','возьму заказ',
  'куда надо','откуда и куда','адрес скинь','скинь адрес','сколько километров'];

// основы глаголов перевозки — ловят любые окончания:
// отвезёте, отвезёшь, отвезут, подвезёте, заберёте, подкинешь, докинете…
const VERB_RE = /(отвез|отвёз|подвез|подвёз|довез|довёз|увез|увёз|привез|привёз|завез|перевез|развез|свез|свозит|свози|забер|забрат|забери|заберит|закин|докин|подкин|перекин|подброс|подкид|подкат|прокат|прокач|доставит|доставл|домчит|домчат|подъед|подъехат|подъезж|приед|приехат|подхват|подсад|подсоб|подки|скатат|скатай|катан|катает|катаеш|катать|таксу|отвезт|подвезт|довезт|везет|везёт|везеш|везёш|повез|повёз)/;

// одиночные вопросы: «Отвезёте?», «Подвезёшь?», «Свободны?»
const SOLO_RE = /^(такси|таксы|машина|машину|машинка|тачка|тачку|бомбила|бомбилу|бомбилы|водитель|водителя|водители|свободен|свободны|свободные|свободный|работаете|работаешь|работает|таксуете|таксуешь|таксует|катаете|катаешь|катает|есть кто|кто|кто есть|кто там|алло)\s*[?!.]*$/;

function looksLikeDriverReply(text) {
  const t = norm(text);
  if (!t) return false;
  if (PAST_RE.test(t)) return false;
  if (t.length <= 42 && REPLY_SOLO.includes(t)) return true;
  for (const p of REPLY_PHRASES) if (t.includes(p)) return true;
  if (t.length <= 80 && VERB_RE.test(t)) return true;
  return false;
}

function looksLikeOrder(text) {
  const t = norm(text);
  if (!t) return false;
  if (t.length > 260) return false;

  // сообщение целиком — короткий сигнал
  if (SOLO.includes(t)) return true;
  if (SOLO_RE.test(t)) return true;

  if (PAST_RE.test(t)) return false;

  // короткая фраза с глаголом перевозки — почти всегда про поездку
  // «Отвезёте?», «Подвезёте до вокзала», «Заберёте с Ленина 42»
  if (t.length <= 80 && VERB_RE.test(t)) return true;

  const hasTrip = TRIP_RE.test(t);

  // речь про аптеку, магазин, мэрию и прочее, а не про машину
  if (OTHER_RE.test(t) && !hasTrip) return false;

  // прямые фразы
  for (const p of PHRASES) if (t.includes(p)) return true;

  // «кто работает / кто свободен / кто таксует»
  if (WHO_RE.test(t) && WORK_RE.test(t)) return true;

  // просьба + поездка
  if (ASK_RE.test(t) && hasTrip) return true;

  // объявление перевозчика: поездка + телефон
  if (hasTrip && /(\+?\d[\d\- ()]{8,}\d)/.test(t)) return true;

  return false;
}

const groupReplyAt = new Map();   // когда последний раз отвечали в чате
const groupLog = [];              // последние события из групп — для диагностики
function glog(msg) {
  groupLog.unshift(new Date().toLocaleTimeString('ru') + ' — ' + msg);
  if (groupLog.length > 12) groupLog.pop();
}

async function delLater(chatId, messageId, sec) {
  setTimeout(() => { tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {}); }, sec * 1000);
}

async function groupSettings() {
  try {
    const { data } = await db.from('settings').select('group_moderate,group_clean_service,group_welcome').eq('id', 1).maybeSingle();
    return data || {};
  } catch (e) { return {}; }
}

// группа наша, если её id прописан у какого-то города
async function cityByGroup(chatId) {
  try {
    const { data } = await db.from('cities').select('name,group_link').eq('group_id', chatId).maybeSingle();
    return data || null;
  } catch (e) { return null; }
}

async function onGroupMessage(m) {
  const chatId = m.chat.id;
  const preview = String(m.text || m.caption || '').slice(0, 40) || '(без текста)';
  const city = await cityByGroup(chatId);
  if (!city) {
    glog(`чат ${chatId}: города с таким ID нет · «${preview}»`);
    return;                                // чужая группа — не вмешиваемся
  }
  const st = await groupSettings();

  // любые служебные сообщения телеграма
  const SERVICE_FIELDS = ['new_chat_members','left_chat_member','new_chat_title','new_chat_photo',
    'delete_chat_photo','group_chat_created','supergroup_chat_created','channel_chat_created',
    'pinned_message','message_auto_delete_timer_changed','migrate_to_chat_id','migrate_from_chat_id',
    'video_chat_started','video_chat_ended','video_chat_scheduled','video_chat_participants_invited',
    'forum_topic_created','forum_topic_edited','forum_topic_closed','forum_topic_reopened',
    'general_forum_topic_hidden','general_forum_topic_unhidden','write_access_allowed',
    'users_shared','chat_shared','boost_added','proximity_alert_triggered',
    'giveaway_created','giveaway_completed','successful_payment'];
  const isService = SERVICE_FIELDS.some(f => m[f] !== undefined);
  if (isService) {
    if (st.group_clean_service !== false) {
      await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    }
    if (m.new_chat_members && st.group_welcome) {
      const names = m.new_chat_members.filter(u => !u.is_bot).map(u => u.first_name || 'Гость');
      if (names.length) {
        const r = await send(chatId,
          `👋 ${names.join(', ')}, добро пожаловать в <b>Bombily | ${city.name}</b>\n\nЗдесь новости и объявления. Машину вызывайте в боте — так быстрее и безопаснее.`,
          { reply_markup: { inline_keyboard: [[{ text: '🚖 Открыть Bombily', url: `https://t.me/${BOT_USERNAME}` }]] } });
        if (r && r.result) delLater(chatId, r.result.message_id, 120);
      }
    }
    return;
  }

  if (!st.group_moderate) { glog(`${city.name}: приходят сообщения, но «убирать заказы» выключено`); return; }
  const text = String(m.text || m.caption || '');
  if (!text) return;
  if (m.from && m.from.is_bot) return;

  // администраторов группы не трогаем
  try {
    const cm = await tg('getChatMember', { chat_id: chatId, user_id: m.from.id });
    if (cm && cm.ok && ['creator', 'administrator'].includes(cm.result.status)) {
      glog(`${city.name}: писал администратор — пропускаем · «${preview}»`);
      return;
    }
  } catch (e) {}

  const isOrder = looksLikeOrder(text);
  const isReply = !isOrder && looksLikeDriverReply(text);
  if (!isOrder && !isReply) { glog(`${city.name}: не похоже на заказ · «${preview}»`); return; }

  const del = await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id });
  if (del && del.ok) glog(`${city.name}: УДАЛЕНО · «${preview}»`);
  else glog(`${city.name}: удалить не вышло (${del && del.description ? del.description : 'нет прав?'}) · «${preview}»`);

  // не частим с ответами: не чаще раза в минуту на группу
  const last = groupReplyAt.get(chatId) || 0;
  if (Date.now() - last < 60 * 1000) return;
  groupReplyAt.set(chatId, Date.now());

  const name = m.from && m.from.first_name ? m.from.first_name : '';
  const txtOrder = `🚖 ${name ? name + ', з' : 'З'}аказы такси — в боте Bombily, а не в чате.\n\nТам заявку сразу видят все свободные водители, и вы выбираете цену. Ваш номер и адрес не видит никто, кроме того, кто взял заказ.`;
  const txtReply = `🚗 ${name ? name + ', з' : 'З'}аказы принимаются только в боте Bombily.\n\nТам видно все свободные заявки, а поездка засчитается в ваш рейтинг. Договариваться в чате нельзя.`;
  const r = await send(chatId, isReply ? txtReply : txtOrder,
    { reply_markup: { inline_keyboard: [[{ text: isReply ? '🚗 Смотреть заявки' : '🚖 Вызвать машину', url: `https://t.me/${BOT_USERNAME}` }]] } });
  if (r && r.result) delLater(chatId, r.result.message_id, 90);
}


/* ================= живой закреп в группе ================= */

// местное время (Донбасс, UTC+3)
function localHour() {
  return new Date(Date.now() + 3 * 3600 * 1000).getUTCHours();
}
function localTimeStr() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function dayStartISO() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString();
}

// склонения
function plural(n, forms) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

// пороги: ниже них строку не показываем, чтобы не выглядеть пусто
const PIN_MIN = { intercity: 2, rides: 5, waitRides: 10 };

async function cityStats(city) {
  const out = { online: 0, delivery: 0, intercity: 0, ridesToday: 0, wait: null };
  const [{ count: online }, { count: deliv }, { count: inter }, { count: rides }] = await Promise.all([
    db.from('users').select('*', { count: 'exact', head: true })
      .eq('city', city).eq('status', 'online').in('role', ['driver', 'both']),
    db.from('users').select('*', { count: 'exact', head: true })
      .eq('city', city).eq('status', 'online').eq('delivery', true),
    db.from('users').select('*', { count: 'exact', head: true })
      .eq('city', city).eq('status', 'online').eq('intercity', true),
    db.from('rides').select('*', { count: 'exact', head: true })
      .eq('city', city).eq('status', 'completed').gte('created_at', dayStartISO())
  ]);
  out.online = online || 0; out.delivery = deliv || 0;
  out.intercity = inter || 0; out.ridesToday = rides || 0;

  // среднее ожидание: от заявки до подтверждения, за неделю
  try {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: rs } = await db.from('rides').select('created_at,confirmed_at')
      .eq('city', city).not('confirmed_at', 'is', null).gte('created_at', weekAgo).limit(300);
    const arr = (rs || []).map(r => (new Date(r.confirmed_at) - new Date(r.created_at)) / 60000)
      .filter(v => v > 0 && v < 120);
    if (arr.length >= PIN_MIN.waitRides) {
      out.wait = Math.max(1, Math.round(arr.reduce((a, b) => a + b, 0) / arr.length));
    }
  } catch (e) {}   // колонки может не быть — тогда просто не показываем ожидание
  return out;
}

function pinText(city, s) {
  const head = `🚖 <b>Bombily | ${city}</b>`;
  const foot = `\n\n👇 Заказы принимаются только в боте`;
  const h = localHour();

  // ночь: цифры прячем, «0 водителей» в три часа выглядит как поломка
  if (h >= 1 && h < 6) {
    return `${head}\n\n🌙 Ночью водители выходят по заявке.\n\nОставьте заказ в боте — он придёт всем, кто работает ночью, даже если сейчас никого нет на линии.${foot}`;
  }

  // никого на линии: вместо нулей — чем мы полезны
  if (!s.online) {
    return `${head}\n\nВызов машины в два касания — без диспетчера и наценок.\n\n• Цену обсуждаете сами с водителем\n• Свои водители, с правами и техпаспортом\n• Доставка посылок и межгород${foot}`;
  }

  const lines = [`🟢 <b>На линии:</b> ${s.online} ${plural(s.online, ['водитель', 'водителя', 'водителей'])}`];
  if (s.delivery > 0) lines.push(`📦 Доставка: ${s.delivery} ${plural(s.delivery, ['курьер', 'курьера', 'курьеров'])}`);
  if (s.intercity >= PIN_MIN.intercity) lines.push(`🛣 Межгород: ${s.intercity} ${plural(s.intercity, ['водитель', 'водителя', 'водителей'])}`);
  if (s.wait) lines.push(`⏱ Ожидание: ~${s.wait} ${plural(s.wait, ['минута', 'минуты', 'минут'])}`);
  if (s.ridesToday >= PIN_MIN.rides) lines.push(`\n🚖 Сегодня выполнено: ${s.ridesToday} ${plural(s.ridesToday, ['поездка', 'поездки', 'поездок'])}`);

  const tail = s.ridesToday >= PIN_MIN.rides ? '' : '\n\nЦену обсуждаете сами, наценок нет.';
  return `${head}\n\n${lines.join('\n')}${tail}${foot}\n<i>обновлено в ${localTimeStr()}</i>`;
}

async function updatePin(city) {
  const kb = { inline_keyboard: [[{ text: '🚖 Вызвать машину', url: `https://t.me/${BOT_USERNAME}` }]] };
  const s = await cityStats(city.name);
  const text = pinText(city.name, s);

  const { data: pin } = await db.from('group_pins').select('*').eq('city_name', city.name).maybeSingle();

  // текст не изменился — ничего не трогаем
  if (pin && pin.message_id && pin.last_text === text) return;

  if (pin && pin.message_id) {
    const r = await tg('editMessageText', {
      chat_id: city.group_id, message_id: pin.message_id,
      text, parse_mode: 'HTML', reply_markup: kb
    });
    if (r && r.ok) {
      await db.from('group_pins').update({ last_text: text, updated_at: new Date().toISOString() })
        .eq('city_name', city.name);
      return;
    }
    // сообщение не найдено или удалено — создадим заново
    if (r && r.description && /not found|message to edit|MESSAGE_ID_INVALID/i.test(r.description)) {
      await db.from('group_pins').delete().eq('city_name', city.name);
    } else {
      return;  // прочая ошибка — не плодим сообщения
    }
  }

  const sent = await tg('sendMessage', {
    chat_id: city.group_id, text, parse_mode: 'HTML',
    reply_markup: kb, disable_notification: true
  });
  if (!sent || !sent.ok) { glog(`${city.name}: закреп не отправился — ${sent && sent.description ? sent.description : 'нет ответа'}`); return; }
  const mid = sent.result.message_id;
  await tg('pinChatMessage', { chat_id: city.group_id, message_id: mid, disable_notification: true });
  await db.from('group_pins').upsert({
    city_name: city.name, chat_id: city.group_id, message_id: mid,
    last_text: text, updated_at: new Date().toISOString()
  });
  glog(`${city.name}: закреп создан`);
}

async function pinLoop() {
  let mins = 5;
  try {
    const { data: st } = await db.from('settings').select('pin_enabled,pin_minutes').eq('id', 1).maybeSingle();
    if (st && st.pin_minutes) mins = Math.max(2, Number(st.pin_minutes));
    if (st && st.pin_enabled) {
      const { data: cities } = await db.from('cities').select('name,group_id').not('group_id', 'is', null);
      for (const c of cities || []) {
        try { await updatePin(c); } catch (e) { glog(`${c.name}: закреп — ${e.message}`); }
      }
    }
  } catch (e) { console.error('pinLoop', e.message); }
  setTimeout(pinLoop, mins * 60 * 1000);
}


/* ================= рассылка ================= */

// кому пойдёт сообщение
async function audienceQuery(audience, city) {
  let q = db.from('users').select('id,telegram_id,name').not('telegram_id', 'is', null).eq('no_broadcast', false);
  if (city && city !== 'all') q = q.eq('city', city);
  if (audience === 'drivers') q = q.eq('driver_status', 'approved');
  if (audience === 'passengers') q = q.not('driver_status', 'eq', 'approved');
  const { data } = await q.limit(5000);
  let list = data || [];

  // «ни разу не заказывал» и «заказывал» считаем по заявкам
  if (audience === 'never' || audience === 'ordered') {
    const { data: rides } = await db.from('rides').select('passenger_id').limit(20000);
    const made = new Set((rides || []).map(r => r.passenger_id).filter(Boolean));
    list = list.filter(u => audience === 'never' ? !made.has(u.id) : made.has(u.id));
  }
  return list;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runBroadcast(id) {
  try {
    const { data: b } = await db.from('broadcasts').select('*').eq('id', id).maybeSingle();
    if (!b || b.status === 'done') return;
    await db.from('broadcasts').update({ status: 'running' }).eq('id', id);

    const list = await audienceQuery(b.audience, b.city);
    await db.from('broadcasts').update({ total: list.length }).eq('id', id);

    const kb = b.btn_text && b.btn_url
      ? { reply_markup: { inline_keyboard: [[{ text: b.btn_text, url: b.btn_url }]] } }
      : {};

    let sent = 0, failed = 0, blocked = 0;
    for (const u of list) {
      const r = await tg('sendMessage', {
        chat_id: u.telegram_id, text: b.text, parse_mode: 'HTML',
        disable_web_page_preview: true, ...kb
      });
      if (r && r.ok) sent++;
      else {
        const d = String(r && r.description || '');
        if (/blocked|deactivated|chat not found|user is deactivated/i.test(d)) {
          blocked++;
          await db.from('users').update({ no_broadcast: true }).eq('id', u.id);
        } else failed++;
      }
      // бережём лимиты телеграма
      await sleep(60);
      if ((sent + failed + blocked) % 20 === 0) {
        await db.from('broadcasts').update({ sent, failed, blocked }).eq('id', id);
      }
    }
    await db.from('broadcasts').update({
      sent, failed, blocked, status: 'done', finished_at: new Date().toISOString()
    }).eq('id', id);
  } catch (e) {
    console.error('broadcast', e.message);
    await db.from('broadcasts').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', id);
  }
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
  if (!data) return null;
  // подхватываем ник телеграма при любом входе — чтобы была связь без переписки с ботом
  if (tgUser.username && data.tg_username !== tgUser.username) {
    db.from('users').update({ tg_username: tgUser.username }).eq('id', data.id).then(() => {}, () => {});
    data.tg_username = tgUser.username;
  }
  // аватар из Telegram — сохраняем в закрытое хранилище
  if (tgUser.photo_url) {
    db.from('contacts').upsert({ user_id: data.id, photo_url: tgUser.photo_url, updated_at: new Date().toISOString() })
      .then(() => {}, () => {});
  }
  return data;
}

const phoneOf = async uid => {
  if (!uid) return null;
  const { data } = await db.from('contacts').select('phone').eq('user_id', uid).maybeSingle();
  return data ? data.phone : null;
};

// карточка контактов пользователя для сообщения в бот
const contactCard = async (uid, label) => {
  if (!uid) return '';
  const { data: u } = await db.from('users').select('name,tg_username,car,plate,rating').eq('id', uid).maybeSingle();
  if (!u) return '';
  const phone = await phoneOf(uid);
  let s = `\n\n<b>${label}:</b> ${u.name || '—'}`;
  if (u.car) s += `\n🚗 ${u.car}${u.plate ? ' · ' + u.plate : ''}`;
  if (phone) s += `\n📞 <a href="tel:${phone}">${phone}</a>`;
  if (u.tg_username) s += `\n✈️ @${u.tg_username}`;
  else s += `\n✈️ ник не указан — пишите в чате приложения`;
  return s;
};

// путь в хранилище из сохранённого значения (старые записи содержат полный URL)
const docPath = v => {
  if (!v) return null;
  const i = v.indexOf('/docs/');
  if (i !== -1) return v.slice(i + 6);
  return v.replace(/^\/+/, '');
};

// уведомить всю модерацию (владелец, админы, модераторы)
const notifyStaff = async (text, kb) => {
  const { data: staff } = await db.from('users').select('telegram_id')
    .in('staff_role', ['owner', 'admin', 'moderator']);
  const ids = new Set((staff || []).map(s => s.telegram_id).filter(Boolean));
  if (OWNER) ids.add(OWNER);
  for (const id of ids) await send(id, text, kb || {});
};

// аватар через Bot API, если из приложения он не пришёл
async function saveTgPhoto(fileId, ownerId) {
  try {
    const f = await tg('getFile', { file_id: fileId });
    if (!f || !f.ok || !f.result || !f.result.file_path) return null;
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const path = `support/${ownerId}_${Date.now()}.jpg`;
    const up = await db.storage.from('docs').upload(path, buf, { contentType: 'image/jpeg', upsert: true });
    if (up.error) return null;
    return path;
  } catch (e) { return null; }
}
async function fetchAvatar(userId) {
  try {
    const { data: u } = await db.from('users').select('telegram_id').eq('id', userId).maybeSingle();
    if (!u || !u.telegram_id) return { path: null, why: 'нет telegram id' };
    const ph = await tg('getUserProfilePhotos', { user_id: u.telegram_id, limit: 1 });
    if (!ph || !ph.ok) return { path: null, why: 'телеграм отказал: ' + ((ph && ph.description) || 'нет ответа') };
    const sizes = ph.result && ph.result.photos && ph.result.photos[0];
    if (!sizes || !sizes.length) return { path: null, why: 'фото не установлено или скрыто' };
    const fileId = sizes[sizes.length - 1].file_id;
    const f = await tg('getFile', { file_id: fileId });
    if (!f || !f.ok || !f.result || !f.result.file_path) return { path: null, why: 'не удалось получить файл' };
    const url = `https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`;
    const r = await fetch(url);
    if (!r.ok) return { path: null, why: 'файл не скачался (' + r.status + ')' };
    const buf = Buffer.from(await r.arrayBuffer());
    const path = `${userId}/avatar.jpg`;
    const up = await db.storage.from('docs').upload(path, buf, { contentType: 'image/jpeg', upsert: true });
    if (up.error) return { path: null, why: 'хранилище: ' + up.error.message };
    await db.from('contacts').upsert({ user_id: userId, photo_path: path, updated_at: new Date().toISOString() });
    return { path, why: null };
  } catch (e) { return { path: null, why: 'сбой: ' + e.message }; }
}
const isStaff = u => u && ['owner', 'admin', 'moderator'].includes(u.staff_role);
const isAdminUp = u => u && ['owner', 'admin'].includes(u.staff_role);

const notifyErrors = {};

// человеческие названия полей для журнала
const FIELD_RU = {
  name: 'имя', full_name: 'ФИО', admin_note: 'пометка', phone: 'телефон', age: 'возраст',
  spot: 'место стоянки', rating: 'рейтинг', role: 'роль', driver_status: 'статус водителя',
  balance: 'баланс', car: 'машина', plate: 'госномер', city: 'город', is_banned: 'блокировка',
  staff_role: 'права', delivery: 'доставка', intercity: 'межгород', sub_until: 'подписка'
};
const VAL_RU = {
  passenger: 'пассажир', driver: 'водитель', both: 'водитель и пассажир',
  approved: 'одобрен', pending: 'на проверке', none: 'нет', rejected: 'отклонён',
  owner: 'владелец', admin: 'админ', moderator: 'модератор',
  true: 'да', false: 'нет', null: 'пусто', '': 'пусто'
};
const showVal = v => {
  if (v === null || v === undefined || v === '') return 'пусто';
  const k = String(v);
  return VAL_RU[k] !== undefined ? VAL_RU[k] : k;
};

async function audit(me, action, tid, targetName, details) {
  try {
    await db.from('audit_log').insert({
      actor_id: me.id, actor_name: me.name, actor_role: me.staff_role || 'staff',
      action, target_id: tid || null, target_name: targetName || null,
      details: details ? String(details).slice(0, 1000) : null
    });
  } catch (e) {}
}

const rateMap = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of rateMap) if (t - v.t > 300000) rateMap.delete(k); }, 300000);

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
  if (req.method === 'GET' && req.url.includes('group')) {
    // подробная проверка настройки групп
    const out = { ok: true, шаги: [] };
    try {
      const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
      if (!st) out.шаги.push('❌ настройки не читаются');
      else if (st.group_moderate === undefined)
        out.шаги.push('❌ db-40-group.sql НЕ выполнен — колонок нет');
      else {
        out.шаги.push('✅ db-40-group.sql выполнен');
        out.шаги.push((st.community_enabled ? '✅' : '❌') + ' тумблер «Группы городов»: ' + (st.community_enabled ? 'включён' : 'ВЫКЛЮЧЕН'));
        out.шаги.push((st.group_moderate ? '✅' : '❌') + ' тумблер «Убирать заказы из чата»: ' + (st.group_moderate ? 'включён' : 'ВЫКЛЮЧЕН'));
      }
    } catch (e) { out.шаги.push('❌ настройки: ' + e.message); }

    try {
      const { data: cs } = await db.from('cities').select('name,group_id,group_link,active');
      const withId = (cs || []).filter(c => c.group_id);
      if (!withId.length) out.шаги.push('❌ ни у одного города не указан ID группы');
      for (const c of withId) {
        out.шаги.push(`— город ${c.name}, ID ${c.group_id}${c.active ? '' : ' (город выключен!)'}`);
        try {
          const me2 = await tg('getMe');
          const botId = me2 && me2.result ? me2.result.id : null;
          const chat = await tg('getChat', { chat_id: c.group_id });
          if (!chat || !chat.ok) { out.шаги.push(`   ❌ бот не видит эту группу: ${chat && chat.description ? chat.description : 'нет ответа'}`); continue; }
          out.шаги.push(`   ✅ группа найдена: ${chat.result.title}`);
          if (botId) {
            const cm = await tg('getChatMember', { chat_id: c.group_id, user_id: botId });
            if (!cm || !cm.ok) { out.шаги.push('   ❌ бота нет в группе'); continue; }
            const s = cm.result.status;
            out.шаги.push(s === 'administrator' ? '   ✅ бот администратор' : `   ❌ бот НЕ администратор (${s})`);
            if (s === 'administrator') {
              out.шаги.push((cm.result.can_delete_messages ? '   ✅' : '   ❌') + ' право удалять сообщения: ' + (cm.result.can_delete_messages ? 'есть' : 'НЕТ'));
            }
          }
        } catch (e) { out.шаги.push('   ❌ ' + e.message); }
      }
    } catch (e) { out.шаги.push('❌ города: ' + e.message); }

    out.последние_события = groupLog.length ? groupLog : 'из групп сообщений не приходило — скорее всего не выключен Group Privacy у @BotFather, либо бот не переподключён после этого';
    return json(res, 200, out);
  }

  if (req.method === 'GET') return json(res, 200, {
    ok: true, service: 'bombily-backend', version: 'v48-group-id',
    notify_errors: Object.keys(notifyErrors).length ? notifyErrors : 'нет ошибок',
    group_log: groupLog.length ? groupLog : 'из групп сообщений не приходило'
  });

  const body = await readBody(req);
  const me = await userFromInit(body.initData || '');
  if (!me) return json(res, 401, { error: 'auth' });
  if (me.is_banned) return json(res, 403, { error: 'banned' });

  // простая защита от спама: не больше 40 запросов в минуту с аккаунта
  const rlKey = String(me.id);
  const nowMs = Date.now();
  const bucket = rateMap.get(rlKey) || { n: 0, t: nowMs };
  if (nowMs - bucket.t > 60000) { bucket.n = 0; bucket.t = nowMs; }
  bucket.n++;
  rateMap.set(rlKey, bucket);
  if (bucket.n > 40) return json(res, 429, { error: 'too_many' });

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

    // --- сохранить свой телефон ---
    if (req.url === '/api/set-phone') {
      const phone = String(body.phone || '').trim().slice(0, 30);
      const pd = phone.replace(/\D/g, '');
      if (!(pd.length === 11 && (pd[0] === '7' || pd[0] === '8'))) return json(res, 400, { error: 'bad_phone' });
      await db.from('contacts').upsert({ user_id: me.id, phone, updated_at: new Date().toISOString() });
      await db.from('users').update({ has_phone: true }).eq('id', me.id);
      return json(res, 200, { ok: true, phone });
    }

    // --- свои личные данные (телефон, ФИО, сохранённые адреса) ---
    if (req.url === '/api/my-phone' || req.url === '/api/my-private') {
      const { data: c } = await db.from('contacts').select('phone,full_name,places').eq('user_id', me.id).maybeSingle();
      return json(res, 200, { ok: true, phone: c ? c.phone : null, full_name: c ? c.full_name : null, places: c ? c.places : null });
    }

    // --- сохранить свои адреса ---
    if (req.url === '/api/save-places') {
      let arr;
      try { arr = JSON.parse(body.places || '[]'); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr = arr.slice(0, 20).map(x => String(x).slice(0, 120));
      await db.from('contacts').upsert({ user_id: me.id, places: JSON.stringify(arr), updated_at: new Date().toISOString() });
      return json(res, 200, { ok: true, places: JSON.stringify(arr) });
    }

    // --- телефон второй стороны по активной поездке ---
    if (req.url === '/api/ride-contact') {
      const { data: r } = await db.from('rides').select('passenger_id,driver_id,status').eq('id', body.ride_id).maybeSingle();
      if (!r) return json(res, 404, { error: 'no_ride' });
      const iAmPassenger = r.passenger_id === me.id;
      const iAmDriver = r.driver_id === me.id;
      if (!iAmPassenger && !iAmDriver) return json(res, 403, { error: 'not_yours' });
      // контакты доступны только пока заказ в работе
      if (!['confirmed', 'in_progress'].includes(r.status)) return json(res, 400, { error: 'not_active' });
      const other = iAmPassenger ? r.driver_id : r.passenger_id;
      return json(res, 200, { ok: true, phone: await phoneOf(other) });
    }

    // --- свои машины ---
    if (req.url === '/api/cars-list') {
      const { data } = await db.from('cars').select('*').eq('user_id', me.id).order('created_at');
      return json(res, 200, { ok: true, items: data || [] });
    }

    if (req.url === '/api/car-add') {
      const brand = String(body.brand || '').trim().slice(0, 60);
      const plate = String(body.plate || '').trim().toUpperCase().slice(0, 15);
      const kind = body.kind === 'moto' ? 'moto' : 'car';
      if (!brand || !plate) return json(res, 400, { error: 'bad_input' });
      // мотоцикл — достаточно прав, машина — права, техпаспорт и фото с номером
      if (!body.doc_license) return json(res, 400, { error: 'need_docs' });
      if (kind === 'car' && (!body.photo || !body.doc_pts)) return json(res, 400, { error: 'need_docs' });
      const { count } = await db.from('cars').select('*', { count: 'exact', head: true }).eq('user_id', me.id);
      if ((count || 0) >= 5) return json(res, 400, { error: 'too_many' });
      const ins = await db.from('cars').insert({ user_id: me.id, brand, plate, kind,
        photo: body.photo || null, doc_pts: body.doc_pts || null, doc_license: body.doc_license, approved: false });
      if (ins.error) return json(res, 400, { error: ins.error.message });
      try {
        await notifyStaff(`${kind === 'moto' ? '🏍' : '🚙'} <b>Новый транспорт на проверку</b>\n${me.name}\n${brand} · ${plate}${kind === 'moto' ? '\n(мотоцикл — только доставка)' : ''}`,
          { reply_markup: { inline_keyboard: [[wa('Открыть панель', 'admin')]] } });
      } catch (e) { console.error('notifyStaff car-add', e.message); }
      return json(res, 200, { ok: true });
    }

    if (req.url === '/api/car-activate') {
      const { data: c } = await db.from('cars').select('*').eq('id', body.car_id).maybeSingle();
      if (!c || c.user_id !== me.id) return json(res, 403, { error: 'not_yours' });
      if (!c.approved) return json(res, 400, { error: 'not_approved' });
      await db.from('cars').update({ is_active: false }).eq('user_id', me.id);
      await db.from('cars').update({ is_active: true }).eq('id', c.id);
      const isMoto = c.kind === 'moto';
      const upd = { car: c.brand, plate: c.plate, vehicle_type: isMoto ? 'moto' : 'car' };
      if (isMoto) { upd.delivery = true; upd.intercity = false; }
      if (me.role === 'passenger') upd.role = 'both';
      await db.from('users').update(upd).eq('id', me.id);
      return json(res, 200, { ok: true, brand: c.brand, plate: c.plate, kind: c.kind || 'car' });
    }

    if (req.url === '/api/car-delete') {
      const { data: c } = await db.from('cars').select('*').eq('id', body.car_id).maybeSingle();
      if (!c || c.user_id !== me.id) return json(res, 403, { error: 'not_yours' });
      await db.from('cars').delete().eq('id', c.id);
      if (c.is_active) {
        const { data: rest } = await db.from('cars').select('*').eq('user_id', me.id).eq('approved', true).limit(1);
        if (rest && rest.length) {
          await db.from('cars').update({ is_active: true }).eq('id', rest[0].id);
          await db.from('users').update({ car: rest[0].brand, plate: rest[0].plate }).eq('id', me.id);
        } else {
          await db.from('users').update({ car: null, plate: null, status: 'offline' }).eq('id', me.id);
        }
      }
      return json(res, 200, { ok: true });
    }

    // --- написать в поддержку из приложения ---
    if (req.url === '/api/support-send') {
      const txt = String(body.text || '').trim().slice(0, 2000);
      if (!txt && !body.photo) return json(res, 400, { error: 'empty' });
      let supportId = null;
      try {
        const ins = await db.from('support_msgs').insert({
          from_tg: me.telegram_id, from_name: me.name,
          from_username: me.tg_username || null,
          from_user: me.id, text: txt || '(фото)', photo: body.photo || null
        }).select().single();
        if (ins.data) supportId = ins.data.id;
      } catch (e) { return json(res, 500, { error: 'db' }); }

      let photoUrl = null;
      if (body.photo) {
        const { data: sg } = await db.storage.from('docs').createSignedUrl(body.photo, 3600);
        if (sg && sg.signedUrl) photoUrl = sg.signedUrl;
      }
      const head = `📨 <b>Сообщение в поддержку</b>\nОт: ${me.name}${me.tg_username ? ' @' + me.tg_username : ''} (ID ${me.telegram_id})\n\n${txt}\n\n<i>Нажмите «Ответить» ниже.</i>`;
      try {
        const { data: staff } = await db.from('users').select('telegram_id').in('staff_role', ['owner', 'admin', 'moderator']);
        const ids = new Set((staff || []).map(s => s.telegram_id).filter(Boolean));
        if (OWNER) ids.add(Number(OWNER));
        for (const sid of ids) {
          const kb2 = { reply_markup: { inline_keyboard: [
            [{ text: '✍️ Ответить', callback_data: `rep:${me.telegram_id}:${supportId || 0}` }],
            [wa('Открыть панель', 'admin')]
          ] } };
          let sent;
          if (photoUrl) sent = await tg('sendPhoto', { chat_id: sid, photo: photoUrl, caption: head, parse_mode: 'HTML', reply_markup: kb2.reply_markup });
          else sent = await send(sid, head, kb2);
          const mid = sent && sent.result && sent.result.message_id;
          if (mid) {
            fwdMap.set(mid, me.telegram_id);
            await db.from('bot_replies').insert({ message_id: mid, staff_tg: sid, target_tg: me.telegram_id, support_id: supportId });
          }
        }
      } catch (e) { console.error('support-send notify', e.message); }
      return json(res, 200, { ok: true });
    }

    // --- городское сообщество ---
    if (req.url === '/api/community') {
      try {
        const { data: st } = await db.from('settings').select('community_enabled').eq('id', 1).maybeSingle();
        if (!st || !st.community_enabled) return json(res, 200, { ok: true, city: null, off: true });
      } catch (e) {}
      const cityName = String(body.city || me.city || '').trim();
      if (!cityName) return json(res, 200, { ok: true, city: null });
      const { data: c } = await db.from('cities').select('*').eq('name', cityName).maybeSingle();
      if (!c) return json(res, 200, { ok: true, city: null });
      let member = null;
      if (c.group_id && me.telegram_id) {
        try {
          const r = await tg('getChatMember', { chat_id: c.group_id, user_id: me.telegram_id });
          if (r && r.ok && r.result) {
            member = !['left', 'kicked'].includes(r.result.status);
          }
        } catch (e) {}
      }
      return json(res, 200, { ok: true, city: {
        name: c.name, link: c.group_link, description: c.description, member
      } });
    }

    // отметить, что предложение о вступлении показано
    if (req.url === '/api/community-seen') {
      await db.from('users').update({ community_seen: String(body.city || '').slice(0, 60) }).eq('id', me.id);
      return json(res, 200, { ok: true });
    }

    // --- подача заявки в водители (сам пользователь) ---
    if (req.url === '/api/apply-driver') {
      const phone = String(body.phone || '').slice(0, 30);
      const pd2 = phone.replace(/\D/g, '');
      if (!(pd2.length === 11 && (pd2[0] === '7' || pd2[0] === '8'))) return json(res, 400, { error: 'bad_phone' });
      const fullName = String(body.full_name || '').trim().slice(0, 120);
      if (fullName.split(/\s+/).filter(Boolean).length < 2) return json(res, 400, { error: 'bad_name' });
      if (me.driver_status === 'approved') return json(res, 400, { error: 'already' });
      const vType = body.vehicle_type === 'moto' ? 'moto' : 'car';
      const { data: docs } = await db.from('users').select('doc_license,doc_pts,doc_car').eq('id', me.id).maybeSingle();
      if (vType === 'moto') {
        if (!docs || !docs.doc_license) return json(res, 400, { error: 'need_docs' });
      } else {
        if (!docs || !docs.doc_license || !docs.doc_pts || !docs.doc_car) return json(res, 400, { error: 'need_docs' });
      }
      await db.from('contacts').upsert({ user_id: me.id, phone, full_name: fullName, updated_at: new Date().toISOString() });
      const carDecl = String(body.car || '').trim().slice(0, 60);
      const plateDecl = String(body.plate || '').trim().toUpperCase().slice(0, 15);
      if (!carDecl || !plateDecl) return json(res, 400, { error: 'need_car' });
      const updApply = { has_phone: true, driver_status: 'pending', vehicle_type: vType, car: carDecl, plate: plateDecl };
      if (vType === 'moto') { updApply.delivery = true; updApply.intercity = false; }
      await db.from('users').update(updApply).eq('id', me.id);
      // заявленный транспорт — на проверку вместе с заявкой
      try {
        const { data: ex } = await db.from('cars').select('id').eq('user_id', me.id).limit(1);
        if (!ex || !ex.length) {
          await db.from('cars').insert({ user_id: me.id, brand: carDecl, plate: plateDecl, kind: vType, approved: false, is_active: false });
        }
      } catch (e) {}
      try {
        await notifyStaff(`${vType === 'moto' ? '🏍' : '🚗'} <b>Новая заявка${vType === 'moto' ? ' (мотокурьер)' : ' в водители'}</b>\n${me.name}\n📞 ${phone}\n${vType === 'moto' ? '🏍' : '🚗'} ${carDecl} · ${plateDecl}\n\nФИО и документы — в панели.`,
          { reply_markup: { inline_keyboard: [[wa('Открыть заявки', 'admin')]] } });
      } catch (e) { console.error('notifyStaff apply', e.message); }
      return json(res, 200, { ok: true });
    }

    // --- чат: список сообщений (только участники поездки) ---
    if (req.url === '/api/chat-list') {
      const { data: r } = await db.from('rides').select('passenger_id,driver_id').eq('id', body.ride_id).maybeSingle();
      if (!r) return json(res, 404, { error: 'no_ride' });
      if (r.passenger_id !== me.id && r.driver_id !== me.id) return json(res, 403, { error: 'not_yours' });
      let q = db.from('messages').select('*').eq('ride_id', body.ride_id).order('created_at');
      if (body.after) q = q.gt('created_at', body.after);
      const { data } = await q;
      return json(res, 200, { ok: true, items: data || [] });
    }

    // --- чат: отправка сообщения ---
    if (req.url === '/api/chat-send') {
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return json(res, 400, { error: 'empty' });
      const { data: r } = await db.from('rides').select('passenger_id,driver_id,status').eq('id', body.ride_id).maybeSingle();
      if (!r) return json(res, 404, { error: 'no_ride' });
      if (r.passenger_id !== me.id && r.driver_id !== me.id) return json(res, 403, { error: 'not_yours' });
      const { data: ins } = await db.from('messages')
        .insert({ ride_id: body.ride_id, sender_id: me.id, sender_name: me.name, text })
        .select().single();
      return json(res, 200, { ok: true, msg: ins });
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
      const isReview = body.kind === 'review';
      await db.from('complaints').insert({
        from_id: me.id, from_name: me.name,
        target_id: body.target_id || me.id, target_name: body.target_name || me.name,
        reason: String(body.reason || '').slice(0, 200),
        comment: String(body.comment || '').slice(0, 500),
        review_id: body.review_id || null,
        kind: body.kind || 'user'
      });
      try {
        await notifyStaff(
          `${isReview ? '📝' : '⚠️'} <b>${isReview ? 'Спор по отзыву' : 'Новая жалоба'}</b>\nОт: ${me.name}${isReview ? '' : `\nНа: ${body.target_name || '—'}`}\nПричина: ${String(body.reason || '').slice(0, 200)}`,
          { reply_markup: { inline_keyboard: [[wa('Открыть панель', 'admin')]] } });
      } catch (e) { console.error('notifyStaff complaint', e.message); }
      return json(res, 200, { ok: true });
    }

    // --- админские операции (только staff) ---
    if (req.url === '/api/admin') {
      if (!isStaff(me)) return json(res, 403, { error: 'forbidden' });
      const act = body.action;
      const tid = body.target_id;
      const iAmOwner = me.staff_role === 'owner' || String(me.telegram_id) === String(OWNER);

      // владельца нельзя трогать никому, кроме него самого
      let targetUser = null;
      if (tid) {
        const { data: tu } = await db.from('users').select('staff_role,name,telegram_id').eq('id', tid).maybeSingle();
        targetUser = tu || null;
        const targetIsOwner = tu && (tu.staff_role === 'owner' || String(tu.telegram_id) === String(OWNER));
        if (targetIsOwner && !iAmOwner) return json(res, 403, { error: 'owner_protected' });
      }

      // запись в журнал — всё, кроме чтения
      const readOnly = new Set(['promo-list','support-list','support-count','winback-list','cars-of-user',
        'cars-pending','cars-pending-list','doc-urls','user-phone','apps-phones','admin-counts','stats',
        'drivers-stats','days-stats','user-search','avatars','avatar-fetch',
        'audit-list','audit-actors','activity','broadcast-count','broadcast-list','rides-stats',
        'city-list','group-check']);
      const customLog = new Set(['edit-user', 'adjust-balance', 'driver-status', 'ban', 'car-edit']);
      if (!readOnly.has(act) && !customLog.has(act)) {
        const clean = {};
        Object.keys(body || {}).forEach(k => {
          if (k === 'initData' || k === 'action' || k === 'photo') return;
          const v = body[k];
          if (v === null || v === undefined || v === '') return;
          clean[k] = typeof v === 'string' ? v.slice(0, 200) : v;
        });
        db.from('audit_log').insert({
          actor_id: me.id, actor_name: me.name, actor_role: me.staff_role || 'staff',
          action: act, target_id: tid || null,
          target_name: targetUser ? targetUser.name : null,
          details: Object.keys(clean).length ? JSON.stringify(clean).slice(0, 1000) : null
        }).then(() => {}, () => {});
      }

      if (act === 'adjust-balance' && isAdminUp(me)) {
        await audit(me, 'adjust-balance', tid, targetUser ? targetUser.name : null,
          `${Number(body.amount) > 0 ? 'начислил +' : 'списал '}${body.amount} ₽${body.note ? ' · ' + body.note : ''}`);
        const { data: u } = await db.from('users').select('balance,name').eq('id', tid).single();
        await db.from('users').update({ balance: (Number(u.balance) || 0) + Number(body.amount) }).eq('id', tid);
        await db.from('payments').insert({ user_id: tid, user_name: u.name, amount: Number(body.amount), kind: 'adjust', note: body.note || 'админ' });
        return json(res, 200, { ok: true });
      }
      if (act === 'ban') {
        if (!isAdminUp(me)) return json(res, 403, { error: 'forbidden' });
        await audit(me, 'ban', tid, targetUser ? targetUser.name : null,
          body.value ? 'заблокировал' : 'разблокировал');
        await db.from('users').update({ is_banned: !!body.value, status: 'offline' }).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'set-role') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        const allowedRoles = ['admin', 'moderator', 'none'];
        if (!allowedRoles.includes(body.role)) return json(res, 400, { error: 'bad_role' });
        await db.from('users').update({ staff_role: body.role }).eq('id', tid);
        return json(res, 200, { ok: true });
      }
      if (act === 'driver-status') {
        if (!isAdminUp(me)) return json(res, 403, { error: 'forbidden' });
        await audit(me, 'driver-status', tid, targetUser ? targetUser.name : null,
          body.status === 'approved'
            ? `одобрил водителем${body.car ? ' · ' + body.car + (body.plate ? ' ' + body.plate : '') : ''}`
            : (body.revoke ? 'снял права водителя' : 'отклонил заявку'));
        const upd = { driver_status: body.status };
        // администратор мог поправить данные заявки
        if (body.name) upd.name = String(body.name).slice(0, 60);
        if (body.full_name !== undefined && body.full_name !== null) {
          await db.from('contacts').upsert({ user_id: tid, full_name: String(body.full_name).slice(0, 120), updated_at: new Date().toISOString() });
        }
        if (body.phone) {
          const pdg = String(body.phone).replace(/\D/g, '');
          if (pdg.length === 11) {
            await db.from('contacts').upsert({ user_id: tid, phone: String(body.phone).slice(0, 30), updated_at: new Date().toISOString() });
            upd.has_phone = true;
          }
        }
        if (body.car !== undefined) upd.car = body.car;
        if (body.plate !== undefined) upd.plate = body.plate;
        if (body.status === 'approved') {
          upd.role = 'both';
          // одобряем заявленный транспорт
          try { await db.from('cars').update({ approved: true, is_active: true }).eq('user_id', tid); } catch (e) {}
          if (body.car && body.plate) {
            const { data: ex } = await db.from('cars').select('id').eq('user_id', tid).limit(1);
            if (!ex || !ex.length) {
              await db.from('cars').insert({ user_id: tid, brand: body.car, plate: String(body.plate).toUpperCase(), approved: true, is_active: true });
            }
          }
        }

        // снятие прав — убираем с линии и закрываем смену
        if (body.revoke || body.status === 'none') {
          upd.role = 'passenger';
          upd.status = 'offline';
          const { data: sh } = await db.from('shifts').select('*').eq('driver_id', tid).is('ended_at', null).limit(1);
          if (sh && sh.length) {
            const mins = Math.max(1, Math.round((Date.now() - new Date(sh[0].started_at)) / 60000));
            await db.from('shifts').update({ ended_at: new Date().toISOString(), minutes: mins }).eq('id', sh[0].id);
          }
          // снимаем его открытые предложения
          await db.from('offers').update({ status: 'cancelled' }).eq('driver_id', tid).eq('status', 'pending');
        }

        await db.from('users').update(upd).eq('id', tid);

        // сообщаем человеку
        const utid = await tgIdOf(tid);
        if (utid) {
          if (body.status === 'approved') {
            await send(utid, `✅ <b>Заявка одобрена</b>\nВы теперь водитель Бомбилы.${upd.car ? `\n🚗 ${upd.car}${upd.plate ? ' · ' + upd.plate : ''}` : ''}\n\nВыходите на линию и принимайте заявки.`,
              { reply_markup: { inline_keyboard: [[wa('Выйти на линию', 'driver')]] } });
          } else if (body.revoke) {
            await send(utid, `ℹ️ <b>Права водителя сняты</b>\nВы больше не можете выходить на линию. Пользоваться сервисом как пассажир по-прежнему можно.\n\nЕсли считаете это ошибкой — напишите в поддержку.`);
          } else if (body.status === 'none') {
            await send(utid, `ℹ️ <b>Заявка отклонена</b>\nПроверьте, что фотографии чёткие и на них видно госномер, права и техпаспорт, затем подайте заявку заново.`);
          }
        }
        return json(res, 200, { ok: true });
      }
      if (act === 'edit-user' && isAdminUp(me)) {
        const f = body.fields || {};
        // сравниваем со старыми значениями, чтобы записать только изменённое
        const changes = [];
        try {
          const { data: oldU } = await db.from('users').select('*').eq('id', tid).maybeSingle();
          const { data: oldC } = await db.from('contacts').select('phone,full_name').eq('user_id', tid).maybeSingle();
          for (const k of Object.keys(f)) {
            const was = (k === 'phone' || k === 'full_name')
              ? (oldC ? oldC[k] : null)
              : (oldU ? oldU[k] : null);
            const now = f[k];
            if (String(was === null || was === undefined ? '' : was) === String(now === null || now === undefined ? '' : now)) continue;
            changes.push(`${FIELD_RU[k] || k}: ${showVal(was)} → ${showVal(now)}`);
          }
        } catch (e) {}
        await audit(me, 'edit-user', tid, targetUser ? targetUser.name : null,
          changes.length ? changes.join('\n') : 'ничего не изменилось');
        const allowed = {};
        ['name','age','spot','rating','role','driver_status','balance','admin_note'].forEach(k => { if (f[k] !== undefined) allowed[k] = f[k]; });
        if (Object.keys(allowed).length) await db.from('users').update(allowed).eq('id', tid);
        if (f.full_name !== undefined) {
          await db.from('contacts').upsert({ user_id: tid, full_name: String(f.full_name || '').slice(0, 120), updated_at: new Date().toISOString() });
        }
        if (f.phone !== undefined) {
          const ph = String(f.phone || '').trim().slice(0, 30);
          if (ph) {
            await db.from('contacts').upsert({ user_id: tid, phone: ph, updated_at: new Date().toISOString() });
            await db.from('users').update({ has_phone: true }).eq('id', tid);
          } else {
            await db.from('contacts').delete().eq('user_id', tid);
            await db.from('users').update({ has_phone: false }).eq('id', tid);
          }
        }
        return json(res, 200, { ok: true });
      }
      // закрыть жалобу (staff)
      if (act === 'complaint-resolve') {
        const cid = body.complaint_id;
        if (!cid) return json(res, 400, { error: 'bad_input' });
        if (body.ban && tid) {
          await db.from('users').update({ is_banned: true, status: 'offline' }).eq('id', tid);
          const btid = await tgIdOf(tid);
          if (btid) await send(btid, `⛔ <b>Доступ закрыт</b>\nВаш аккаунт заблокирован модерацией. Если считаете это ошибкой — напишите в поддержку.`);
        }
        if (body.warn && tid) {
          const wtid = await tgIdOf(tid);
          if (wtid) await send(wtid, `⚠️ <b>Предупреждение от модерации</b>\n${String(body.text || 'На вас поступила жалоба. Пожалуйста, соблюдайте правила сервиса.').slice(0, 500)}`);
        }
        await db.from('complaints').update({ status: 'done' }).eq('id', cid);
        return json(res, 200, { ok: true });
      }

      // счётчики для значков в панели
      if (act === 'admin-counts') {
        const [{ count: apps }, { count: cmps }, { count: sup }, { count: cars }] = await Promise.all([
          db.from('users').select('*', { count: 'exact', head: true }).eq('driver_status', 'pending'),
          db.from('complaints').select('*', { count: 'exact', head: true }).in('status', ['new','pending']),
          db.from('support_msgs').select('*', { count: 'exact', head: true }).eq('answered', false),
          db.from('cars').select('*', { count: 'exact', head: true }).eq('approved', false)
        ]);
        return json(res, 200, { ok: true, apps: (apps || 0) + (cars || 0), complaints: cmps || 0, support: sup || 0 });
      }

      // очистить журнал — только владелец
      if (act === 'audit-clear') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        await db.from('audit_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        return json(res, 200, { ok: true });
      }

      // журнал действий — только владелец
      if (act === 'audit-list') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        let q = db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100);
        if (body.actor) q = q.eq('actor_id', body.actor);
        if (body.since) q = q.gte('created_at', body.since);
        const { data } = await q;
        return json(res, 200, { ok: true, items: data || [] });
      }

      // кто из персонала что делал — сводка (только владелец)
      if (act === 'audit-actors') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        const since = new Date(Date.now() - 30 * 864e5).toISOString();
        const { data } = await db.from('audit_log').select('actor_id,actor_name,actor_role').gte('created_at', since).limit(2000);
        const map = {};
        (data || []).forEach(r => {
          if (!r.actor_id) return;
          map[r.actor_id] = map[r.actor_id] || { id: r.actor_id, name: r.actor_name, role: r.actor_role, count: 0 };
          map[r.actor_id].count++;
        });
        return json(res, 200, { ok: true, items: Object.values(map).sort((a2, b2) => b2.count - a2.count) });
      }

      // обновить закреп немедленно
      if (act === 'pin-now') {
        const { data: cities } = await db.from('cities').select('name,group_id').not('group_id', 'is', null);
        if (!cities || !cities.length) return json(res, 400, { error: 'no_groups' });
        let done = 0;
        for (const c of cities) {
          try { await updatePin(c); done++; } catch (e) {}
        }
        return json(res, 200, { ok: true, done });
      }

      // ---- активность людей ----
      if (act === 'activity') {
        // все заявки: кто создавал, чем кончилось
        const { data: rides } = await db.from('rides')
          .select('passenger_id,driver_id,status,created_at').limit(20000);
        const byUser = {};
        const touch = id => (byUser[id] = byUser[id] || { made: 0, done: 0, last: null, drives: 0 });
        for (const r of rides || []) {
          if (r.passenger_id) {
            const u = touch(r.passenger_id);
            u.made++;
            if (r.status === 'completed') u.done++;
            if (!u.last || r.created_at > u.last) u.last = r.created_at;
          }
          if (r.driver_id && r.status === 'completed') touch(r.driver_id).drives++;
        }

        const { count: total } = await db.from('users').select('*', { count: 'exact', head: true });
        const ids = Object.keys(byUser);
        const ordered = ids.filter(i => byUser[i].made > 0).length;
        const arrived = ids.filter(i => byUser[i].done > 0).length;
        const repeat  = ids.filter(i => byUser[i].made > 1).length;
        const loyal   = ids.filter(i => byUser[i].done > 2).length;

        return json(res, 200, {
          ok: true,
          funnel: { total: total || 0, ordered, arrived, repeat, loyal },
          users: byUser
        });
      }

      // ---- рассылка ----
      if (act === 'broadcast-count') {
        const list = await audienceQuery(body.audience, body.city);
        return json(res, 200, { ok: true, count: list.length });
      }
      if (act === 'broadcast-send' && isAdminUp(me)) {
        const text = String(body.text || '').trim();
        if (text.length < 5) return json(res, 400, { error: 'short' });
        if (text.length > 3000) return json(res, 400, { error: 'long' });
        const { data: ins } = await db.from('broadcasts').insert({
          text, audience: body.audience || 'all', city: body.city || 'all',
          btn_text: body.btn_text || null, btn_url: body.btn_url || null,
          created_by: me.id, created_by_name: me.name, status: 'queued'
        }).select().single();
        if (!ins) return json(res, 500, { error: 'db' });
        runBroadcast(ins.id);          // не ждём — уходит в фон
        return json(res, 200, { ok: true, id: ins.id });
      }
      if (act === 'broadcast-list') {
        const { data } = await db.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(20);
        return json(res, 200, { ok: true, items: data || [] });
      }

      // ---- города и сообщества ----
      if (act === 'city-list') {
        const { data } = await db.from('cities').select('*').order('sort').order('name');
        return json(res, 200, { ok: true, items: data || [] });
      }
      if (act === 'city-save' && isAdminUp(me)) {
        const row = {
          name: String(body.name || '').trim().slice(0, 60),
          slug: String(body.slug || '').trim().slice(0, 40) || null,
          group_link: String(body.group_link || '').trim().slice(0, 200) || null,
          group_id: body.group_id ? -Math.abs(Number(body.group_id)) : null,  // у групп ID всегда отрицательный
          description: String(body.description || '').trim().slice(0, 500) || null,
          active: body.active !== false,
          sort: Number(body.sort) || 100
        };
        if (!row.name) return json(res, 400, { error: 'no_name' });
        if (body.id) {
          await db.from('cities').update(row).eq('id', body.id);
        } else {
          const { error } = await db.from('cities').insert(row);
          if (error) return json(res, 400, { error: error.message.includes('duplicate') ? 'duplicate' : 'db' });
        }
        return json(res, 200, { ok: true });
      }
      if (act === 'city-delete' && isAdminUp(me)) {
        const { count } = await db.from('users').select('*', { count: 'exact', head: true }).eq('city', body.city_name);
        if (count && count > 0) return json(res, 400, { error: 'in_use', count });
        await db.from('cities').delete().eq('id', body.id);
        return json(res, 200, { ok: true });
      }

      // весь транспорт на проверке (staff)
      if (act === 'cars-pending-list') {
        const { data } = await db.from('cars').select('*').eq('approved', false).order('created_at', { ascending: false }).limit(50);
        const ids = [...new Set((data || []).map(c => c.user_id))];
        let owners = {};
        if (ids.length) {
          const { data: us } = await db.from('users').select('id,name,telegram_id,tg_username,driver_status').in('id', ids);
          (us || []).forEach(u => { owners[u.id] = u; });
        }
        const out = [];
        for (const c of data || []) {
          const signed = async v => {
            const p = docPath(v);
            if (!p) return null;
            const { data: s } = await db.storage.from('docs').createSignedUrl(p, 3600);
            return s && s.signedUrl ? s.signedUrl : null;
          };
          out.push({ ...c, photo_url: c.photo ? await signed(c.photo) : null,
                          pts_url: c.doc_pts ? await signed(c.doc_pts) : null,
                          lic_url: c.doc_license ? await signed(c.doc_license) : null,
                          owner: owners[c.user_id] || null });
        }
        return json(res, 200, { ok: true, items: out });
      }

      // машины пользователя (staff)
      if (act === 'cars-of-user') {
        const { data } = await db.from('cars').select('*').eq('user_id', tid).order('created_at');
        const out = [];
        for (const c of data || []) {
          const signed = async v => {
            const p = docPath(v);
            if (!p) return null;
            const { data: s } = await db.storage.from('docs').createSignedUrl(p, 3600);
            return s && s.signedUrl ? s.signedUrl : null;
          };
          out.push({ ...c, photo_url: c.photo ? await signed(c.photo) : null,
                          pts_url: c.doc_pts ? await signed(c.doc_pts) : null,
                          lic_url: c.doc_license ? await signed(c.doc_license) : null });
        }
        return json(res, 200, { ok: true, items: out });
      }

      // изменить марку и номер транспорта (staff)
      if (act === 'car-edit') {
        const { data: c } = await db.from('cars').select('*').eq('id', body.car_id).maybeSingle();
        if (!c) return json(res, 404, { error: 'no_car' });
        const brand = String(body.brand || '').trim().slice(0, 60);
        const plate = String(body.plate || '').trim().toUpperCase().slice(0, 15);
        if (!brand || !plate) return json(res, 400, { error: 'bad_input' });
        await db.from('cars').update({ brand, plate }).eq('id', c.id);
        // если это рабочий транспорт — обновим и то, что видят пассажиры
        if (c.is_active) await db.from('users').update({ car: brand, plate }).eq('id', c.user_id);
        await audit(me, 'car-edit', c.user_id, null,
          `транспорт: ${c.brand} ${c.plate} → ${brand} ${plate}`);
        return json(res, 200, { ok: true });
      }

      if (act === 'car-approve') {
        const { data: c } = await db.from('cars').select('*').eq('id', body.car_id).maybeSingle();
        if (!c) return json(res, 404, { error: 'no_car' });
        // администратор мог поправить марку и номер
        const upd2 = { approved: true };
        if (body.brand) { upd2.brand = String(body.brand).slice(0, 60); c.brand = upd2.brand; }
        if (body.plate) { upd2.plate = String(body.plate).toUpperCase().slice(0, 15); c.plate = upd2.plate; }
        await db.from('cars').update(upd2).eq('id', c.id);
        // если этот транспорт уже рабочий — обновим и в профиле
        if (c.is_active) await db.from('users').update({ car: c.brand, plate: c.plate }).eq('id', c.user_id);
        // если у водителя нет активной — сделаем эту активной
        const { data: act2 } = await db.from('cars').select('id').eq('user_id', c.user_id).eq('is_active', true).limit(1);
        if (!act2 || !act2.length) {
          await db.from('cars').update({ is_active: true }).eq('id', c.id);
          await db.from('users').update({ car: c.brand, plate: c.plate }).eq('id', c.user_id);
        }
        const tid2 = await tgIdOf(c.user_id);
        if (tid2) await send(tid2, `✅ <b>Машина одобрена</b>\n${c.brand} · ${c.plate}\n\nМожете выбрать её как рабочую в профиле.`);
        return json(res, 200, { ok: true });
      }

      if (act === 'car-remove') {
        const { data: c } = await db.from('cars').select('*').eq('id', body.car_id).maybeSingle();
        if (!c) return json(res, 404, { error: 'no_car' });
        await db.from('cars').delete().eq('id', c.id);
        if (c.is_active) {
          const { data: rest } = await db.from('cars').select('*').eq('user_id', c.user_id).eq('approved', true).limit(1);
          if (rest && rest.length) {
            await db.from('cars').update({ is_active: true }).eq('id', rest[0].id);
            await db.from('users').update({ car: rest[0].brand, plate: rest[0].plate }).eq('id', c.user_id);
          } else {
            await db.from('users').update({ car: null, plate: null, status: 'offline' }).eq('id', c.user_id);
          }
        }
        const tid3 = await tgIdOf(c.user_id);
        if (tid3) await send(tid3, `ℹ️ <b>Машина удалена модерацией</b>\n${c.brand} · ${c.plate}`);
        return json(res, 200, { ok: true });
      }

      if (act === 'car-add-admin') {
        const brand = String(body.brand || '').trim().slice(0, 60);
        const plate = String(body.plate || '').trim().toUpperCase().slice(0, 15);
        if (!brand || !plate || !tid) return json(res, 400, { error: 'bad_input' });
        const kindA = body.kind === 'moto' ? 'moto' : 'car';
        const { data: existing } = await db.from('cars').select('id').eq('user_id', tid).eq('is_active', true).limit(1);
        const makeActive = !existing || !existing.length;
        await db.from('cars').insert({ user_id: tid, brand, plate, kind: kindA, approved: true, is_active: makeActive });
        if (makeActive) {
          const u2 = { car: brand, plate, vehicle_type: kindA };
          if (kindA === 'moto') { u2.delivery = true; u2.intercity = false; }
          await db.from('users').update(u2).eq('id', tid);
        }
        return json(res, 200, { ok: true });
      }

      // сколько машин ждёт проверки
      if (act === 'cars-pending') {
        const { count } = await db.from('cars').select('*', { count: 'exact', head: true }).eq('approved', false);
        return json(res, 200, { ok: true, count: count || 0 });
      }

      // аватары пользователей (staff)
      if (act === 'avatars') {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 60) : [];
        if (!ids.length) return json(res, 200, { ok: true, map: {} });
        const { data: rows } = await db.from('contacts').select('user_id,photo_url,photo_path').in('user_id', ids);
        const byId = {};
        (rows || []).forEach(r => { byId[r.user_id] = r; });
        const map = {};
        for (const id of ids) {
          const r = byId[id];
          if (r && r.photo_path) {
            const { data: s } = await db.storage.from('docs').createSignedUrl(r.photo_path, 3600);
            if (s && s.signedUrl) { map[id] = s.signedUrl; continue; }
          }
          if (r && r.photo_url) { map[id] = r.photo_url; continue; }
        }
        return json(res, 200, { ok: true, map });
      }

      // подтянуть аватар через бота, если его нет (staff)
      if (act === 'avatar-fetch') {
        const r2 = await fetchAvatar(tid);
        if (!r2.path) return json(res, 200, { ok: true, url: null, why: r2.why });
        const { data: s } = await db.storage.from('docs').createSignedUrl(r2.path, 3600);
        return json(res, 200, { ok: true, url: s ? s.signedUrl : null });
      }

      // временные ссылки на документы (staff)
      if (act === 'doc-urls') {
        const { data: u } = await db.from('users').select('doc_license,doc_pts,doc_car').eq('id', tid).maybeSingle();
        if (!u) return json(res, 404, { error: 'no_user' });
        const out = {};
        for (const key of ['doc_license', 'doc_pts', 'doc_car']) {
          const p = docPath(u[key]);
          if (!p) continue;
          const { data: signed } = await db.storage.from('docs').createSignedUrl(p, 3600);
          if (signed && signed.signedUrl) out[key] = signed.signedUrl;
        }
        return json(res, 200, { ok: true, urls: out });
      }

      // карточка пользователя с телефоном (staff)
      if (act === 'user-phone') {
        const { data: c } = await db.from('contacts').select('phone,full_name').eq('user_id', tid).maybeSingle();
        // ФИО по документам — только администраторам
        return json(res, 200, { ok: true, phone: c ? c.phone : null, full_name: (c && isAdminUp(me)) ? c.full_name : null });
      }
      // телефоны заявок в водители (staff)
      if (act === 'apps-phones') {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 100) : [];
        if (!ids.length) return json(res, 200, { ok: true, map: {} });
        const { data } = await db.from('contacts').select('user_id,phone,full_name').in('user_id', ids);
        const map = {}, names = {};
        const canSeeFio = isAdminUp(me);
        (data || []).forEach(c => { map[c.user_id] = c.phone; if (canSeeFio && c.full_name) names[c.user_id] = c.full_name; });
        return json(res, 200, { ok: true, map, names });
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
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus','idle_hours','community_enabled','group_moderate','group_clean_service','group_welcome','pin_enabled','pin_minutes'].forEach(k => {
          if (f[k] !== undefined) allowed[k] = f[k];
        });
        if (!Object.keys(allowed).length) return json(res, 400, { error: 'nothing' });
        await db.from('settings').update(allowed).eq('id', 1);
        return json(res, 200, { ok: true });
      }

      // --- написать пользователю через бота (staff) ---
      if (act === 'send-msg') {
        const dest = body.to_user || body.target_id || tid;
        if (!dest) return json(res, 400, { error: 'no_user' });
        if (!body.text || !String(body.text).trim()) return json(res, 400, { error: 'empty' });
        await db.from('admin_msgs').insert({ to_user: dest, text: String(body.text).slice(0, 2000) });
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
        const ids = [...new Set((data || []).flatMap(p => [p.for_user, p.used_by]).filter(Boolean))];
        let names = {};
        if (ids.length) {
          const { data: us } = await db.from('users').select('id,name').in('id', ids);
          (us || []).forEach(u => { names[u.id] = u.name; });
        }
        return json(res, 200, { ok: true, items: data || [], names });
      }

      // список водителей/пользователей для выбора при создании промокода
      if (act === 'user-search') {
        const term = String(body.term || '').trim();
        if (!term) {
          const { data } = await db.from('users').select('id,name,car,role,driver_status,telegram_id').order('name').limit(30);
          return json(res, 200, { ok: true, items: data || [] });
        }
        const digits = term.replace(/\D/g, '');
        const found = new Map();
        // по имени
        const { data: byName } = await db.from('users').select('id,name,car,role,driver_status,telegram_id').ilike('name', `%${term}%`).limit(30);
        (byName || []).forEach(u => found.set(u.id, u));
        // по Telegram ID
        if (digits.length >= 3) {
          const { data: byId } = await db.from('users').select('id,name,car,role,driver_status,telegram_id').limit(300);
          (byId || []).forEach(u => { if (String(u.telegram_id || '').includes(digits)) found.set(u.id, u); });
        }
        // по телефону
        if (digits.length >= 3) {
          const { data: byPhone } = await db.from('contacts').select('user_id,phone').ilike('phone', `%${digits}%`).limit(30);
          const ids = (byPhone || []).map(c => c.user_id);
          if (ids.length) {
            const { data: us } = await db.from('users').select('id,name,car,role,driver_status,telegram_id').in('id', ids);
            (us || []).forEach(u => found.set(u.id, u));
          }
        }
        return json(res, 200, { ok: true, items: [...found.values()].slice(0, 40) });
      }

      // статистика по водителям за период
      if (act === 'drivers-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to = body.to ? new Date(body.to + 'T23:59:59').toISOString() : new Date().toISOString();
        const { data: rows } = await db.from('rides').select('driver_id,status,price,created_at,kind,to_city')
          .not('driver_id', 'is', null).gte('created_at', from).lte('created_at', to).limit(5000);
        let dq = db.from('users').select('id,name,car,telegram_id,status,driver_status,vehicle_type')
          .eq('driver_status', 'approved');
        if (body.vehicle === 'moto') dq = dq.eq('vehicle_type', 'moto');
        if (body.vehicle === 'car') dq = dq.or('vehicle_type.is.null,vehicle_type.eq.car');
        const { data: drv } = await dq;
        const agg = {};
        (drv || []).forEach(d => { agg[d.id] = { id: d.id, name: d.name, car: d.car, moto: d.vehicle_type === 'moto', tag: String(d.telegram_id || '').slice(-4), online: d.status === 'online', taken: 0, done: 0, cancelled: 0, money: 0, delivery: 0, intercity: 0 }; });
        (rows || []).forEach(r => {
          const a2 = agg[r.driver_id];
          if (!a2) return;
          a2.taken++;
          if (r.status === 'completed') { a2.done++; a2.money += Number(r.price) || 0; }
          if (String(r.status).startsWith('cancelled')) a2.cancelled++;
          if (r.kind === 'delivery') a2.delivery++;
          if (r.to_city) a2.intercity++;
        });
        const list = Object.values(agg).sort((x, y) => y.money - x.money || y.done - x.done);
        return json(res, 200, { ok: true, items: list, from, to });
      }

      // разбивка по дням: по всем или по одному водителю
      if (act === 'days-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 13 * 864e5).toISOString();
        const to = body.to ? new Date(body.to + 'T23:59:59').toISOString() : new Date().toISOString();
        let q = db.from('rides').select('status,price,created_at').gte('created_at', from).lte('created_at', to).limit(5000);
        if (body.driver_id) q = q.eq('driver_id', body.driver_id);
        const { data: rows } = await q;
        const byDay = {};
        (rows || []).forEach(r => {
          const d = String(r.created_at).slice(0, 10);
          byDay[d] = byDay[d] || { day: d, taken: 0, done: 0, cancelled: 0, money: 0 };
          byDay[d].taken++;
          if (r.status === 'completed') { byDay[d].done++; byDay[d].money += Number(r.price) || 0; }
          if (String(r.status).startsWith('cancelled')) byDay[d].cancelled++;
        });
        let name = null;
        if (body.driver_id) {
          const { data: d } = await db.from('users').select('name').eq('id', body.driver_id).maybeSingle();
          name = d ? d.name : null;
        }
        const days = Object.values(byDay).sort((a2, b2) => b2.day.localeCompare(a2.day));
        return json(res, 200, { ok: true, days, name });
      }

      // судьба заявок: что стало с каждой
      if (act === 'rides-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to   = body.to   ? new Date(body.to   + 'T23:59:59').toISOString() : new Date().toISOString();

        let q = db.from('rides').select('id,status,price,city,kind,to_city,created_at,confirmed_at,driver_id,passenger_id,passenger_price')
          .gte('created_at', from).lte('created_at', to).limit(10000);
        if (body.city && body.city !== 'all') q = q.eq('city', body.city);
        const { data: rides } = await q;
        const list = rides || [];

        // сколько предложений получила каждая заявка
        const ids = list.map(r => r.id);
        const offersBy = {};
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const { data: offs } = await db.from('offers').select('ride_id').in('ride_id', chunk);
          (offs || []).forEach(o => { offersBy[o.ride_id] = (offersBy[o.ride_id] || 0) + 1; });
        }

        const now = Date.now();
        const HANG = 30 * 60 * 1000;   // полчаса без ответа — считаем зависшей

        const res2 = {
          total: list.length,
          // что стало с заявкой
          completed: 0,        // доехал
          inProgress: 0,       // едет прямо сейчас
          waitingNow: 0,       // ищет машину сейчас
          noOffers: 0,         // никто не откликнулся
          hadOffersNotTaken: 0,// предложения были, пассажир не выбрал
          cancelPassenger: 0,  // отменил пассажир
          cancelDriver: 0,     // отказался водитель
          other: 0,
          // деньги и качество
          money: 0, avgCheck: 0,
          withPrice: 0,        // указал свою цену
          offersTotal: 0,
          waitSum: 0, waitCnt: 0,
          // срезы
          byKind: { ride: 0, delivery: 0, intercity: 0 },
          byHour: Array(24).fill(0),
          byDay: {},
          byCity: {}
        };

        for (const r of list) {
          const st = String(r.status || '');
          const offs = offersBy[r.id] || 0;
          res2.offersTotal += offs;
          if (r.passenger_price) res2.withPrice++;

          const c = r.city || '—';
          res2.byCity[c] = res2.byCity[c] || { total: 0, done: 0, money: 0 };
          res2.byCity[c].total++;

          if (r.kind === 'delivery') res2.byKind.delivery++;
          else if (r.to_city) res2.byKind.intercity++;
          else res2.byKind.ride++;

          const d = new Date(new Date(r.created_at).getTime() + 3 * 3600 * 1000);
          res2.byHour[d.getUTCHours()]++;
          const day = d.toISOString().slice(0, 10);
          res2.byDay[day] = res2.byDay[day] || { total: 0, done: 0, lost: 0, money: 0 };
          res2.byDay[day].total++;

          if (st === 'completed') {
            res2.completed++;
            res2.money += Number(r.price) || 0;
            res2.byCity[c].done++; res2.byCity[c].money += Number(r.price) || 0;
            res2.byDay[day].done++; res2.byDay[day].money += Number(r.price) || 0;
            if (r.confirmed_at) {
              const w = (new Date(r.confirmed_at) - new Date(r.created_at)) / 60000;
              if (w > 0 && w < 180) { res2.waitSum += w; res2.waitCnt++; }
            }
          } else if (st === 'confirmed' || st === 'in_progress') {
            res2.inProgress++;
          } else if (st === 'created') {
            if (now - new Date(r.created_at).getTime() < HANG) res2.waitingNow++;
            else if (offs === 0) { res2.noOffers++; res2.byDay[day].lost++; }
            else { res2.hadOffersNotTaken++; res2.byDay[day].lost++; }
          } else if (st.includes('cancelled')) {
            if (st.includes('driver')) res2.cancelDriver++;
            else res2.cancelPassenger++;
            res2.byDay[day].lost++;
          } else {
            res2.other++;
          }
        }

        res2.avgCheck = res2.completed ? Math.round(res2.money / res2.completed) : 0;
        res2.avgWait  = res2.waitCnt ? Math.round(res2.waitSum / res2.waitCnt) : null;
        res2.avgOffers = res2.total ? +(res2.offersTotal / res2.total).toFixed(1) : 0;

        return json(res, 200, { ok: true, ...res2, from, to });
      }

      // подробная статистика
      if (act === 'stats') {
        const now = new Date();
        const startOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.toISOString(); };
        const today = startOf(now);
        const yest = startOf(new Date(now.getTime() - 864e5));
        const week = startOf(new Date(now.getTime() - 6 * 864e5));
        const month = startOf(new Date(now.getTime() - 29 * 864e5));

        const cnt = async (table, build) => {
          let q = db.from(table).select('*', { count: 'exact', head: true });
          q = build(q);
          const { count } = await q;
          return count || 0;
        };

        const [ridesToday, ridesYest, ridesWeek, ridesMonth, ridesAll,
               doneToday, doneYest, doneWeek, doneMonth, doneAll,
               cancToday, cancWeek,
               usersToday, usersYest, usersWeek, usersMonth, usersAll,
               driversAll, driversOnline, pendingApps, deliveryDrivers] = await Promise.all([
          cnt('rides', q => q.gte('created_at', today)),
          cnt('rides', q => q.gte('created_at', yest).lt('created_at', today)),
          cnt('rides', q => q.gte('created_at', week)),
          cnt('rides', q => q.gte('created_at', month)),
          cnt('rides', q => q),
          cnt('rides', q => q.eq('status', 'completed').gte('created_at', today)),
          cnt('rides', q => q.eq('status', 'completed').gte('created_at', yest).lt('created_at', today)),
          cnt('rides', q => q.eq('status', 'completed').gte('created_at', week)),
          cnt('rides', q => q.eq('status', 'completed').gte('created_at', month)),
          cnt('rides', q => q.eq('status', 'completed')),
          cnt('rides', q => q.like('status', 'cancelled%').gte('created_at', today)),
          cnt('rides', q => q.like('status', 'cancelled%').gte('created_at', week)),
          cnt('users', q => q.gte('created_at', today)),
          cnt('users', q => q.gte('created_at', yest).lt('created_at', today)),
          cnt('users', q => q.gte('created_at', week)),
          cnt('users', q => q.gte('created_at', month)),
          cnt('users', q => q),
          cnt('users', q => q.eq('driver_status', 'approved')),
          cnt('users', q => q.eq('status', 'online')),
          cnt('users', q => q.eq('driver_status', 'pending')),
          cnt('users', q => q.eq('delivery', true))
        ]);

        // деньги по завершённым
        const { data: money } = await db.from('rides').select('price,created_at').eq('status', 'completed').gte('created_at', month);
        const sum = arr => arr.reduce((s, r) => s + (Number(r.price) || 0), 0);
        const mToday = (money || []).filter(r => r.created_at >= today);
        const mWeek = (money || []).filter(r => r.created_at >= week);

        // по городам
        const { data: cityRows } = await db.from('rides').select('city').gte('created_at', week);
        const cities = {};
        (cityRows || []).forEach(r => { const c = r.city || '—'; cities[c] = (cities[c] || 0) + 1; });

        return json(res, 200, {
          ok: true,
          rides: { today: ridesToday, yest: ridesYest, week: ridesWeek, month: ridesMonth, all: ridesAll },
          done: { today: doneToday, yest: doneYest, week: doneWeek, month: doneMonth, all: doneAll },
          cancelled: { today: cancToday, week: cancWeek },
          users: { today: usersToday, yest: usersYest, week: usersWeek, month: usersMonth, all: usersAll },
          drivers: { all: driversAll, online: driversOnline, pending: pendingApps, delivery: deliveryDrivers },
          money: { today: sum(mToday), week: sum(mWeek), month: sum(money || []) },
          cities
        });
      }
      if (act === 'promo-create' && isAdminUp(me)) {
        const row = {
          code: String(body.code || '').toUpperCase(),
          days: Number(body.days) || 0,
          amount: Number(body.amount) || 0,
          created_by: me.id,
          created_by_name: me.name
        };
        if (body.for_user) row.for_user = body.for_user;
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
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus','idle_hours','community_enabled','group_moderate','group_clean_service','group_welcome','pin_enabled','pin_minutes'].forEach(k => { if (f[k] !== undefined) allowed[k] = f[k]; });
        await db.from('settings').update(allowed).eq('id', 1);
        const { data } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
        return json(res, 200, { ok: true, settings: data });
      }

      // ---- обращения в поддержку ----
      if (act === 'support-list') {
        const { data } = await db.from('support_msgs').select('*').eq('answered', false).order('created_at', { ascending: false }).limit(60);
        const out = [];
        for (const s of data || []) {
          let purl = null;
          if (s.photo) {
            const { data: sg } = await db.storage.from('docs').createSignedUrl(s.photo, 3600);
            if (sg && sg.signedUrl) purl = sg.signedUrl;
          }
          out.push({ ...s, photo_url: purl });
        }
        return json(res, 200, { ok: true, items: out });
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
        if (body.support_id) await db.from('support_msgs')
          .update({ answered: true, answered_by: me.id, answered_by_name: me.name }).eq('id', body.support_id);
        return json(res, 200, { ok: true });
      }
      if (act === 'support-hide') {
        await db.from('support_msgs').update({ answered: true }).eq('id', body.support_id);
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
shiftLoop();
pinLoop();
