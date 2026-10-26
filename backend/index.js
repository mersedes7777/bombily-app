import http from 'http';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import zlib from 'node:zlib';

// время везде по Москве (Донбасс живёт по МСК), а не по серверу — там UTC
process.env.TZ = 'Europe/Moscow';

const TOKEN   = process.env.BOT_TOKEN;
const APP_URL = process.env.MINI_APP_URL;
// метка версии: меняем при каждом обновлении, чтобы телефоны не держали старое в памяти
const APP_VER = '110';
const OWNER   = Number(process.env.OWNER_ID || process.env.OWNER || 8672930773);
const PORT    = process.env.PORT || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME || 'bombily_bot';
// прямая ссылка на приложение: форма заказа открывается поверх группы,
// её видит только тот, кто нажал. Нужна «главная мини-аппа» в BotFather
const ORDER_LINK = `https://t.me/${BOT_USERNAME}?startapp=order`;
const BOT_ORDER_LINK = `https://t.me/${BOT_USERNAME}?start=botorder`;
// две кнопки на выбор: приложение или переписка с ботом
const ORDER_KB = { inline_keyboard: [[
  { text: '🚖 Заказать', url: ORDER_LINK, style: 'success' },
  { text: '💬 Через бота', url: BOT_ORDER_LINK, style: 'primary' }
]] };
const VERSION = 'v70-remind';

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
  let url = `${APP_URL}?s=${s}&uid=${uid}&nm=${nm}&v=${APP_VER}`;
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
      [{ text: '📣 Наша группа' }, { text: '💬 Связь с админом' }]
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
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: `${APP_URL}?v=${APP_VER}` } } });
  console.log('bot commands set');
}

/* ---------- поддержка ---------- */
const waitingSupport = new Set();   // кто сейчас пишет админу
const fwdMap = new Map();
// кому админ сейчас отвечает: держим и в базе, и в памяти — чтобы кнопка
// «Ответить» работала, даже если база временно недоступна
const staffReplyMem = new Map();
async function setStaffReply(staffTg, targetTg, supportId){
  staffReplyMem.set(String(staffTg), { staff_tg: staffTg, target_tg: targetTg, support_id: supportId || null });
  try { await db.from('staff_reply').upsert({ staff_tg: staffTg, target_tg: targetTg, support_id: supportId || null, created_at: new Date().toISOString() }); } catch(e){}
}
async function getStaffReply(staffTg){
  const mem = staffReplyMem.get(String(staffTg)) || null;
  try {
    const { data, error } = await db.from('staff_reply').select('*').eq('staff_tg', staffTg).maybeSingle();
    if (error) return mem;
    return data || mem;
  } catch(e){ return mem; }
}
async function clearStaffReply(staffTg){
  staffReplyMem.delete(String(staffTg));
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
  // владельца узнаём по ID из настроек, без базы: если база недоступна,
  // он всё равно должен иметь возможность отвечать людям
  const isOwner = OWNER && String(tgid) === String(OWNER);
  try {
    const { data, error } = await db.from('users').select('id,name,staff_role,telegram_id').eq('telegram_id', tgid).maybeSingle();
    if (isOwner) return data || { id: null, name: 'Владелец', staff_role: 'owner', telegram_id: tgid };
    if (error) console.error('staffByTg: база не ответила', error.message);
    if (!data) return null;
    if (['owner', 'admin', 'moderator'].includes(data.staff_role)) return data;
    return null;
  } catch (e) {
    return isOwner ? { id: null, name: 'Владелец', staff_role: 'owner', telegram_id: tgid } : null;
  }
}           // message_id у админа -> telegram_id пользователя

async function onUpdate(u) {
  // человек вступил в группу по ссылке — телеграм присылает это отдельным событием
  if (u.chat_member) {
    try {
      const cm = u.chat_member;
      const was = cm.old_chat_member && cm.old_chat_member.status;
      const now = cm.new_chat_member && cm.new_chat_member.status;
      const joined = now === 'member' && ['left', 'kicked'].includes(was);
      const left = ['member', 'restricted', 'administrator'].includes(was) && ['left', 'kicked'].includes(now);
      const who0 = cm.new_chat_member && cm.new_chat_member.user;
      if ((joined || left) && who0 && !who0.is_bot) {
        groupKind(cm.chat.id).then(g => {
          if (!g) return;
          if (joined) invOnJoin(cm, who0, g).catch(() => {});
          tgLog({ kind: joined ? 'join' : 'leave', tg_id: who0.id, name: String(who0.first_name || '').slice(0, 64),
            username: who0.username || null, chat_id: cm.chat.id, city: g.city, chat_type: g.type,
            source: cm.invite_link ? String(cm.invite_link.name || 'по ссылке-приглашению').slice(0, 48) : (cm.via_join_request ? 'по заявке' : null) });
        }).catch(() => {});
      }
      if (!joined) return;

      const who = cm.new_chat_member.user;
      if (who.is_bot) return;
      markJoin(cm.chat.id, who.id);   // новичок — час под присмотром антиспама

      const city = await cityByGroup(cm.chat.id);
      if (!city) return;

      const st = await groupSettings();

      const name = who.first_name || 'Гость';
      glog(`${city.name}: вступил ${name}`);

      // проверка новичка: пока не решит пример, писать не сможет.
      // Приветствие покажем после — чтобы не было двух сообщений сразу
      if (st.captcha_on) {
        const ok = await capStart(cm.chat.id, who, city.name);
        if (ok) return;
      }

      if (!st.group_welcome) return;
      const r = await send(cm.chat.id,
        `👋 ${name}, добро пожаловать в <b>Bombily | ${city.name}</b>\n\nЗдесь новости и объявления. Машину вызывайте кнопками ниже. Адрес увидите только вы и водитель.`,
        { reply_markup: ORDER_KB });
      if (r && r.result) delLater(cm.chat.id, r.result.message_id, st.group_welcome_sec ?? 120);
    } catch (e) { glog('приветствие: ' + e.message); }
    return;
  }

  if (u.callback_query) {
    const cq = u.callback_query, chat = cq.from.id;

    // ответ на проверку при входе
    if (cq.data && cq.data.startsWith('cap:')) {
      const p = cq.data.split(':');
      const forId = Number(p[1]), val = Number(p[2]);
      const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
      if (String(cq.from.id) !== String(forId)) {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Это проверка другого человека.', show_alert: true });
        return;
      }
      const { data: c } = await db.from('captcha_wait').select('*').eq('chat_id', chatId).eq('tg', forId).maybeSingle();
      if (!c) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Проверка уже пройдена.' }); return; }

      if (val === c.answer) {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Спасибо, теперь можно писать!' });
        await capPass(chatId, forId, c.msg_id);
        const city2 = await cityByGroup(chatId);
        const st2 = await groupSettings();
        if (city2 && st2.group_welcome) {
          const r2 = await send(chatId,
            `👋 ${safeName(c.user_name || 'Гость')}, добро пожаловать в <b>Bombily | ${safeName(city2.name)}</b>\n\nМашину вызывайте кнопками ниже. Адрес увидите только вы и водитель.`,
            { reply_markup: ORDER_KB });
          if (r2 && r2.result) delLater(chatId, r2.result.message_id, st2.group_welcome_sec ?? 120);
        }
        return;
      }

      const tries = (c.tries || 0) + 1;
      if (tries >= CAP_TRIES) {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ответ неверный. Попытки закончились.', show_alert: true });
        await capFail(chatId, forId, c.msg_id, 'три раза подряд неверный ответ');
        return;
      }
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `Неверно. Осталось попыток: ${CAP_TRIES - tries}`, show_alert: true
      });
      await capAsk(chatId, { id: forId, first_name: c.user_name }, '', { msg_id: c.msg_id, tries });
      return;
    }

    // «Взять заказ» под карточкой в общей группе — отвечаем сами, окошком
    if (cq.data && (cq.data.startsWith('bza:') || cq.data.startsWith('bzr:'))) {
      try { await bizDecideCq(cq, cq.data.startsWith('bza:') ? 'active' : 'rejected'); }
      catch (e) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' }).catch(() => {}); }
      return;
    }
    if (cq.data && cq.data.startsWith('bzj:')) {
      try { await bizJoin(cq, cq.data.slice(4)); }
      catch (e) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' }).catch(() => {}); }
      return;
    }

    if (cq.data === 'call:off' || cq.data === 'call:on') {
      try { await callToggle(cq, cq.data === 'call:on'); }
      catch (e) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' }).catch(() => {}); }
      return;
    }

    if (cq.data && cq.data.startsWith('gtake:')) {
      try { await groupTake(cq, cq.data.slice(6)); }
      catch (e) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.', show_alert: true }); }
      return;
    }

    // «какие машины на линии» — окошко видит только нажавший, закреп не трогаем
    if (cq.data && cq.data.startsWith('cars:')) {
      const cityName = cq.data.slice(5);
      let text;
      try {
        text = await carsOnLine(cityName);
      } catch (e) {
        text = 'Не получилось получить список. Попробуйте ещё раз.';
      }
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id, text, show_alert: true, cache_time: 20
      });
      return;
    }

    await tg('answerCallbackQuery', { callback_query_id: cq.id });

    // заказ из чата: подтвердить, исправить, отменить
    if (cq.data && cq.data.startsWith('co:')) {
      const what = cq.data.slice(3);
      if (what === 'go') { await chatOrderCreate(chat); return; }
      if (what === 'no') { await draftDel(chat); await send(chat, 'Отменил. Если что — просто напишите, куда нужно ехать.'); return; }
      // «Оформить заказ» из подсказки — начинаем с чистого листа
      if (what === 'new') {
        const { data: uu } = await db.from('users').select('city').eq('telegram_id', chat).maybeSingle();
        const d = {
          city: (uu && uu.city) || null, from_address: null, to_address: null,
          raw_text: null, kind: null, to_city: null, scheduled_at: null,
          comment: null, price: null, stage: 'ask_kind'
        };
        await draftSet(chat, draftPack(d, { stage: 'ask_kind' }));
        return askKind(chat, d);
      }

      // выбрал вид заказа
      if (what.startsWith('k:')) {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        const k = what.slice(2);
        if (k === 'inter') {
          await draftSet(chat, draftPack(d, { kind: 'ride', stage: 'ask_tocity' }));
          await askToCity(chat, { ...d, kind: 'ride' });
          return;
        }
        const nd = { ...d, kind: k === 'delivery' ? 'delivery' : 'ride', to_city: null };
        const next = nd.from_address && nd.to_address ? 'confirm' : (nd.from_address ? 'ask_to' : 'ask_from');
        await draftSet(chat, draftPack(nd, { stage: next }));
        return coNextStep(chat, { ...nd, stage: next });
      }

      // выбрал город для межгорода
      if (what.startsWith('c:')) {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        const nd = { ...d, kind: 'ride', to_city: what.slice(2) };
        const next = nd.from_address && nd.to_address ? 'confirm' : (nd.from_address ? 'ask_to' : 'ask_from');
        await draftSet(chat, draftPack(nd, { stage: next }));
        return coNextStep(chat, { ...nd, stage: next });
      }

      if (what === 'back') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        await draftSet(chat, draftPack(d, { stage: 'ask_kind' }));
        return askKind(chat, d);
      }

      if (what === 'kind') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        await draftSet(chat, draftPack(d, { stage: 'ask_kind' }));
        return askKind(chat, d);
      }
      if (what === 'time') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        if (d.scheduled_at) {   // повторное нажатие снимает время
          const nd = { ...d, scheduled_at: null };
          await draftSet(chat, draftPack(nd, { stage: 'confirm' }));
          await send(chat, 'Убрал время — заказ будет на сейчас.');
          await draftShow(chat, nd);
          return;
        }
        await draftSet(chat, draftPack(d, { stage: 'ask_time' }));
        await send(chat,
          `⏰ <b>Когда подать машину?</b>\nНапишите время: <b>18:30</b>, <b>завтра 9:00</b> или <b>через час</b>.`,
          { reply_markup: { force_reply: true, input_field_placeholder: 'например 18:30' } });
        return;
      }
      if (what === 'note') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        await draftSet(chat, draftPack(d, { stage: 'ask_note' }));
        await send(chat,
          `💬 <b>Что уточнить водителю?</b>\n<i>Например: третий подъезд, есть коляска, позвонить заранее.</i>`,
          { reply_markup: { force_reply: true, input_field_placeholder: 'пояснение для водителя' } });
        return;
      }
      if (what === 'price') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        await draftSet(chat, draftPack(d, { stage: 'ask_price' }));
        await send(chat,
          `💰 <b>Сколько готовы заплатить?</b>\nНапишите число, например: 300\n\n` +
          `<i>Водители увидят вашу цену. Кто согласен — возьмёт заказ, кто нет — предложит свою.</i>`,
          { reply_markup: { force_reply: true, input_field_placeholder: 'цена в рублях' } });
        return;
      }
      if (what === 'edit') {
        const d = await draftGet(chat);
        if (!d) { await send(chat, 'Черновик устарел, напишите заказ заново.'); return; }
        await draftSet(chat, draftPack(d, { from_address: null, to_address: null, stage: 'ask_from' }));
        return coNextStep(chat, { ...d, from_address: null, to_address: null, stage: 'ask_from' });
      }
    }

    // ошиблись — владелец возвращает человека одной кнопкой
    if (cq.data && cq.data.startsWith('adban:')) {
      if (String(chat) !== String(OWNER)) { await send(chat, 'Только владелец.'); return; }
      const uid = cq.data.slice(6);
      const { data: t } = await db.from('users').select('id,name,telegram_id,staff_role').eq('id', uid).maybeSingle();
      if (!t || t.staff_role === 'owner' || String(t.telegram_id) === String(OWNER)) { await send(chat, 'Нельзя.'); return; }
      await db.from('users').update({ is_banned: true }).eq('id', uid);
      await db.from('rides').update({ status: 'cancelled' }).eq('passenger_id', uid).eq('status', 'created');
      const { data: me0 } = await db.from('users').select('*').eq('telegram_id', chat).maybeSingle();
      audit(me0 || { name: 'owner' }, 'ban', t.telegram_id, t.name, 'реклама в заявке').catch(() => {});
      await send(chat, `⛔ ${safeName(t.name)} забанен, его заявки отменены.`);
      return;
    }
    if (cq.data && cq.data.startsWith('unspam:')) {
      const p = cq.data.split(':');
      if (String(chat) !== String(OWNER)) { await send(chat, 'Только владелец.'); return; }
      const r = await tg('unbanChatMember', { chat_id: Number(p[1]), user_id: Number(p[2]), only_if_banned: true });
      if (r && r.ok) invUnspam(Number(p[2])).catch(() => {});
      await send(chat, r && r.ok ? '✅ Разбанен. Слово из его сообщения стоит убрать из фильтра — напишите разработчику.' : 'Не получилось разбанить.');
      return;
    }

    // «Ответить» под сообщением по заявке
    if (cq.data && cq.data.startsWith('ask:')) {
      const p = cq.data.split(':');
      await askReplyBtn(chat, p[1], Number(p[2]));
      return;
    }

    // «Взять заказ» прямо из переписки
    if (cq.data && cq.data.startsWith('take:')) {
      await takeStart(chat, cq.data.slice(5));
      return;
    }

    // пассажир согласился с ценой
    if (cq.data && cq.data.startsWith('acc:')) {
      await acceptOffer(chat, cq.data.slice(4));
      return;
    }

    // пассажир подтверждает отмену водителя «по договорённости»
    if (cq.data && (cq.data.startsWith('ccy:') || cq.data.startsWith('ccn:'))) {
      await cancelConfirm(cq);
      return;
    }

    // «Завершить поездку» прямо из бота
    if (cq.data && cq.data.startsWith('done:')) {
      await rideDone(chat, cq.data.slice(5));
      return;
    }

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

  // человек нажал «Поделиться номером» — телеграм присылает контакт,
  // а не текст. Раньше такие сообщения просто игнорировались.
  if (m.contact && m.chat && m.chat.type === 'private') {
    try {
      const chatC = m.chat.id;
      const own = !m.contact.user_id || String(m.contact.user_id) === String(chatC);
      if (!own) {
        await send(chatC, 'Нужен ваш собственный номер — нажмите кнопку «Поделиться номером».');
        return;
      }
      const digits = String(m.contact.phone_number || '').replace(/\D/g, '');
      if (digits.length < 10) { await send(chatC, 'Не разобрал номер, попробуйте ещё раз.'); return; }
      const phone11 = digits.length === 11 ? digits : digits.slice(-11);

      const { data: uu } = await db.from('users').select('id').eq('telegram_id', chatC).maybeSingle();
      if (uu) {
        await db.from('users').update({ phone: phone11, has_phone: true }).eq('id', uu.id);
        await db.from('contacts').upsert({ user_id: uu.id, phone: phone11, updated_at: new Date().toISOString() })
          .then(() => {}, () => {});
      }
      await send(chatC, '✅ Номер сохранён. Его увидит только тот водитель, который возьмёт заказ.',
        { reply_markup: { remove_keyboard: true } });

      // если человек застрял на шаге телефона — доводим заказ до конца
      const d = await draftGet(chatC);
      if (d && d.stage === 'ask_phone') await chatOrderCreate(chatC);
    } catch (e) { console.error('contact', e.message); }
    return;
  }

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

  // копия базы по запросу — только владельцу
  if (text === '/backup') {
    if (chat !== OWNER) return;
    await send(chat, '⏳ Собираю копию, это займёт полминуты…');
    try {
      const ok = await sendBackup(chat);
      if (!ok) await send(chat, '❌ Не получилось отправить копию. Загляните в логи Railway.');
    } catch (e) {
      await send(chat, '❌ Ошибка при сборке копии: ' + e.message);
    }
    return;
  }

  // сводки — посмотреть прямо сейчас (только владельцу, в личку)
  if (text === '/report') {
    if (chat !== OWNER) return;
    try { await sendDailyReport(chat); } catch (e) { await send(chat, '❌ Не получилось собрать сводку: ' + e.message); }
    return;
  }
  if (text === '/weekly') {
    if (chat !== OWNER) return;
    try {
      const n = await sendWeeklyReports(chat);
      if (!n) await send(chat, 'За прошлую неделю показывать нечего — заявок не было.');
    } catch (e) { await send(chat, '❌ Не получилось собрать итоги недели: ' + e.message); }
    return;
  }

  // проверка меток: есть ли у бота право и проставить метки всем водителям сразу
  if (text === '/tags') {
    if (chat !== OWNER) return;
    await send(chat, '⏳ Проверяю группы и ставлю метки водителям…');
    const me2 = await tg('getMe');
    const botId = me2 && me2.result && me2.result.id;
    const { data: cities } = await db.from('cities').select('name,group_id').not('group_id', 'is', null);
    const out = [];
    for (const c of cities || []) {
      const bm = await tg('getChatMember', { chat_id: c.group_id, user_id: botId });
      const r = bm && bm.result || {};
      const right = r.can_manage_tags === true ? '✅ есть'
                  : r.can_manage_tags === false ? '❌ выключено'
                  : '❔ Telegram не сообщил';
      const { data: drv } = await db.from('users').select('*')
        .eq('city', c.name).eq('driver_status', 'approved').eq('is_banned', false).not('telegram_id', 'is', null).limit(300);
      let ok = 0, notIn = 0, lastErr = '';
      for (const d of drv || []) {
        const t = await tg('setChatMemberTag', { chat_id: c.group_id, user_id: d.telegram_id, tag: rankTag(d) });
        if (t && t.ok) ok++;
        else if (t && /not found|PARTICIPANT|USER_NOT|not a member/i.test(t.description || '')) notIn++;
        else lastErr = (t && t.description) || 'нет ответа';
        tagMemo.delete(String(d.telegram_id));
      }
      out.push(`<b>${safeName(c.name)}</b>\nПраво «метки» у бота: ${right}\n` +
        `Водителей: ${(drv || []).length} · метка стоит: ${ok}` +
        (notIn ? ` · не в группе: ${notIn}` : '') +
        (lastErr ? `\n⚠️ Ошибка Telegram: <code>${safeName(lastErr)}</code>` : ''));
    }
    return send(chat, out.join('\n\n') || 'Групп городов нет.');
  }

  if (text === '/stop') {
    await db.from('users').update({ no_broadcast: true }).eq('telegram_id', chat);
    return send(chat, 'Больше не будем присылать общие сообщения. Уведомления по вашим заказам продолжат приходить.\n\nВернуть рассылку — /start');
  }

  // сотрудник нажал «Ответить» и теперь пишет ответ
  // «Поездка Ленина 12 — рынок» прямо в личке с ботом — тот же заказ, что и из чата
  if (!text.startsWith('/') && orderWord(text)) {
    const { data: uu } = await db.from('users').select('city').eq('telegram_id', chat).maybeSingle();
    try {
      if (await chatOrderStart(m, chat, { name: (uu && uu.city) || '' })) return;
    } catch (e) { console.error('private order', e.message); }
  }

  // дописывает адреса для заказа, начатого в чате
  const draft = await draftGet(chat);
  if (draft && ['ask_from', 'ask_to', 'ask_price', 'ask_time', 'ask_note', 'ask_tocity'].includes(draft.stage) && !text.startsWith('/')) {
    // на шагах с кнопками текст не ждём — человек должен нажать кнопку
    await chatOrderText(chat, draft, text);
    return;
  }

  // человек пишет сообщение по заявке (кнопка «Связаться» или «Ответить»)
  const askW = await askGetWait(chat);
  if (askW && !text.startsWith('/')) {
    if (askW.role === 'price') await takePrice(chat, askW, text);
    else await askDeliver(chat, askW, text);
    return;
  }

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
    // журнал: кто пришёл в бота и откуда (первый раз или снова)
    (async () => {
      try {
        const arg0 = text.split(/\s+/)[1] || '';
        const { count } = await db.from('tg_events').select('*', { count: 'exact', head: true }).eq('kind', 'start').eq('tg_id', chat);
        const { data: u0 } = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle();
        await tgLog({ kind: 'start', tg_id: chat, name: String((m.from && m.from.first_name) || '').slice(0, 64),
          username: (m.from && m.from.username) || null, source: arg0 ? arg0.slice(0, 48) : null, is_new: !count && !u0 });
      } catch (e) {}
    })();
    // метка источника: /start src_chatname
    const arg = text.split(' ')[1] || '';
    if (arg.startsWith('src_')) {
      const code = arg.slice(4).slice(0, 40);
      try {
        const { data: u } = await db.from('users').select('id,source').eq('telegram_id', chat).maybeSingle();
        if (u) { if (!u.source) await db.from('users').update({ source: code }).eq('id', u.id); }
        else await db.from('pending_src').upsert({ tg: chat, code, created_at: new Date().toISOString() });
      } catch (e) {}
    }
    await clearWait(chat);
    db.from('users').update({ no_broadcast: false }).eq('telegram_id', chat).then(() => {}, () => {});
    // реферальная ссылка: /start ref_CODE
    const parts = text.split(/\s+/);
    const param = parts[1] || '';

    // вызов конкретного водителя из его карточки в группе: /start drv_UUID
    // человек писал заказ в чате, но бота не запускал — заказ ждал его здесь
    // кнопка «Заказать в боте» из группы: сразу спрашиваем, что нужно
    if (param === 'botorder') {
      const old = await draftGet(chat);
      if (old) { await coNextStep(chat, old); return; }
      const { data: u } = await db.from('users').select('city,is_banned').eq('telegram_id', chat).maybeSingle();
      if (u && u.is_banned) return;
      const d = {
        city: (u && u.city) || 'Енакиево',
        from_address: null, to_address: null, raw_text: null,
        kind: null, to_city: null, scheduled_at: null, comment: null, price: null,
        stage: 'ask_kind'
      };
      await draftSet(chat, d);
      await coNextStep(chat, d);
      return;
    }

    if (param === 'chat' || !param) {
      const d = await draftGet(chat);
      if (d) { await coNextStep(chat, d); return; }
    }

    // пришёл из группы по кнопке «Взять заказ», но ещё не водитель
    if (param === 'verify') {
      await send(chat,
        '🚗 <b>Брать заказы могут только проверенные водители</b>\n\n' +
        'Пройдите верификацию — это бесплатно и займёт пару минут: ФИО, телефон, фото прав и машины.\n\n' +
        'После проверки заказы будут приходить вам сами — с адресом и ценой пассажира.',
        { reply_markup: { inline_keyboard: [[wa('🚗 Пройти верификацию', 'driver')]] } });
      return;
    }

    // кнопки из чата: /start driver, /start order — сразу нужный экран
    if (param === 'driver' || param === 'order') {
      const scr = param === 'driver' ? 'driver' : 'order';
      await send(chat,
        param === 'driver'
          ? '🚗 <b>Кабинет водителя</b>\nЗдесь можно подать заявку, включить смену и смотреть заказы.'
          : '🚖 <b>Заказ поездки</b>\nНапишите сюда одной строкой: <code>Поездка Ленина 12 — рынок</code>\nили откройте приложение.',
        { reply_markup: { inline_keyboard: [[wa(param === 'driver' ? '🚗 Открыть кабинет' : '🚖 Открыть приложение', scr)]] } });
      return;
    }

    // «Связаться» из заявки: /start ask_UUID — уточнить детали до принятия
    if (param.startsWith('ask_')) {
      const rid = param.slice(4);
      const r = await askStart(chat, rid);
      if (r) return;
    }

    // приглашение сотрудника в точку: /start biz_CODE
    if (param.startsWith('biz_')) { await bizJoinPrompt(chat, param.slice(4)); return; }

    if (param.startsWith('drv_')) {
      const did = param.slice(4);
      const { data: drv } = await db.from('users')
        .select('*')
        .eq('id', did).eq('is_banned', false).maybeSingle();
      if (!drv) return send(chat, 'Такого водителя не нашлось. Откройте приложение и выберите из списка.');

      const busy = await driverStatusNow(drv);
      const car = drv.car || (drv.vehicle_type === 'moto' ? 'мотоцикл' : 'машина не указана');
      const head = `🚗 <b>${safeName(noContacts(drv.name))}</b>${rankBit(drv)} · ⭐ ${Number(drv.rating || 5).toFixed(1)}\n${car}` +
        (drv.spot ? `\n📍 Стоит: ${safeName(noContacts(drv.spot))}` : '');

      if (busy === 'offline')
        return send(chat, head + '\n\n⚫ Сейчас не на линии. Можно вызвать другого — откройте приложение.',
          { reply_markup: { inline_keyboard: [[{ text: '🚖 Открыть Bombily', web_app: { url: appUrl('order', m.from) } }]] } });

      if (busy === 'busy')
        return send(chat, head + '\n\n🔴 Сейчас на заказе. Можно подождать или вызвать другого.',
          { reply_markup: { inline_keyboard: [[{ text: '🚖 Открыть Bombily', web_app: { url: appUrl('order', m.from) } }]] } });

      return send(chat, head + '\n\n🟢 Свободен — можно вызывать.',
        { reply_markup: { inline_keyboard: [[
          { text: `🚖 Заказать у ${drv.name}`, web_app: { url: appUrl('order', m.from, { drv: drv.id }) } }
        ]] } });
    }
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
  if (text === '📣 Наша группа' || text === '/group') {
    const { data: u2 } = await db.from('users').select('city').eq('telegram_id', chat).maybeSingle();
    const { data: c2 } = await db.from('cities').select('name,group_link')
      .eq('name', u2 && u2.city ? u2.city : '').maybeSingle();
    if (c2 && c2.group_link) {
      return send(chat, `📣 <b>Bombily | ${c2.name}</b>

Новости города, объявления и обсуждения. Там же публикуем акции и предупреждаем о непогоде.`,
        { reply_markup: { inline_keyboard: [[{ text: 'Открыть группу', url: c2.group_link }]] } });
    }
    return send(chat, 'Для вашего города группа пока не создана.');
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


/* ---------- переписка по заявке до её принятия ----------
   Водитель жмёт «Связаться» в приложении → попадает в бота и пишет вопрос.
   Пассажиру приходит сообщение с кнопкой «Ответить» — отвечать можно,
   не открывая приложение. Телефоны при этом не раскрываются. */

// нажатия кнопок нижнего меню приходят обычным текстом — их нельзя
// принимать за сообщение собеседнику, иначе в переписке появляется
// «💬 Связь с админом» вместо ответа
const MENU_TEXTS = ['🚕 Заказать поездку', '🚗 Стать водителем', '👤 Кабинет',
  '📣 Наша группа', '💬 Связь с админом'];
const isMenuTap = t => MENU_TEXTS.includes(String(t || '').trim());

async function askSetWait(tg, rideId, peerTg, role) {
  try {
    await db.from('ask_wait').upsert({
      tg, ride_id: rideId, peer_tg: peerTg, role,
      created_at: new Date().toISOString()
    });
  } catch (e) {}
}
async function askGetWait(tg) {
  try {
    const { data } = await db.from('ask_wait').select('*').eq('tg', tg).maybeSingle();
    if (!data) return null;
    // просроченные ожидания не держим — человек мог уйти и вернуться через час
    if (Date.now() - new Date(data.created_at).getTime() > 30 * 60000) {
      await askClearWait(tg); return null;
    }
    return data;
  } catch (e) { return null; }
}
async function askClearWait(tg) {
  try { await db.from('ask_wait').delete().eq('tg', tg); } catch (e) {}
}

const askKb = (rideId, peerTg, forDriver, whoName) => ({
  reply_markup: { inline_keyboard: forDriver
    ? [[{ text: '✍️ Ответить', callback_data: `ask:${rideId}:${peerTg}` }],
       [{ text: '✅ Взять заказ', callback_data: `take:${rideId}` }]]
    : [[{ text: whoName ? `✍️ Ответить (${whoName})` : '✍️ Ответить', callback_data: `ask:${rideId}:${peerTg}` }]] }
});

// водитель нажал «Связаться» и пришёл в бота
async function askStart(chat, rideId) {
  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id,passenger_id,kind,from_address,to_address,city')
    .eq('id', rideId).maybeSingle();
  if (!ride) { await send(chat, 'Заявка не найдена — возможно, её уже отменили.'); return true; }
  if (ride.driver_id || !String(ride.status || '').startsWith('created')) {
    await send(chat, 'По этой заявке уже нельзя писать — её либо взяли, либо отменили.');
    return true;
  }

  const { data: me } = await db.from('users')
    .select('id,name,role,status,is_banned').eq('telegram_id', chat).maybeSingle();
  if (!me || me.is_banned) { await send(chat, 'Нет доступа.'); return true; }
  if (!['driver', 'both'].includes(me.role)) {
    await send(chat, 'Писать по чужим заявкам могут только водители.'); return true;
  }

  const { data: pas } = await db.from('users')
    .select('telegram_id').eq('id', ride.passenger_id).maybeSingle();
  if (!pas || !pas.telegram_id) { await send(chat, 'Пассажир недоступен.'); return true; }

  await askSetWait(chat, rideId, pas.telegram_id, 'driver');
  const kind = ride.kind === 'delivery' ? '📦 Доставка' : ride.to_city ? '🛣 Межгород' : '🚕 Поездка';
  await send(chat,
    `${kind}\n📍 ${safeName(ride.from_address)} → ${safeName(ride.to_address)}\n\n` +
    `<b>Напишите сообщение пассажиру</b> — оно придёт ему сюда же, в бота.\n` +
    `<i>Например: «подъезд со двора?», «поместится ли коляска?»</i>\n\n` +
    `Просто отправьте текст следующим сообщением.`,
    { reply_markup: { force_reply: true, input_field_placeholder: 'ваш вопрос пассажиру' } });
  return true;
}

// нажали кнопку «Ответить» под сообщением
async function askReplyBtn(chat, rideId, peerTg) {
  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id').eq('id', rideId).maybeSingle();
  if (!ride) { await send(chat, 'Заявка не найдена.'); return; }
  if (ride.driver_id || !String(ride.status || '').startsWith('created')) {
    await send(chat, 'По этой заявке переписка закрыта — её уже взяли или отменили.');
    return;
  }
  const { data: me } = await db.from('users').select('id,role').eq('telegram_id', chat).maybeSingle();
  const role = me && ['driver', 'both'].includes(me.role) ? 'driver' : 'passenger';
  await askSetWait(chat, rideId, peerTg, role);
  await send(chat, '<b>Напишите ответ</b> — отправлю его следующим сообщением.',
    { reply_markup: { force_reply: true, input_field_placeholder: 'ваш ответ' } });
}

// человек написал текст, пока мы ждали от него сообщение
async function askDeliver(chat, wait, text) {
  if (isMenuTap(text)) {
    // человек нажал кнопку меню, а не написал ответ — ожидание не сбрасываем
    await send(chat, 'Это кнопка меню. Напишите сообщение текстом — или нажмите «Ответить» ещё раз.');
    return;
  }
  await askClearWait(chat);
  if (!text || !text.trim()) { await send(chat, 'Пустое сообщение не отправил.'); return; }
  const body = text.trim().slice(0, 2000);

  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id,kind,from_address,to_address').eq('id', wait.ride_id).maybeSingle();
  if (!ride || ride.driver_id || !String(ride.status || '').startsWith('created')) {
    await send(chat, 'Не отправил: заявку уже взяли или отменили.');
    return;
  }

  const { data: me } = await db.from('users')
    .select('id,name,car,vehicle_type,rating,telegram_id').eq('telegram_id', chat).maybeSingle();
  const { data: peer } = await db.from('users').select('id,name').eq('telegram_id', wait.peer_tg).maybeSingle();

  // пассажиру может писать несколько водителей — поэтому в каждом сообщении
  // подписываем, кто именно: имя, машина и метка, чтобы не путались
  let head;
  if (wait.role === 'driver') {
    const car = (me && me.car) || (me && me.vehicle_type === 'moto' ? 'мотоцикл' : 'машина не указана');
    const tag = String((me && me.telegram_id) || '').slice(-4);
    const rate = me && me.rating ? ` · ⭐ ${Number(me.rating).toFixed(1)}` : '';
    head = `🚗 <b>${safeName(me && me.name)}</b> <code>#${tag}</code>${rate}\n${safeName(car)}\n` +
           `<i>пишет по вашей заявке:</i> ${safeName(ride.from_address)} → ${safeName(ride.to_address)}`;
  } else {
    head = `👤 <b>${safeName(me && me.name)}</b> отвечает по заявке:`;
  }

  // если сообщение уходит водителю — даём ему кнопку сразу взять заказ,
  // чтобы после договорённости не искать заявку в приложении
  const toDriver = wait.role === 'passenger';
  const shortName = String((me && me.name) || '').split(/\s+/)[0].slice(0, 14);
  // длинное сообщение сворачиваем: телеграм умеет раскрывающиеся цитаты,
  // иначе полотно текста закроет собой всё остальное в переписке
  const shown = body.length > 220
    ? `<blockquote expandable>${safeName(body)}</blockquote>`
    : `«${safeName(body)}»`;

  const ok = await send(wait.peer_tg, `${head}\n\n${shown}`,
    askKb(wait.ride_id, chat, toDriver, toDriver ? null : shortName));

  if (ok && ok.ok) {
    await db.from('ride_ask').insert({
      ride_id: wait.ride_id, from_id: me ? me.id : null, to_id: peer ? peer.id : null,
      from_role: wait.role, text: body
    }).then(() => {}, () => {});
    // даём сразу написать следующее сообщение — иначе, пока собеседник
    // молчит, написать второй раз было нельзя
    const again = { text: '✍️ Написать ещё', callback_data: `ask:${wait.ride_id}:${wait.peer_tg}` };
    await send(chat, '✅ Отправлено. Ответ придёт сюда же.',
      { reply_markup: { inline_keyboard: wait.role === 'driver'
        ? [[again], [{ text: '✅ Взять заказ', callback_data: `take:${wait.ride_id}` }]]
        : [[again]] } });
  } else {
    await send(chat, 'Не получилось отправить — возможно, человек заблокировал бота.');
  }
}


// после отправки цены даём поправить, если ошибся нулём
const priceKb = (rideId, peerTg) => ({
  reply_markup: { inline_keyboard: [
    [{ text: '✏️ Изменить цену', callback_data: `take:${rideId}` }],
    ...(peerTg ? [[{ text: '✍️ Написать пассажиру', callback_data: `ask:${rideId}:${peerTg}` }]] : [])
  ] }
});

// водитель нажал «Взять заказ» прямо в боте — спрашиваем цену
async function takeStart(chat, rideId) {
  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id,passenger_id,from_address,to_address,passenger_price,kind')
    .eq('id', rideId).maybeSingle();
  if (!ride) { await send(chat, 'Заявка не найдена.'); return; }
  if (ride.driver_id || !String(ride.status || '').startsWith('created')) {
    await send(chat, 'Заказ уже взяли или отменили.'); return;
  }
  const { data: me } = await db.from('users')
    .select('id,name,role,is_banned,driver_status').eq('telegram_id', chat).maybeSingle();
  if (!me || me.is_banned || !['driver', 'both'].includes(me.role)) {
    await send(chat, 'Брать заказы могут только водители с допуском.'); return;
  }
  // уже называл цену — значит хочет её поменять, это нормально
  const { data: was } = await db.from('offers')
    .select('id,price').eq('ride_id', rideId).eq('driver_id', me.id).eq('status', 'pending').maybeSingle();

  await askSetWait(chat, rideId, 0, 'price');
  const hint = ride.passenger_price
    ? `Пассажир предлагает <b>${ride.passenger_price} ₽</b>.`
    : 'Пассажир цену не называл.';
  await send(chat,
    `📍 ${safeName(ride.from_address)} → ${safeName(ride.to_address)}\n${hint}\n\n` +
    (was
      ? `Сейчас у вас стоит <b>${was.price} ₽</b>.\n<b>Пришлите новую цену числом</b> — я её заменю.`
      : `<b>Напишите вашу цену числом</b> — например: 300`),
    { reply_markup: { force_reply: true, input_field_placeholder: 'цена в рублях' } });
}

// водитель прислал цену
async function takePrice(chat, wait, text) {
  if (isMenuTap(text)) {
    await send(chat, 'Это кнопка меню. Пришлите цену числом, например 300.');
    return;
  }
  await askClearWait(chat);
  const price = Math.max(0, Math.min(100000, parseInt(String(text).replace(/\D+/g, ''), 10) || 0));
  if (!price) {
    await send(chat, 'Не понял цену. Нажмите «Взять заказ» ещё раз и пришлите число, например 300.');
    return;
  }
  const { data: ride } = await db.from('rides')
    .select('*').eq('id', wait.ride_id).maybeSingle();
  if (!ride || ride.driver_id || !String(ride.status || '').startsWith('created')) {
    await send(chat, 'Не отправил: заказ уже взяли или отменили.'); return;
  }
  const { data: me } = await db.from('users')
    .select('*').eq('telegram_id', chat).maybeSingle();
  if (!me) { await send(chat, 'Нет доступа.'); return; }
  if (ride.biz_id && !bizRankOk(me)) { await send(chat, `🏅 Заказы магазинов берут водители ${bizRankTxt()}.\nПолучите звание — и они станут доступны.`); return; }

  // телеграм пассажира — чтобы дать кнопку «написать» рядом с ценой
  const pasTg = await tgIdOf(ride.passenger_id);

  // если цена уже была — правим её, а не плодим второе предложение.
  // notified сбрасываем, чтобы пассажиру ушла новая сумма
  const { data: was } = await db.from('offers')
    .select('id,price,notify_msg_id,notify_chat').eq('ride_id', ride.id).eq('driver_id', me.id).eq('status', 'pending').maybeSingle();

  if (was) {
    if (was.price === price) {
      await send(chat, `Цена и так ${price} ₽ — ничего не менял.`, priceKb(ride.id, pasTg));
      return;
    }
    const { error: e2 } = await db.from('offers')
      .update({ price, notified: false, notify_msg_id: null, notify_chat: null }).eq('id', was.id);
    if (e2) { await send(chat, 'Не получилось изменить цену, попробуйте в приложении.'); return; }

    // старое сообщение с прежней суммой гасим, чтобы пассажир не согласился
    // на цену, которой уже нет — кнопки убираем, текст перечёркиваем
    if (was.notify_msg_id && was.notify_chat) {
      await tg('editMessageText', {
        chat_id: was.notify_chat, message_id: was.notify_msg_id,
        text: `<s>💰 ${safeName(me.name) || 'Водитель'} назвал цену: ${was.price} ₽</s>\n\n<i>Цена изменена — смотрите сообщение ниже.</i>`,
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
    }

    await send(chat, `✏️ <b>Цена изменена: было ${was.price} ₽, стало ${price} ₽.</b>\nПассажир увидит новую сумму.`,
      priceKb(ride.id, pasTg));
    return;
  }

  const { error } = await db.from('offers').insert({
    ride_id: ride.id, driver_id: me.id, driver_name: me.name,
    car: me.car, price, eta_minutes: 5
  });
  if (error) { await send(chat, 'Не получилось отправить цену, попробуйте в приложении.'); return; }

  // тот же учёт отклика, что и при предложении из приложения
  db.from('ride_notify').update({ responded: true, responded_at: new Date().toISOString() })
    .eq('ride_id', ride.id).eq('driver_id', me.id).then(() => {}, () => {});

  await send(chat,
    `✅ <b>Цена ${price} ₽ отправлена.</b>\nПассажир увидит её и выберет водителя. ` +
    `Если выберет вас — пришлю адрес и телефон.`,
    priceKb(ride.id, pasTg));
}


// пассажир принял цену прямо в боте
async function acceptOffer(chat, offerId) {
  const { data: o } = await db.from('offers')
    .select('id,ride_id,driver_id,driver_name,price,status').eq('id', offerId).maybeSingle();
  if (!o) { await send(chat, 'Предложение не найдено.'); return; }

  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id,passenger_id,scheduled_at').eq('id', o.ride_id).maybeSingle();
  if (!ride) { await send(chat, 'Заявка не найдена.'); return; }

  const { data: me } = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle();
  if (!me || String(me.id) !== String(ride.passenger_id)) {
    await send(chat, 'Это не ваша заявка.'); return;
  }
  if (ride.driver_id) {
    await send(chat, 'Водитель по этому заказу уже выбран.'); return;
  }
  if (o.status !== 'pending') { await send(chat, 'Это предложение уже неактуально.'); return; }

  const upd = {
    driver_id: String(o.driver_id), status: 'confirmed',
    price: o.price, confirmed_at: new Date().toISOString()
  };
  if (ride.scheduled_at) { upd.driver_notified = false; upd.remind_sent = false; upd.early_sent = false; }
  await db.from('rides').update(upd).eq('id', ride.id);
  await db.from('offers').update({ status: 'accepted' }).eq('id', o.id);

  // у остальных предложений гасим кнопки — заказ уже занят,
  // иначе пассажир может случайно согласиться второй раз
  const { data: rest } = await db.from('offers')
    .select('id,price,driver_name,notify_msg_id,notify_chat')
    .eq('ride_id', ride.id).neq('id', o.id);
  await db.from('offers').update({ status: 'declined' }).eq('ride_id', ride.id).neq('id', o.id);
  for (const x of rest || []) {
    if (!x.notify_msg_id || !x.notify_chat) continue;
    await tg('editMessageText', {
      chat_id: x.notify_chat, message_id: x.notify_msg_id,
      text: `<s>💰 ${safeName(x.driver_name) || 'Водитель'}: ${x.price} ₽</s>\n\n<i>Вы выбрали другого водителя.</i>`,
      parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
  }

  await send(chat, `✅ <b>${safeName(o.driver_name)} назначен, цена ${o.price} ₽.</b>\nСейчас пришлю его контакты.`);

  // своё же сообщение с кнопкой согласия тоже гасим
  const { data: mine } = await db.from('offers')
    .select('notify_msg_id,notify_chat').eq('id', o.id).maybeSingle();
  if (mine && mine.notify_msg_id && mine.notify_chat) {
    await tg('editMessageText', {
      chat_id: mine.notify_chat, message_id: mine.notify_msg_id,
      text: `✅ <b>${safeName(o.driver_name) || 'Водитель'} — ${o.price} ₽</b>\n<i>Вы выбрали этого водителя.</i>`,
      parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
  }
  // контакты обеим сторонам разошлёт обычный notifyLoop
}


/* ---------- завершение поездки ----------
   Водитель может закрыть заказ прямо из бота, не открывая приложение.
   Если забыл — бот закрывает сам через RIDE_AUTOCLOSE_MIN минут,
   но помечает такую поездку как закрытую автоматически, чтобы
   в отчётах было видно разницу. */

const RIDE_AUTOCLOSE_MIN = 40;

const doneKb = rideId => ({
  reply_markup: { inline_keyboard: [[
    { text: '🏁 Завершить поездку', callback_data: `done:${rideId}` }
  ]] }
});

// нажали «Завершить поездку»
async function rideDone(chat, rideId) {
  const { data: ride } = await db.from('rides')
    .select('id,status,driver_id,passenger_id,price,from_address,to_address')
    .eq('id', rideId).maybeSingle();
  if (!ride) { await send(chat, 'Заказ не найден.'); return; }

  if (ride.status === 'completed') { await send(chat, 'Поездка уже завершена.'); return; }
  if (!['confirmed', 'in_progress'].includes(ride.status)) {
    await send(chat, 'Этот заказ уже закрыт или отменён.'); return;
  }

  const { data: me } = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle();
  if (!me) { await send(chat, 'Нет доступа.'); return; }
  const isDriver = String(me.id) === String(ride.driver_id);
  const isPass = String(me.id) === String(ride.passenger_id);
  if (!isDriver && !isPass) { await send(chat, 'Это не ваш заказ.'); return; }

  await db.from('rides').update({
    status: 'completed', auto_closed: false, completed_at: new Date().toISOString()
  }).eq('id', ride.id);
  awardRide(ride.id).catch(() => {});

  const sum = ride.price ? ` Сумма: ${ride.price} ₽.` : '';
  await send(chat, `✅ <b>Поездка завершена.</b>${sum}`);

  // вторую сторону тоже уведомим
  const otherId = isDriver ? ride.passenger_id : ride.driver_id;
  const otg = await tgIdOf(otherId);
  if (otg) {
    await send(otg, `✅ <b>Поездка завершена.</b>${sum}\n<i>Закрыл ${isDriver ? 'водитель' : 'пассажир'}.</i>`,
      { reply_markup: { inline_keyboard: [[wa('Оценить поездку', 'order')]] } });
  }
}

// закрываем забытые поездки
async function autoCloseLoop() {
  try {
    const { data: open } = await db.from('rides')
      .select('id,status,driver_id,passenger_id,price,confirmed_at,scheduled_at')
      .in('status', ['confirmed', 'in_progress']).limit(200);

    const now = Date.now();
    for (const r of open || []) {
      // для заказов на время считаем от назначенного часа, а не от подтверждения
      const base = r.scheduled_at ? new Date(r.scheduled_at).getTime()
                 : r.confirmed_at ? new Date(r.confirmed_at).getTime() : null;
      if (!base) continue;
      if (now - base < RIDE_AUTOCLOSE_MIN * 60000) continue;

      await db.from('rides').update({
        status: 'completed', auto_closed: true, completed_at: new Date().toISOString()
      }).eq('id', r.id);
      awardRide(r.id).catch(() => {});

      const sum = r.price ? ` Сумма: ${r.price} ₽.` : '';
      for (const uid of [r.driver_id, r.passenger_id]) {
        const tid = await tgIdOf(uid);
        if (tid) await send(tid,
          `🏁 <b>Поездка закрыта автоматически.</b>${sum}\n` +
          `<i>Прошло больше ${RIDE_AUTOCLOSE_MIN} минут, никто не нажал «Завершить».</i>`,
          { reply_markup: { inline_keyboard: [[wa('Открыть приложение', 'order')]] } });
      }
    }
  } catch (e) { console.error('autoclose', e.message); }
  setTimeout(autoCloseLoop, 5 * 60000);
}
setTimeout(autoCloseLoop, 60 * 1000);


/* ---------- напоминания уснувшим пассажирам ----------
   Человек зашёл, посмотрел и пропал — таких большинство.
   Пишем через 14 дней тишины, потом раз в месяц, но не бесконечно.
   Как только человек зашёл в приложение — отсчёт начинается заново,
   и лишних сообщений он не получает. */

const WINBACK_MAX = 4;        // больше четырёх напоминаний не шлём никому
const WINBACK_PER_RUN = 25;   // за один проход, чтобы не упереться в лимиты телеграма

async function winbackUsersLoop() {
  try {
    const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (st && st.winback_users_on === false) { setTimeout(winbackUsersLoop, 6 * 3600 * 1000); return; }

    const firstDays = (st && st.winback_first_days) || 14;
    const nextDays  = (st && st.winback_next_days) || 30;
    const now = Date.now();
    const sleepCut = new Date(now - firstDays * 864e5).toISOString();
    const repeatCut = new Date(now - nextDays * 864e5).toISOString();

    const { data: sleepers } = await db.from('users').select('*')
      .lt('last_active', sleepCut)
      .lt('winback_count', WINBACK_MAX)
      .limit(400);

    let sent = 0;
    for (const u of sleepers || []) {
      if (sent >= WINBACK_PER_RUN) break;
      if (!u.telegram_id || u.is_banned) continue;
      // водителями занимается отдельная очередь с ручным одобрением
      if (['driver', 'both'].includes(u.role)) continue;
      // уже писали недавно — ждём
      if (u.winback_sent && u.winback_sent > repeatCut) continue;

      // сколько машин прямо сейчас в его городе — это убеждает лучше слов
      let cars = 0;
      if (u.city) {
        const { count } = await db.from('users')
          .select('id', { count: 'exact', head: true })
          .eq('city', u.city).eq('status', 'online').in('role', ['driver', 'both']);
        cars = count || 0;
      }

      // заказывал раньше или только смотрел — тексты разные
      const { count: rides } = await db.from('rides')
        .select('id', { count: 'exact', head: true }).eq('passenger_id', u.id);

      const carsLine = cars
        ? `\nСейчас на линии ${cars} ${plural(cars, ['машина', 'машины', 'машин'])}${u.city ? ' в городе ' + safeName(u.city) : ''}.`
        : '';

      const text = rides
        ? `👋 <b>Давно вас не было!</b>${carsLine}\n\nЕсли нужно куда-то доехать или что-то передать — мы на месте.`
        : `👋 <b>Вы заходили к нам, но так и не заказали</b>${carsLine}\n\n` +
          `Это просто: указываете откуда и куда, водители называют цену, вы выбираете подходящую. ` +
          `Никакой предоплаты, договариваетесь напрямую.`;

      const ok = await send(u.telegram_id, text, {
        reply_markup: { inline_keyboard: [[wa('Заказать машину', 'order')]] }
      });

      // заблокировал бота — больше не пытаемся
      await db.from('users').update({
        winback_sent: new Date().toISOString(),
        winback_count: (u.winback_count || 0) + (ok && ok.ok ? 1 : WINBACK_MAX)
      }).eq('id', u.id);

      if (ok && ok.ok) sent++;
      await new Promise(r => setTimeout(r, 120));   // не частим
    }
    if (sent) glog(`напоминания уснувшим: отправлено ${sent}`);
  } catch (e) { console.error('winbackUsers', e.message); }
  setTimeout(winbackUsersLoop, 6 * 3600 * 1000);
}
setTimeout(winbackUsersLoop, 3 * 60000);


// кто вступил в группу за последний час — новичок со ссылкой почти всегда спамер
const recentJoin = new Map();
function markJoin(chatId, uid) {
  if (!uid) return;
  recentJoin.set(`${chatId}:${uid}`, Date.now());
  if (recentJoin.size > 3000) recentJoin.clear();
}
setInterval(() => {
  const cut = Date.now() - 3600 * 1000;
  for (const [k, v] of recentJoin) if (v < cut) recentJoin.delete(k);
}, 10 * 60000);

/* ---------- защита группы от спама ----------
   Ловим рекламу запрещённого, «знакомства» и лёгкий заработок.
   Считаем очки, а не ищем одно слово: обычные слова вроде «соль»
   или «работа» сами по себе безобидны, опасны их сочетания
   со ссылками и призывом писать в личку. */

// нормализуем: спамеры разбавляют буквы точками, цифрами и латиницей
function spamNorm(s) {
  let t = String(s || '').toLowerCase();
  const lat = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
  t = t.replace(/[abcehkmoptxy]/g, c => lat[c] || c);
  t = t.replace(/[0о]/g, 'о').replace(/1/g, 'и').replace(/3/g, 'з').replace(/4/g, 'ч');
  t = t.replace(/[^а-яё@\s]/g, ' ').replace(/\s+/g, ' ');
  return ' ' + t.trim() + ' ';
}

const SPAM_GOODS = [
  'закладк', 'клад ', 'миксы', 'реагент', 'гашиш', 'марихуан', 'амфетамин',
  'мефедрон', 'экстази', 'лсд ', 'спайс', 'соли ', 'шишки', 'бошки', 'стафф',
  'дурь', 'травка', 'план ', 'меф ', 'скорость '
];
const SPAM_JOB = [
  'нужны люди', 'нужен человек', 'нужны сотрудники', 'требуются люди', 'ищем людей',
  'жду отклика', 'жду откликов', 'жду ответа в лс', 'возьму в команду', 'наберу команду',
  'понятная задача', 'простая задача', 'занятость', 'свободный график', 'обучение бесплатно',
  'работа курьером', 'нужны курьеры', 'ищем курьеров', 'высокий доход',
  'от 5000 в день', 'от 10000 в день', 'ежедневные выплаты', 'без опыта',
  'быстрый заработок', 'лёгкий заработок', 'легкий заработок', 'подработка от',
  'оплата сразу', 'дневная оплата', 'вакансия курьер', 'оплата в конце дня'
];
// сама вакансия: должность, условия, «пиши». Такие объявления приходят
// без телефона и ссылок — узнаём их по жанру, а не по контактам
const SPAM_VACANCY = [
  'оператор колл', 'колл-центр', 'колл центр', 'оператор чата', 'модератор чата',
  'работа из офиса', 'работа из дома', 'удалённая работа', 'удаленная работа',
  'готовые скрипты', 'по скрипту', 'входящие обращения', 'входящие звонки',
  'обучение за счёт', 'обучение за счет', 'гибкий график', 'полная занятость',
  'частичная занятость', 'официальное трудоустройство', 'опыт не требуется',
  'резюме в лс', 'анкета в лс', 'условия в лс', 'подробности в лс',
  'собрать мебель', 'мелкий ремонт', 'частным домам', 'по частным', 'бригаду',
  'ищем сотрудник', 'ищем помощник', 'требуются помощник', 'требуется помощник', 'нужны работник',
  'обучение предоставляется', 'есть работа', 'для студентов', 'по оплате выходит',
  'оплата нормальн', 'оплата после смен', 'выплаты каждый день', 'расчет после', 'расчёт после',
  'на развозку', 'развозить заказ', 'маршруты уже', 'маршрут составлен',
  'сортировк', 'упаковк', 'комплектац', 'фасовк',
  'пиши обсудим', 'пишите обсудим', 'клацни', 'обсудим детали', 'нужно пару человек',
  'нужны пару человек', 'пару человек', 'могу платить', 'нормально платить',
  'платить буду', 'бонусом', 'сотрудник проката', 'оформлять выдачу',
  'принимать оборудование', 'проверять комплектность', 'занимаюсь ремонтом',
  'нужны помощники', 'нужен помощник', 'подработк', 'смена с', 'график 2',
  'можно взять заказ', 'взять заказы по', 'заказы по проверке', 'маршрут согласуем',
  'согласуем заранее', 'приехать по адресу', 'сделать фотографии', 'отметить состояние',
  'выезд по адресам', 'объезд адресов', 'проверка объектов', 'загородной недвижимости',
  'требуются сотрудник', 'требуется сотрудник', 'набор сотрудник', 'набираем сотрудник',
  'требуются работник', 'нужны сотрудник', 'за смену', 'посменно',
  'пиши плюс', 'ставь плюс', 'напиши плюс'
];

// долги, кредиты, «решу проблему» — назойливые услуги, которые лезут в чаты
const SPAM_LOAN = [
  'одолжить', 'одолжу', 'займ', 'в долг', 'под проценты', 'без залога',
  'деньги до зарплаты', 'финансовая помощь', 'помощь с деньгами', 'дам в долг',
  'возможность одолжить', 'нужны деньги'
];
const SPAM_DEBT = [
  'решу проблему', 'решаю проблем', 'спишем долг', 'списать долг', 'списание долг',
  'долгами', 'с долгами', 'просрочк', 'коллектор', 'банкротств', 'приставы',
  'рефинанс', 'микрозайм', 'кредитн', 'платежи', 'не сходятся', 'помогу вернуть деньги'
];
const SPAM_DATE = [
  'познакомлюсь', 'интим', 'для встреч', 'без обязательств', 'мои фото',
  'мой профиль', 'пишите в лс', 'напиши мне', 'ищу мужчину', 'ищу спонсора',
  'приватные фото', 'скучаю одна', 'девушки онлайн'
];
const SPAM_MONEY = [
  'ставки на спорт', 'казино', 'бонус за регистрацию', 'схема заработка',
  'криптовалют', 'инвестиции от', 'удвоим ваш', 'проверенный способ'
];

// подмена букв: «сoтpудников» — латинские o и p вместо русских.
// Живой человек так не пишет никогда, это обход фильтров
const GLYPH = { A:'А',B:'В',C:'С',E:'Е',H:'Н',K:'К',M:'М',O:'О',P:'Р',T:'Т',X:'Х',Y:'У',
                a:'а',c:'с',e:'е',o:'о',p:'р',x:'х',y:'у',k:'к',m:'м' };
function mixedWords(raw) {
  return (String(raw || '').match(/[A-Za-zА-Яа-яЁё]+/g) || [])
    .filter(w => w.length >= 2 && /[А-Яа-яЁё]/.test(w) && /[A-Za-z]/.test(w)).length;
}
function deglyph(raw) {
  return String(raw || '').replace(/[A-Za-zА-Яа-яЁё]+/g, w =>
    /[А-Яа-яЁё]/.test(w) ? w.replace(/[A-Za-z]/g, c => GLYPH[c] || c) : w);
}

// короткие приманки: человек пишет одну фразу, чтобы зашли к нему в профиль
const BAIT_RE = [
  [/(?:^|\s)помог(у|аю|ем)\s+(вам\s+)?(с|со)\s+(жиль|квартир|долг|кредит|займ|деньг|ипотек|микрозайм|банкрот|пристав|работ)/, 'приманка «помогу с…»'],
  [/(надоел[иа]?|устал[аи]?\s+от|замучил[иа]?|достал[иа]?)\s+(долг|кредит|займ|коллектор|пристав)/, 'приманка про долги'],
  [/(?:^|\s)(хоч(у|ешь|ете)|дам|покажу|угощу|попробу[а-яё]*|любишь|ищу)\s+((тво[йюеи]|мо[йюеи]|мою)\s+)?(перч|дын|клубни|огурч|банан|персик|вишен|киск|пирожк|сосис|арбуз|ягодк|сладк|горяч|шалун)/, 'интимная приманка']
];
const SPAM_SEX = ['интим', 'секс', ' вирт ', 'эскорт', 'без одежды', 'голые', 'голая', 'обнаж',
  'горячие фото', 'пошалим', 'шалунь', 'скучаю одна', 'скучно одной', 'одинокая девушка', 'нюдс'];

// «Psdtu Aupsrxa» — набор латинских букв вместо имени, так выглядят купленные аккаунты
function junkName(name) {
  const n = String(name || '').trim();
  return /^[A-Za-z]+(\s+[A-Za-z]+)?$/.test(n) && /[bcdfghjklmnpqrstvwxz]{4,}/i.test(n);
}

// кто уже попадался на спаме: второй раз — сразу бан
const spamStrikes = new Map();
function strikesOf(chatId, uid) {
  const v = spamStrikes.get(`${chatId}:${uid}`);
  if (!v || Date.now() - v.t > 24 * 3600 * 1000) return 0;
  return v.n;
}
function strikeAdd(chatId, uid) {
  const k = `${chatId}:${uid}`;
  spamStrikes.set(k, { n: strikesOf(chatId, uid) + 1, t: Date.now() });
  if (spamStrikes.size > 5000) spamStrikes.clear();
}

function spamScore(text, opts) {
  const t = spamNorm(text);
  const raw0 = String(text || '');
  const mixed = mixedWords(raw0);
  const raw = deglyph(raw0);      // дальше проверяем уже с нормальными буквами
  let score = 0;
  const why = [];
  if (mixed >= 2) { score += 6; why.push(`подмена букв в ${mixed} словах`); }
  else if (mixed === 1) { score += 2; why.push('подмена букв'); }
  const hit = (list, pts, label) => {
    const found = list.filter(w => t.includes(w));
    if (found.length) { score += pts * Math.min(found.length, 3); why.push(label + ': ' + found.slice(0, 3).join(', ')); }
  };

  hit(SPAM_GOODS, 5, 'запрещённое');
  hit(SPAM_JOB, 3, 'заработок');
  hit(SPAM_VACANCY, 3, 'вакансия');
  hit(SPAM_DEBT, 4, 'долги/услуги');
  hit(SPAM_LOAN, 4, 'займы');
  hit(SPAM_DATE, 3, 'знакомства');
  hit(SPAM_MONEY, 3, 'деньги');
  hit(SPAM_SEX, 5, 'интим');
  for (const [re, label] of BAIT_RE) if (re.test(t)) { score += 6; why.push(label); }

  // «оплата до 9 500 р за смену», «доход от 3000 в день»
  if (/(оплат|зарплат|доход|плат(им|ят)|плачу)[а-яё]*\s*(до|от)?\s*\d[\d\s]{2,7}\s*(р(?![а-яё])\.?|руб[а-яё]*|₽|к(?![а-яё])|тыс[а-яё]*)?\s*(за|в|\/)\s*(смен|день|дня|сутки|час|недел|выход|рейс|месяц)/i.test(raw)) {
    score += 4; why.push('оплата за смену');
  }
  // «5000 + бензин»
  if (/\d{3,6}\s*\+\s*(бензин|топлив|гсм|проезд|обед)/i.test(raw)) { score += 3; why.push('оплата + бензин'); }
  // «Подробности в @Gor_work1» — зовут к стороннему нику
  if (/(подробн|детали|услови|пиши|пишите|напиши|обращ|вопрос|связь|анкет)[а-яё]*\s*(в|у|по|сюда|тут)?\s*:?\s*@[A-Za-z0-9_]{4,}/i.test(raw)) {
    score += 3; why.push('зовёт к нику');
  }
  // имя из случайных латинских букв — только как довесок к остальному
  if (opts && opts.name && junkName(opts.name) && score > 0) { score += 2; why.push('имя-набор букв'); }

  // номер телефона в сообщении — так зовут писать в обход бота
  const hasPhone = /(?:\+?7|8)?[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/.test(raw.replace(/\s+/g, ' '));
  if (hasPhone) { score += 3; why.push('телефон в тексте'); }

  // график сменами: «2\\2», «5/2», «10:00-20:00» — так пишут только вакансии
  if (/\b\d\s*[\\\/]\s*\d\b/.test(raw)) { score += 3; why.push('график смен'); }
  if (/\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}/.test(raw)) { score += 3; why.push('часы работы'); }
  // «6500 день», «4500 смена» — оплата без слова «руб»
  if (/\d{3,6}\s*(?:руб\w*|₽)?\s*(?:\/|за\s+)?\s*(?:день|дня|смен\w*|сутки|выход)/i.test(raw)) {
    score += 3; why.push('оплата за день');
  }

  // «Можно взять заказы по частным домам», «предлагаю забрать несколько заказов» —
  // один и тот же приём, меняется только ремесло: мебель, ремонт, фото объектов
  if (/(можно|предлагаю|есть|готов[аы]?\s+отдать|отдам)\s+(?:\w+\s+){0,2}(взять|забрать|разобрать)\s+(?:\w+\s+){0,2}заказ/i.test(raw)) {
    score += 4; why.push('«возьми заказы»');
  }
  if (/заказ\w*\s+по\s+(частн|адрес|дом|объект|точк|квартир|участк)/i.test(raw)) {
    score += 4; why.push('заказы по адресам');
  }
  // оплата за единицу работы: «от 22 000 за выезд», «5000 за объект»
  if (/\d[\d\s]{2,8}\s*(?:руб\w*|₽)?\s*за\s*(выезд|объект|точку|адрес|заказ|дом)/i.test(raw)) {
    score += 4; why.push('оплата за выезд');
  }

  // «от 20к за день», «30к в неделю» — приманка с суммой в тысячах
  if (/(?:от\s*)?\d{1,4}\s*к\s*(?:за|в)\s*(?:день|дня|сутки|смен|недел|мес)/i.test(raw)
      || /от\s*\d{2,4}\s*к\b/i.test(raw)) {
    score += 4; why.push('сумма в тысячах за период');
  }

  // «5500 руб за 4 часа» — типичная приманка вербовщика
  if (/\d{3,6}\s*(?:руб|₽|р\b)/i.test(raw) && /за\s*(?:\d+\s*)?(?:час|день|дня|смен|недел|выход)/i.test(raw)) {
    score += 3; why.push('ставка за смену');
  }
  // «напиши», «пиши в лс» вместе с телефоном или ссылкой
  if (/(напиши|пиши|пишите|обращайтесь|клацни|звони|набери)/i.test(raw) && hasPhone) { score += 2; why.push('зовёт писать лично'); }
  // «Пиши +» — фирменный призыв вербовщиков, отвечать плюсом в личку
  if (/(?:^|\n|\s)(?:пиши|пишите|ставь|ставьте|жду)\s*[«"']?\+/i.test(raw)) { score += 3; why.push('«пиши +»'); }
  // объявление списком: несколько коротких строк и сумма — типичная вакансия
  const rows = raw.split(/\n/).map(x => x.trim()).filter(Boolean);
  // цифры телефона суммой не считаем — иначе любое объявление с номером
  // выглядело как вакансия с зарплатой
  const noPhone = raw.replace(/(?:\+?\d[\s\-()]*){10,}/g, ' ');
  if (rows.length >= 3 && rows.length <= 12 && rows.every(x => x.length <= 60)
      && /\d{4,6}/.test(noPhone)) { score += 3; why.push('объявление списком с суммой'); }

  // ссылки и приглашения в личку
  const links = (raw.match(/https?:\/\/|t\.me\/|@[a-zA-Z_]{4,}/g) || []).length;
  if (links) { score += 2 * Math.min(links, 3); why.push('ссылок: ' + links); }

  // сообщение от имени канала — почти всегда реклама
  if (opts && opts.senderChat) { score += 4; why.push('пишет от имени канала'); }
  // переслано из канала
  if (opts && opts.forwarded) { score += 2; why.push('пересланное'); }
  // новичок сразу со ссылкой
  if (opts && opts.isNew && links) { score += 3; why.push('новичок со ссылкой'); }
  // новичок, у которого уже есть любой признак — почти всегда заброс
  if (opts && opts.isNew && score >= 3) { score += 2; why.push('новичок в чате'); }
  // этот человек уже попадался сегодня — каждое следующее сообщение под подозрением
  if (opts && opts.strikes && score >= 2) { score += 4 * Math.min(opts.strikes, 2); why.push('уже попадался на спаме'); }
  // сплошной капс длиннее двадцати знаков
  const caps = raw.replace(/[^А-ЯA-Z]/g, '').length;
  if (raw.length > 20 && caps / raw.length > 0.6) { score += 2; why.push('капс'); }

  return { score, why: why.join('; ') };
}

// нашли спам — убираем и, если велено, баним
async function spamHandle(m, chatId, city, st, res) {
  const text = String(m.text || m.caption || '');
  const uid = m.from && m.from.id;
  const uname = (m.from && m.from.first_name) || '';

  // проверенных водителей автоматически не баним никогда: они прошли
  // проверку документов, и выгонять их — решение владельца, а не фильтра
  let trusted = false, dbDown = false;
  if (uid) {
    try {
      const { data: tu, error } = await db.from('users').select('driver_status,staff_role').eq('telegram_id', uid).maybeSingle();
      if (error) dbDown = true;
      trusted = !!(tu && (tu.driver_status === 'approved' || (tu.staff_role && tu.staff_role !== 'none')));
    } catch (e) { dbDown = true; }
  }
  const sid = (m.sender_chat && m.sender_chat.id) || uid;
  const strikes = strikesOf(chatId, sid);
  // бан: явный спам или второе попадание за сутки. Если база не ответила,
  // мы не знаем, свой ли это водитель — тогда баним только совсем явное
  const clear = res.score >= 8 || strikes >= 1;
  const ban = !trusted && st.antispam_ban !== false && clear && (!dbDown || strikes >= 1 || res.score >= 12);
  strikeAdd(chatId, sid);

  await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});

  if (ban) {
    if (m.sender_chat) {
      await tg('banChatSenderChat', { chat_id: chatId, sender_chat_id: m.sender_chat.id }).catch(() => {});
    } else if (uid) {
      await tg('banChatMember', { chat_id: chatId, user_id: uid }).catch(() => {});
      invSpam(uid).catch(() => {});
    }
  }

  db.from('spam_log').insert({
    chat_id: chatId, city: city.name, tg_id: uid || null, user_name: uname,
    text: text.slice(0, 500), score: res.score, reasons: res.why,
    action: ban ? 'banned' : 'deleted'
  }).then(() => {}, () => {});

  glog(`${city.name}: СПАМ ${res.score} (${res.why}) — ${ban ? 'удалено и забанен' : 'удалено'} · ${uname}`);

  // владельцу — чтобы видел и мог вернуть, если ошиблись
  if (OWNER) {
    await send(OWNER,
      `🚫 <b>Спам в группе ${safeName(city.name)}</b>\n` +
      `От: ${safeName(uname)}${uid ? ` <code>${uid}</code>` : ''}${m.sender_chat ? ' (канал)' : ''}\n` +
      `Очки: ${res.score} — ${safeName(res.why)}\n` +
      `Действие: ${ban ? 'удалено, забанен' : trusted ? 'удалено, <b>не забанен — это ваш водитель</b>' : 'удалено'}\n\n` +
      `<blockquote expandable>${safeName(text.slice(0, 600))}</blockquote>`,
      ban && uid ? { reply_markup: { inline_keyboard: [[
        { text: '↩️ Разбанить — это не спам', callback_data: `unspam:${chatId}:${uid}` }
      ]] } } : {});
  }
}


// водитель вышел на линию — показываем, что висит прямо сейчас.
// Уведомления рассылаются один раз при создании заявки, и тот,
// кто был офлайн, их просто не получал.
async function sendOpenRides(user) {
  try {
    if (!user || !user.telegram_id) return;
    if (!['driver', 'both'].includes(user.role)) return;

    let q = db.from('rides')
      .select('*')
      .eq('status', 'created').is('driver_id', null)
      .order('created_at', { ascending: false }).limit(20);
    if (user.city) q = q.eq('city', user.city);
    const { data: rides } = await q;

    // мотоциклам — только доставка, машинам — всё кроме неё не трогаем
    const fit = (rides || []).filter(r => {
      if (r.biz_id && !bizRankOk(user)) return false;
      if (user.vehicle_type === 'moto') return r.kind === 'delivery';
      if (r.kind === 'delivery' && !user.delivery) return false;
      if (r.to_city && !user.intercity) return false;
      return true;
    });

    if (!fit.length) {
      await send(user.telegram_id, '🟢 <b>Вы на линии.</b>\nСвободных заявок сейчас нет — пришлю, как появятся.');
      return;
    }

    const lines = fit.slice(0, 8).map(r => {
      const kind = r.kind === 'delivery' ? '📦' : r.to_city ? '🛣' : '🚕';
      const when = r.scheduled_at
        ? ` ⏰ на ${new Date(r.scheduled_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
        : '';
      const price = r.passenger_price ? ` · предлагают ${r.passenger_price} ₽` : '';
      return `${kind} ${safeName(r.from_address)} → ${safeName(r.to_address || (r.to_city ? 'в ' + r.to_city : '—'))}${when}${price}`;
    }).join('\n');

    await send(user.telegram_id,
      `🟢 <b>Вы на линии. Свободных заявок: ${fit.length}</b>\n\n${lines}` +
      (fit.length > 8 ? `\n\n<i>…и ещё ${fit.length - 8}</i>` : ''),
      { reply_markup: { inline_keyboard: [[wa('Открыть заявки', 'driver')]] } });
  } catch (e) { console.error('sendOpenRides', e.message); }
}


// команды, набранные в группе, до личного обработчика не доходят —
// поэтому отвечаем на них отдельно: убираем из чата и пишем человеку лично
async function groupCommand(m, chatId) {
  const raw = String(m.text || '').trim();
  const cmd = (raw.match(/^\/([a-z_]+)(?:@\w+)?\b/i) || [])[1];
  if (!cmd) return false;
  const known = ['start', 'order', 'driver', 'profile', 'support', 'help'];
  if (!known.includes(cmd.toLowerCase())) return false;

  const uid = m.from && m.from.id;
  const name = (m.from && m.from.first_name) || '';

  // чат чистим — команды в общей ленте только мусорят
  await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});

  const screen = { start: 'home', order: 'order', driver: 'driver', profile: 'profile', support: 'home', help: 'home' }[cmd.toLowerCase()] || 'home';
  const title = {
    start: '🚕 <b>Главное меню</b>',
    order: '🚖 <b>Заказ поездки</b>',
    driver: '🚗 <b>Кабинет водителя</b>',
    profile: '👤 <b>Личный кабинет</b>',
    support: '💬 <b>Связь с админом</b>',
    help: '🚕 <b>Бомбилы</b>'
  }[cmd.toLowerCase()];

  let dmOk = false;
  if (uid) {
    const body = cmd.toLowerCase() === 'support'
      ? `${title}\n\nНапишите сюда, что случилось — я передам администратору, он ответит в этом же чате.`
      : `${title}\n\nКоманды работают здесь, в личном чате со мной, а не в общей группе — там их никто не видит, кроме вас.`;
    const dm = await send(uid, body, cmd.toLowerCase() === 'support'
      ? {}
      : { reply_markup: { inline_keyboard: [[wa('Открыть приложение', screen)]] } });
    dmOk = !!(dm && dm.ok);
  }

  // не запускал бота — лично написать нельзя, зовём коротко в чате
  if (!dmOk) {
    const r = await send(chatId,
      `${name ? safeName(name) + ', к' : 'К'}оманды работают в личном чате с ботом, а не здесь.\nНажмите кнопку — откроется бот.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚕 Открыть бот', url: `https://t.me/${BOT_USERNAME}?start=${screen}` }]] } });
    if (r && r.result) delLater(chatId, r.result.message_id, 60);
  }
  return true;
}


/* ---------- заказ прямо из чата ----------
   Человек пишет в группе «нужна машина, Ленина 12 на рынок».
   Бот убирает сообщение, разбирает адреса и предлагает оформить
   одной кнопкой. Приложение открывать не нужно. */

// вытаскиваем «откуда» и «куда» из живой речи
// «18:30», «завтра 9», «через час», «через 20 минут»
function parseWhen(raw) {
  const t = String(raw || '').toLowerCase().trim();
  const now = new Date();

  let m = t.match(/через\s+(\d{1,3})\s*(мин|час)/);
  if (m) {
    const n = parseInt(m[1], 10);
    return new Date(now.getTime() + n * (m[2] === 'час' ? 3600000 : 60000));
  }
  if (/через\s+час/.test(t)) return new Date(now.getTime() + 3600000);

  m = t.match(/(\d{1,2})[:.\s](\d{2})/);
  let hh = null, mm = 0;
  if (m) { hh = parseInt(m[1], 10); mm = parseInt(m[2], 10); }
  else {
    m = t.match(/(?:в\s+)?(\d{1,2})\s*(?:час\w*|ч)?\b/);
    if (m) { hh = parseInt(m[1], 10); mm = 0; }
  }
  if (hh === null || hh > 23 || mm > 59) return null;

  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hh, mm);
  if (/завтра/.test(t)) d.setDate(d.getDate() + 1);
  else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);  // время уже прошло — значит завтра
  return d;
}

const whenTxt = v => v
  ? new Date(v).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '';

function parseRoute(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();

  // убираем вступление: «нужна машина», «кто отвезёт», «такси».
  // важно: \w не понимает кириллицу, поэтому везде [а-яё]
  const INTRO = [
    /^[^а-яёa-z0-9]*(?:нужн[аоыа-яё]*\s+(?:машин[а-яё]*|такси|водител[а-яё]*))/i,
    /^[^а-яёa-z0-9]*(?:машин[а-яё]*|такси)\s+нужн[а-яё]*/i,
    /^[^а-яёa-z0-9]*кто\s+(?:отвез[её]т|подвез[её]т|свободен|может|сможет)[^а-яё]*/i,
    /^[^а-яёa-z0-9]*(?:подвезите|заберите|отвезите|нужно\s+такси|такси)/i
  ];
  for (const re of INTRO) t = t.replace(re, ' ');
  t = t.replace(/^[\s,.:;!?–—-]*(?:пожалуйста|плиз|срочно|можно|есть кто|привет|здравствуйте)[\s,.:;!?–—-]*/i, ' ');
  t = t.replace(/^[\s,.:;!?–—-]+/, '').trim();

  const cut = s => String(s || '')
    .replace(/^[\s,.:;–—>!?-]+|[\s,.:;–—>!?.]+$/g, '')
    .replace(/^(?:с|со|от|из|по)\s+/i, '')
    .replace(/^(?:на|в|до|к)\s+/i, '')
    .slice(0, 120).trim();

  // «Ленина 12 - рынок», «Ленина 12 → рынок», «Ленина 12 на рынок»
  const seps = [
    /\s*(?:→|➡️?|=>|->)\s*/,
    /\s+[-–—]+\s+/,
    /\s+ехать\s+(?:(?:на|до|в|к)\s+)?/i,
    /\s+едем\s+(?:(?:на|до|в|к)\s+)?/i,
    /\s+(?:на|до|в|к)\s+(?=[а-яёa-z0-9])/i
  ];
  for (const re of seps) {
    const parts = t.split(re);
    if (parts.length >= 2) {
      const a = cut(parts[0]), b = cut(parts.slice(1).join(' '));
      if (a.length >= 3 && b.length >= 2) return { from: a, to: b };
    }
  }
  return { from: cut(t) || null, to: null };
}

// сохраняем черновик целиком: раньше каждый шаг перечислял поля руками,
// и что-нибудь обязательно терялось
function draftPack(d, over) {
  const x = { ...d, ...over };
  return {
    city: x.city || null, from_address: x.from_address || null, to_address: x.to_address || null,
    raw_text: x.raw_text || null, price: x.price || null, kind: x.kind || null,
    to_city: x.to_city || null, scheduled_at: x.scheduled_at || null,
    comment: x.comment || null, stage: x.stage || 'confirm'
  };
}

async function draftSet(tg, d) {
  try { await db.from('chat_draft').upsert({ tg, ...d, created_at: new Date().toISOString() }, { onConflict: 'tg' }); }
  catch (e) { console.error('draftSet', e.message); }
}
async function draftGet(tg) {
  try {
    const { data } = await db.from('chat_draft').select('*').eq('tg', tg).maybeSingle();
    if (!data) return null;
    // через 20 минут черновик протух — человек мог давно уйти
    if (Date.now() - new Date(data.created_at).getTime() > 20 * 60000) { await draftDel(tg); return null; }
    return data;
  } catch (e) { return null; }
}
async function draftDel(tg) { try { await db.from('chat_draft').delete().eq('tg', tg); } catch (e) {} }

const draftKb = d => ({
  reply_markup: { inline_keyboard: [
    [{ text: d && d.price ? `✅ Оформить за ${d.price} ₽` : '✅ Да, оформить', callback_data: 'co:go' }],
    [{ text: d && d.price ? '💰 Изменить цену' : '💰 Назвать свою цену', callback_data: 'co:price' },
     { text: '🔄 Сменить вид', callback_data: 'co:kind' }],
    [{ text: d && d.scheduled_at ? `⏰ ${whenTxt(d.scheduled_at)}` : '⏰ На время', callback_data: 'co:time' },
     { text: d && d.comment ? '💬 Изменить пояснение' : '💬 Добавить пояснение', callback_data: 'co:note' }],
    [{ text: '✏️ Исправить адреса', callback_data: 'co:edit' },
     { text: '✖️ Отмена', callback_data: 'co:no' }]
  ] }
});

// первый шаг: человек сам говорит, что ему нужно.
// раньше бот угадывал по словам и иногда ошибался
async function askKind(chat, d) {
  return send(chat,
    `🚖 <b>Что вам нужно?</b>\n` +
    (d && d.raw_text ? `<i>Вы писали: «${safeName(String(d.raw_text).slice(0, 120))}»</i>\n` : '') +
    `\nВыберите — и я спрошу адреса.`,
    { reply_markup: { inline_keyboard: [
      [{ text: '🚕 Поездка по городу', callback_data: 'co:k:ride' }],
      [{ text: '📦 Доставка, что-то передать', callback_data: 'co:k:delivery' }],
      [{ text: '🛣 В другой город', callback_data: 'co:k:inter' }],
      [{ text: '✖️ Отмена', callback_data: 'co:no' }]
    ] } });
}

// выбор города для межгорода — списком, не текстом
async function askToCity(chat, d) {
  // город пишем текстом: возят и в Ростов, и на побережье — списком всё не охватить.
  // Кнопки оставляем как быстрый выбор для частых направлений
  const { data: cities } = await db.from('cities').select('name').eq('active', true);
  const list = (cities || []).map(c => c.name).filter(n => n && n !== d.city).slice(0, 6);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map(n => ({ text: '🛣 ' + n, callback_data: 'co:c:' + n.slice(0, 40) })));
  }
  rows.push([{ text: '‹ Назад', callback_data: 'co:back' }]);
  return send(chat,
    `🛣 <b>В какой город едем?</b>\nНапишите название — подойдёт любой${list.length ? ', или выберите частое направление кнопкой' : ''}.`,
    { reply_markup: { inline_keyboard: rows, force_reply: true } });
}

// показать черновик и спросить подтверждение
async function draftShow(chat, d) {
  const head = d.kind === 'delivery' ? '📦 <b>Доставка</b>'
             : d.to_city ? '🛣 <b>Поездка в другой город</b>'
             : '🚕 <b>Поездка по городу</b>';
  return send(chat,
    `${head}\n\n` +
    `📍 Откуда: <b>${safeName(d.from_address || '—')}</b>\n` +
    `🏁 Куда: <b>${safeName(d.to_address || '—')}</b>\n` +
    `${d.city ? `🏙 Город: ${safeName(d.city)}\n` : ''}` +
    `${d.to_city ? `🛣 В город: <b>${safeName(d.to_city)}</b>\n` : ''}` +
    `${d.scheduled_at ? `⏰ На время: <b>${whenTxt(d.scheduled_at)}</b>\n` : ''}` +
    `${d.comment ? `💬 ${safeName(d.comment)}\n` : ''}` +
    `${d.price ? `💰 Ваша цена: <b>${d.price} ₽</b>\n` : ''}` +
    `\n${d.price
        ? 'Оформить? Водители увидят вашу цену и смогут согласиться или предложить свою.'
        : 'Оформить заявку? Водители сразу её увидят и назовут цену.\nМожно назвать свою — тогда им останется согласиться.'}`,
    draftKb(d));
}

// куда вести человека дальше — в одном месте, чтобы шаги не разъезжались
// как надо было написать — показываем на его же случае
const HOWTO = (kind) => {
  const w = kind === 'delivery' ? 'Доставка' : 'Поездка';
  return `\n\n<i>Кстати, в следующий раз можно короче — одной строкой в чат:</i>\n` +
         `<code>${w} Ленина 12 — рынок</code>\n` +
         `<i>Главное, чтобы слово «${w}» было первым.</i>`;
};

async function coNextStep(chat, d) {
  if (d.stage === 'ask_kind') return askKind(chat, d);
  if (d.stage === 'ask_tocity') return askToCity(chat, d);
  if (d.stage === 'confirm') return draftShow(chat, d);

  const what = d.kind === 'delivery' ? 'откуда забрать' : 'откуда вас забрать';
  if (d.stage === 'ask_from') {
    // адрес не разобрался — заодно подскажем, как писать, чтобы в следующий раз
    // всё получилось с первого раза
    const hint = d.raw_text && !d.from_address ? HOWTO(d.kind) : '';
    return send(chat,
      `📍 <b>Напишите, ${what}.</b>\n<i>Например: Ленина 12, второй подъезд</i>` + hint,
      { reply_markup: { force_reply: true, input_field_placeholder: 'адрес подачи' } });
  }
  if (d.stage === 'ask_to') {
    return send(chat,
      `📍 Откуда: <b>${safeName(d.from_address)}</b>\n\n` +
      `🏁 <b>Напишите, куда ${d.kind === 'delivery' ? 'доставить' : 'ехать'}.</b>`,
      { reply_markup: { force_reply: true, input_field_placeholder: 'адрес назначения' } });
  }
}

// человек написал заказ в общем чате
async function chatOrderStart(m, chatId, city) {
  const uid = m.from && m.from.id;
  if (!uid) return false;
  const raw = String(m.text || '').trim();

  const { data: u } = await db.from('users')
    .select('id,name,city,role,is_banned,has_phone').eq('telegram_id', uid).maybeSingle();
  if (u && u.is_banned) return false;
  // водителям это меню не нужно — они и так работают в приложении
  if (u && ['driver', 'both'].includes(u.role)) return false;

  const ownCity = (u && u.city) || city.name;

  // если человек начал сообщение со слова «Поездка» или «Доставка» —
  // это его собственный выбор, а не догадка бота: лишний шаг не нужен
  const ow = orderWord(raw);
  const body = ow && ow.rest ? ow.rest : raw;
  const r = parseRoute(body);

  const draft = {
    city: ownCity,
    from_address: r.from, to_address: r.to, raw_text: raw.slice(0, 300),
    kind: null, to_city: null, scheduled_at: null, comment: null, price: null,
    stage: 'ask_kind'
  };

  if (ow && ow.kind === 'delivery') draft.kind = 'delivery';
  else if (ow && ow.kind === 'ride') draft.kind = 'ride';

  if (ow && ow.kind === 'inter') {
    draft.kind = 'ride';
    // «Межгород до Донецка», «Межгород Донецк» — город уже назван, не переспрашиваем
    const mc = String(ow.rest || '').match(/^(?:в|до|на)?\s*([А-ЯЁA-Z][\wа-яё-]{2,24})/);
    if (mc) {
      draft.to_city = mc[1].replace(/[.,;]+$/, '');
      const rest2 = String(ow.rest).slice(mc[0].length).trim();
      if (rest2) { const r2 = parseRoute(rest2); draft.from_address = r2.from; draft.to_address = r2.to; }
      else { draft.from_address = null; draft.to_address = null; }
      draft.stage = draft.from_address && draft.to_address ? 'confirm'
                  : draft.from_address ? 'ask_to' : 'ask_from';
    } else {
      draft.stage = 'ask_tocity';
    }
  } else if (draft.kind) {
    draft.stage = draft.from_address && draft.to_address ? 'confirm'
                : draft.from_address ? 'ask_to' : 'ask_from';
  }

  // не запускал бота — в личку не написать. Но черновик сохраняем:
  // нажмёт «Старт» — и заказ ждёт его там же, ничего не потеряется
  if (!u) {
    await draftSet(uid, draft);
    return false;
  }

  await draftSet(uid, draft);
  const sent = await coNextStep(uid, draft);
  // человек мог заблокировать бота — тогда личка не дошла, и нужно
  // позвать его в чате, иначе сообщение просто исчезнет без следа
  return !!(sent && sent.ok);
}

// человек дописывает адреса в личке
async function chatOrderText(chat, d, text) {
  if (isMenuTap(text)) {
    await send(chat, 'Это кнопка меню. Напишите ответ текстом.');
    return;
  }
  const t = String(text || '').trim().slice(0, 200);
  if (!t) return;

  if (d.stage === 'ask_from') {
    const r = parseRoute(t);
    const nd = { ...d, from_address: r.from || t, to_address: r.to || d.to_address };
    nd.stage = nd.from_address && nd.to_address ? 'confirm' : 'ask_to';
    await draftSet(chat, draftPack(nd, { stage: nd.stage }));
    return coNextStep(chat, nd);
  }

  if (d.stage === 'ask_tocity') {
    const cityName = t.replace(/^(в|до|на)\s+/i, '').slice(0, 40).trim();
    if (cityName.length < 2) {
      return send(chat, 'Напишите название города, например: Донецк.',
        { reply_markup: { force_reply: true, input_field_placeholder: 'город назначения' } });
    }
    const nd = { ...d, kind: 'ride', to_city: cityName };
    const next = nd.from_address && nd.to_address ? 'confirm' : (nd.from_address ? 'ask_to' : 'ask_from');
    await draftSet(chat, draftPack(nd, { stage: next }));
    return coNextStep(chat, { ...nd, stage: next });
  }

  if (d.stage === 'ask_time') {
    const when = parseWhen(t);
    if (!when) {
      return send(chat, 'Не разобрал время. Напишите так: <b>18:30</b>, <b>завтра 9:00</b> или <b>через час</b>.',
        { reply_markup: { force_reply: true, input_field_placeholder: 'например 18:30' } });
    }
    const nd = { ...d, scheduled_at: when.toISOString(), stage: 'confirm' };
    await draftSet(chat, draftPack(nd, { stage: 'confirm' }));
    return draftShow(chat, nd);
  }

  if (d.stage === 'ask_note') {
    const nd = { ...d, comment: t.slice(0, 300), stage: 'confirm' };
    await draftSet(chat, draftPack(nd, { stage: 'confirm' }));
    return draftShow(chat, nd);
  }

  if (d.stage === 'ask_price') {
    const p = Math.max(0, Math.min(100000, parseInt(String(t).replace(/\D+/g, ''), 10) || 0));
    if (!p) {
      return send(chat, 'Не понял цену. Пришлите число, например 300.',
        { reply_markup: { force_reply: true, input_field_placeholder: 'цена в рублях' } });
    }
    const nd = { ...d, price: p, stage: 'confirm' };
    await draftSet(chat, draftPack(nd, { price: p, stage: 'confirm' }));
    return draftShow(chat, nd);
  }

  if (d.stage === 'ask_to') {
    const nd = { ...d, to_address: t, stage: 'confirm' };
    await draftSet(chat, draftPack(nd, { stage: 'confirm' }));
    return coNextStep(chat, nd);
  }
}

// подтвердил — создаём заявку
async function chatOrderCreate(chat) {
  const d = await draftGet(chat);
  if (!d) { await send(chat, 'Черновик устарел. Напишите заказ ещё раз.'); return; }
  if (!d.from_address || !d.to_address) { await send(chat, 'Не хватает адреса. Начните заново.'); await draftDel(chat); return; }

  const { data: u } = await db.from('users')
    .select('id,name,city,is_banned,has_phone').eq('telegram_id', chat).maybeSingle();
  if (!u || u.is_banned) { await send(chat, 'Нет доступа.'); return; }
  { const why = adSpam(d.from_address, d.to_address, d.comment, d.to_city);
    if (why) { await draftDel(chat); adAlert({ ...u, telegram_id: chat }, why, [d.from_address, d.to_address, d.comment].filter(Boolean).join(' | '));
      await send(chat, '🚫 В заявке не должно быть ссылок, @ников и рекламы. Напишите только адреса.'); return; } }

  { const w = await cancelCooldown({ ...u, telegram_id: chat });
    if (w > 0) { await draftDel(chat); await send(chat, `⏳ Вы часто отменяете заявки. Новую можно создать через ${waitTxt(w)}.`); return; } }

  // уже есть активная заявка — вторую не плодим
  const { data: act } = await db.from('rides').select('id,status')
    .eq('passenger_id', u.id).in('status', ['created', 'confirmed', 'in_progress']).maybeSingle();
  if (act) {
    await send(chat, 'У вас уже есть активная заявка. Дождитесь её завершения или отмените в приложении.',
      { reply_markup: { inline_keyboard: [[wa('Открыть заявку', 'order')]] } });
    await draftDel(chat);
    return;
  }

  // без телефона водитель не сможет позвонить
  if (!u.has_phone) {
    await draftSet(chat, draftPack(d, { stage: 'ask_phone' }));
    await send(chat,
      `Остался последний шаг: <b>номер телефона</b>.\nЕго увидит только тот водитель, который возьмёт заказ.`,
      { reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
    return;
  }

  const { data: ride, error } = await db.from('rides').insert({
    passenger_id: u.id, passenger_name: u.name,
    from_address: d.from_address, to_address: d.to_address,
    status: 'created', city: d.city || u.city,
    kind: d.kind === 'delivery' ? 'delivery' : 'ride',
    to_city: d.to_city || null,
    scheduled_at: d.scheduled_at || null,
    comment: d.comment || null,
    source: 'chat',
    passenger_price: d.price || null
  }).select().single();
  if (error) { await send(chat, 'Не получилось создать заявку, попробуйте в приложении.'); return; }

  await draftDel(chat);
  await send(chat,
    `✅ <b>Заявка создана!</b>\n📍 ${safeName(d.from_address)}\n🏁 ${safeName(d.to_address)}\n\n` +
    `${d.price ? `💰 Ваша цена: <b>${d.price} ₽</b>\n\n` : ''}` +
    `${d.price
      ? 'Водители уже её видят. Кто согласен — возьмёт заказ, кто-то может предложить свою цену.'
      : 'Водители уже её видят. Как назовут цену — пришлю сюда, выберете подходящую.'}\n\n` +
    `<i>В следующий раз напишите в чат одной строкой — я сразу пойму:</i>\n` +
    `<code>${d.kind === 'delivery' ? 'Доставка' : 'Поездка'} ${safeName(d.from_address)} — ${safeName(d.to_address)}</code>`,
    { reply_markup: { inline_keyboard: [[wa('Открыть заявку', 'order')]] } });
}


// человек, похоже, хотел заказать, но написал непонятно.
// Сообщение не удаляем (вдруг это обычный разговор), но подсказываем в личку.
const HINT_RE = /(машин|такси|отвез|подвез|довез|доехат|забрат|подкин|бомбил|кто.{0,15}(свободен|работает|на линии)|нужно\s+в|надо\s+в|нужно\s+на|надо\s+на)/i;
const hintAt = new Map();

async function maybeHint(m, chatId, city, text) {
  try {
    const uid = m.from && m.from.id;
    if (!uid) return;
    const line = String(text || '').trim();
    if (line.length < 5 || line.length > 140) return;
    if (!HINT_RE.test(line)) return;
    // благодарности и отзывы — это не попытка заказать
    if (/(спасибо|благодар|отличн|молодец|рекоменду|хорош|вежлив|быстро довез|доволен|довольна)/i.test(line)) return;

    // не чаще раза в 6 часов на человека, чтобы не надоесть
    const last = hintAt.get(uid) || 0;
    if (Date.now() - last < 6 * 3600 * 1000) return;

    const { data: u } = await db.from('users').select('role,is_banned').eq('telegram_id', uid).maybeSingle();
    if (!u || u.is_banned) return;                       // не запускал бота — писать нельзя
    if (['driver', 'both'].includes(u.role)) return;     // водителям не нужно

    hintAt.set(uid, Date.now());
    if (hintAt.size > 2000) hintAt.clear();

    const r = await send(uid,
      `🚖 <b>Похоже, вам нужна машина?</b>\n` +
      `<i>Вы писали в чате: «${safeName(line.slice(0, 100))}»</i>\n\n` +
      `Я не понял, откуда и куда — поэтому заявку не создал.\n\n` +
      `<b>Напишите в чат одной строкой, начиная со слова «Поездка»:</b>\n` +
      `<code>Поездка Ленина 12 — рынок</code>\n` +
      `<code>Доставка аптека Кирова — Шахтёрская 14</code>\n\n` +
      `Или оформите прямо здесь — нажмите кнопку.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚖 Оформить заказ', callback_data: 'co:new' }]] } });
    if (r && r.ok) glog(`${city.name}: подсказал, как писать заказ · ${(m.from && m.from.first_name) || ''}`);
  } catch (e) { console.error('maybeHint', e.message); }
}


/* ---------- проверка новичков ----------
   Простой пример на сложение. Три попытки, вопрос каждый раз новый.
   Не ответил за отведённое время или ошибся трижды — исключаем,
   но не баним: сможет вернуться и попробовать снова. */

const CAP_TRIES = 3;

// права обычного участника — возвращаем их после проверки
const CAP_FULL = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_invite_users: true
};
const CAP_MUTE = { can_send_messages: false, can_send_other_messages: false, can_send_polls: false, can_add_web_page_previews: false };

function capQuestion() {
  const a = 2 + Math.floor(Math.random() * 7);      // 2..8
  const b = 2 + Math.floor(Math.random() * 7);
  const right = a + b;
  const set = new Set([right]);
  while (set.size < 4) {
    const d = right + (Math.floor(Math.random() * 9) - 4);
    if (d > 0 && d !== right) set.add(d);
  }
  const opts = [...set].sort(() => Math.random() - 0.5);
  return { a, b, right, opts };
}

async function capAsk(chatId, who, cityName, edit) {
  const q = capQuestion();
  const name = who.first_name || 'Гость';
  const text = `👋 <b>${safeName(name)}</b>, добро пожаловать!\n\n` +
    `Чтобы писать в чате, решите простой пример — так мы не пускаем сюда спам-ботов.\n\n` +
    `<b>Сколько будет ${q.a} + ${q.b}?</b>`;
  const kb = { inline_keyboard: [q.opts.map(v => ({ text: String(v), callback_data: `cap:${who.id}:${v}` }))] };

  let msgId = edit && edit.msg_id;
  if (msgId) {
    const r = await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
    if (!r || !r.ok) msgId = null;
  }
  if (!msgId) {
    const r = await send(chatId, text, { reply_markup: kb });
    msgId = r && r.result ? r.result.message_id : null;
  }

  await db.from('captcha_wait').upsert({
    chat_id: chatId, tg: who.id, answer: q.right,
    tries: edit && edit.tries ? edit.tries : 0,
    msg_id: msgId, user_name: name, created_at: new Date().toISOString()
  }, { onConflict: 'chat_id,tg' }).then(() => {}, () => {});
}

// запускаем проверку: сначала лишаем права писать
async function capStart(chatId, who, cityName) {
  const r = await tg('restrictChatMember', {
    chat_id: chatId, user_id: who.id, permissions: CAP_MUTE
  });
  if (!r || !r.ok) {
    // нет права ограничивать — проверку пропускаем, иначе человек просто зависнет
    glog(`${cityName}: проверка невозможна, нет прав (${r && r.description ? r.description : '—'})`);
    return false;
  }
  await capAsk(chatId, who, cityName);
  return true;
}

async function capPass(chatId, tgId, msgId) {
  await tg('restrictChatMember', { chat_id: chatId, user_id: tgId, permissions: CAP_FULL }).catch(() => {});
  if (msgId) await tg('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
  await db.from('captcha_wait').delete().eq('chat_id', chatId).eq('tg', tgId);
}

async function capFail(chatId, tgId, msgId, why) {
  // исключаем, но сразу разбаниваем: пусть вернётся и попробует ещё раз
  await tg('banChatMember', { chat_id: chatId, user_id: tgId }).catch(() => {});
  await tg('unbanChatMember', { chat_id: chatId, user_id: tgId, only_if_banned: true }).catch(() => {});
  if (msgId) await tg('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
  await db.from('captcha_wait').delete().eq('chat_id', chatId).eq('tg', tgId);

  // объясним лично, если человек запускал бота
  await send(tgId,
    `Вы не прошли проверку при входе в чат (${why}).\n\nЭто не бан — можете зайти снова и попробовать ещё раз.`)
    .catch(() => {});
}

// не ответившие вовремя
async function capLoop() {
  try {
    const st = await groupSettings();
    const mins = st.captcha_minutes || 10;
    const cut = new Date(Date.now() - mins * 60000).toISOString();
    const { data: old } = await db.from('captcha_wait').select('*').lt('created_at', cut).limit(50);
    for (const c of old || []) await capFail(c.chat_id, c.tg, c.msg_id, 'не ответили вовремя');
  } catch (e) { console.error('capLoop', e.message); }
  setTimeout(capLoop, 60000);
}
setTimeout(capLoop, 90000);


// мягкий режим: заказ в чате не удаляем, а подсказываем под ним.
// Черновик всё равно сохраняем — одна кнопка, и заказ оформлен в боте
async function softOrderReply(m, chatId, city, st, text, isReply) {
  const uid = m.from && m.from.id;
  const name = (m.from && m.from.first_name) || '';
  if (!uid) return;

  // не отвечаем одному человеку чаще раза в пару минут
  const rk = `soft:${chatId}:${uid}`;
  const last = groupReplyAt.get(rk) || 0;
  if (Date.now() - last < 120 * 1000) return;
  groupReplyAt.set(rk, Date.now());

  const isAd = driverAdLike(text);
  let body, btn;

  if (isAd) {
    const { data: au } = await db.from('users').select('role,driver_status').eq('telegram_id', uid).maybeSingle();
    const isDrv = au && ['driver', 'both'].includes(au.role);
    if (isDrv) {
      body = `🚗 ${safeName(name) || 'Коллега'}, заказы удобнее брать в боте — там они идут в ваш рейтинг, а пассажир под защитой.`;
      btn = { text: '🚗 Кабинет водителя', url: `https://t.me/${BOT_USERNAME}?start=driver` };
    } else {
      body = `🚗 ${safeName(name) || 'Коллега'}, возите людей? Оформитесь водителем в Бомбилах — заказы будут приходить вам сами, а карточка с машиной появится в этой группе.`;
      btn = { text: '🚗 Стать водителем', url: `https://t.me/${BOT_USERNAME}?start=driver` };
    }
  } else if (isReply) {
    body = `🚗 Договариваться лучше через бота — там видно все заявки, и поездка пойдёт в рейтинг.`;
    btn = { text: '🚗 Смотреть заявки', url: `https://t.me/${BOT_USERNAME}?start=driver` };
  } else {
    // сохраняем черновик — кнопка откроет бота уже с адресом
    let sentDm = false;
    try { sentDm = await chatOrderStart(m, chatId, city); } catch (e) {}
    body = sentDm
      ? `📩 ${safeName(name) || 'Вам'}, отправил в личку кнопку — оформите заказ там, и его сразу увидят все свободные водители.`
      : `🚖 ${safeName(name) ? safeName(name) + ', о' : 'О'}формите заказ в боте — его сразу увидят все свободные водители, и они назовут цену. Ваш адрес я уже запомнил.`;
    btn = sentDm ? null : { text: '🚖 Оформить заказ', url: `https://t.me/${BOT_USERNAME}?start=chat` };
  }

  const r = await send(chatId, body, {
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    ...(btn ? { reply_markup: { inline_keyboard: [[btn]] } } : {})
  });
  if (r && r.result) delLater(chatId, r.result.message_id, st.group_del_sec ?? 90);
  glog(`${city.name}: мягкий режим — ответил под сообщением · ${name}`);
}


/* ---------- реклама, анкеты и номера в общем чате ----------
   Правило простое: чат — для поездок и разговоров, не доска объявлений.
   Признак рекламы — человек оставляет контакт (номер, ник, «пишите в лс»)
   вместе с рассказом о себе или услуге. Заказы поездок сюда не попадают. */

const AD_WORDS = /(поездки|перевоз|трансфер|межгород|доставк|в любое время|круглосуточн|услуг|недорого|качественн|выезд на дом|на дому|мастер|ремонт|маникюр|педикюр|ресниц|бров|стрижк|парикмах|массаж|репетитор|на заказ|продам|продаю|куплю|скупк|сдам|сниму|аренд|ищу работу|ищу подработ|резюме|анкет|стаж|опыт работы|работаю|подработ|обращайтесь|звоните|пишите|приглашаю|запись)/i;

// такое пишут только продавцы услуг, пассажир так не скажет — реклама даже без контакта
const AD_HARD = /(представительск|любой каприз|за ваши деньги|найд[её]м сауну|сауну,? гостиниц|доставк\S* (еды и )?алкогол|алкогол\S* (круглосуточно|на дом|24))/i;

function selfAdLike(text) {
  const line = deglyph(String(text || '')).replace(/\s+/g, ' ');
  if (line.length < 8) return false;
  if (AD_HARD.test(line)) return true;
  const phone = /(?:\+?7|8)?[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/.test(line);
  const nick = /@[A-Za-z0-9_]{4,}|t\.me\/|wa\.me|viber|whatsapp|ватсап|вайбер/i.test(line);
  const dm = /(в|во)\s*(лс|личк|личные|директ)/i.test(line);
  if (phone) return true;                         // номер в общем чате — всегда объявление
  return (nick || dm) && AD_WORDS.test(line);
}

// заказ поездки с номером («Поездка Ленина 12 — рынок, 8949...») — это не реклама
function orderish(text) {
  // «Межгород круглосуточно, пишите в личку» — это предложение перевозчика, а не заказ
  if (driverAdLike(text) && !routeLine(text)) return false;
  if (orderWord(text) || routeLine(text)) return true;
  // «Ищу работу водителем» — анкета, а не заказ, хоть и со словом «водитель»
  if (/(ищу работу|ищу подработ|резюме|анкет|стаж|опыт работы|услуг|маникюр|ремонт)/i.test(deglyph(text))) return false;
  return looksLikeOrder(text) && !driverAdLike(text);
}

const adHits = new Map();   // сколько раз человек сегодня публиковал рекламу
function adHitAdd(chatId, uid) {
  const k = `${chatId}:${uid}`;
  const v = adHits.get(k);
  const n = v && Date.now() - v.t < 24 * 3600 * 1000 ? v.n + 1 : 1;
  adHits.set(k, { n, t: Date.now() });
  if (adHits.size > 5000) adHits.clear();
  return n;
}

async function adHandle(m, chatId, city, text) {
  const uid = m.from && m.from.id;
  const name = (m.from && m.from.first_name) || '';
  await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});
  if (!uid) return;

  const n = adHitAdd(chatId, uid);
  const quoted = text.length > 300 ? text.slice(0, 300) + '…' : text;

  // третий раз за сутки — сутки без права писать. Не бан: завтра всё вернётся
  let muted = false;
  if (n >= 3) {
    const r = await tg('restrictChatMember', {
      chat_id: chatId, user_id: uid, until_date: Math.floor(Date.now() / 1000) + 24 * 3600,
      permissions: { can_send_messages: false, can_send_other_messages: false, can_send_polls: false, can_add_web_page_previews: false }
    });
    muted = !!(r && r.ok);
  }

  // кто это — от этого зависит, что ему сказать
  let role = null;
  try {
    const { data, error } = await db.from('users').select('role,driver_status').eq('telegram_id', uid).maybeSingle();
    if (!error && data) role = data;
  } catch (e) {}
  const ourDriver = role && role.driver_status === 'approved';
  const isCarrier = driverAdLike(text);

  let body = `📵 ${safeName(name) || 'Здравствуйте'}, я убрал ваше сообщение из чата.\n\n` +
             `<blockquote expandable>${safeName(quoted)}</blockquote>\n\n`;
  let kb = {};
  if (isCarrier && ourDriver) {
    body += `Объявления с номером в группе не публикуются — даже от наших водителей. ` +
            `Включите <b>карточку водителя</b> в кабинете: она сама появляется в группе с вашей машиной и рейтингом, и пассажиры вызывают вас через бота.`;
    kb = { reply_markup: { inline_keyboard: [[wa('🚗 Открыть кабинет', 'driver')]] } };
  } else if (isCarrier) {
    body += `Реклама перевозок в группе не публикуется. Но вы можете возить через нас — это бесплатно:\n` +
            `• заказы приходят сами, не нужно сидеть в чате\n` +
            `• ваша карточка с машиной и рейтингом появляется в группе\n` +
            `• пассажиры видят, что вы проверены`;
    kb = { reply_markup: { inline_keyboard: [[wa('🚗 Стать водителем', 'driver')]] } };
  } else {
    body += `В этой группе не публикуются реклама, анкеты и номера телефонов — иначе чат превращается в доску объявлений, и в нём теряются заказы. Спасибо за понимание!`;
  }
  if (muted) body += `\n\n⏸ Это уже третье объявление за сутки, поэтому писать в группе можно будет завтра.`;
  else if (n === 2) body += `\n\n⚠️ Если объявление появится ещё раз, писать в группе будет нельзя до завтра.`;

  const dm = await send(uid, body, kb);
  glog(`${city.name}: реклама убрана (${n}-я за сутки${muted ? ', запрет на сутки' : ''}) · ${name}`);

  // в личку не дошло — коротко в чате, но только при первом случае за сутки,
  // иначе бот сам станет шумом. Сообщение исчезает через полминуты
  if (!(dm && dm.ok) && n === 1) {
    const r = await send(chatId,
      `📵 ${safeName(name) ? safeName(name) + ', р' : 'Р'}еклама, анкеты и номера телефонов в этой группе не публикуются.`,
      isCarrier ? { reply_markup: { inline_keyboard: [[{ text: '🚗 Возить через Бомбилы', url: `https://t.me/${BOT_USERNAME}?start=driver` }]] } } : {});
    if (r && r.result) delLater(chatId, r.result.message_id, 30);
  }
}


/* ---------- карточки заказов в общей группе города ----------
   Без адреса: группа открытая, туда вступает кто угодно. Адрес получает
   только проверенный водитель — в личку, после нажатия «Взять заказ».
   Остальным бот предлагает пройти верификацию. Заодно группа видит,
   что заказы идут и их разбирают. */

function groupCardText(r) {
  const kind = (r.kind === 'delivery' ? '📦 Доставка' : r.to_city ? '🛣 Межгород' : '🚕 Поездка') + (r.biz_name ? ` от магазина · 🏪 ${safeName(r.biz_name)}` : '');
  const when = r.scheduled_at
    ? `\n⏰ На ${new Date(r.scheduled_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  const to = r.to_city ? ` → ${safeName(r.to_city)}` : '';
  const rk = r.biz_id && bizRankTxt() ? `\n🏅 Брать могут водители ${bizRankTxt()}` : '';
  return `🔔 <b>Новая заявка</b>\n${kind} · ${safeName(r.city)}${to}${when}${rk}\n\n` +
         `Хотите взять заказ — нажмите кнопку.\n<i>Адрес увидит только проверенный водитель.</i>`;
}

async function groupFeedPublish(ride) {
  try {
    const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (!st || !st.group_orders_on) return;
    const { data: city } = await db.from('cities').select('group_id').eq('name', ride.city).maybeSingle();
    if (!city || !city.group_id) return;
    const r = await tg('sendMessage', {
      chat_id: city.group_id, text: groupCardText(ride), parse_mode: 'HTML',
      disable_web_page_preview: true, disable_notification: true,
      reply_markup: { inline_keyboard: [
        [{ text: '🚗 Взять заказ (водителям)', callback_data: `gtake:${ride.id}`, style: 'primary' }],
        [{ text: '🚖 Заказать', url: ORDER_LINK, style: 'success' }, { text: '💬 Через бота', url: BOT_ORDER_LINK }]
      ] }
    });
    if (r && r.ok) {
      await db.from('ride_feed_group').upsert({
        ride_id: ride.id, chat_id: city.group_id, message_id: r.result.message_id, state: 'open'
      });
    }
  } catch (e) { glog('заказы в группе: ' + e.message); }
}

async function groupFeedUpdate(rideId, state) {
  try {
    const { data: f } = await db.from('ride_feed_group').select('*').eq('ride_id', rideId).maybeSingle();
    if (!f || f.state === state) return;
    const { data: ride } = await db.from('rides').select('*').eq('id', rideId).maybeSingle();
    if (!ride) return;
    // текст «взяли за 4 минуты» / «не состоялся» — тот же, что в канале водителей, без адреса
    await tg('editMessageText', {
      chat_id: f.chat_id, message_id: f.message_id,
      text: feedText(ride, state), parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: ORDER_KB
    }).catch(() => {});
    await db.from('ride_feed_group').update({ state }).eq('ride_id', rideId);
  } catch (e) { glog('заказы в группе: ' + e.message); }
}

// нажали «Взять заказ» в группе. Ответ во всплывающем окне видит только нажавший
async function groupTake(cq, rideId) {
  const uid = cq.from.id;
  const answer = (text, extra) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: true, ...(extra || {}) });

  const { data: ride, error: e1 } = await db.from('rides')
    .select('*')
    .eq('id', rideId).maybeSingle();
  if (e1) return answer('Сервис временно недоступен, попробуйте через минуту.');
  if (!ride || ride.driver_id || !String(ride.status || '').startsWith('created')) {
    return answer('Этот заказ уже взяли или отменили.');
  }

  const { data: u } = await db.from('users')
    .select('*').eq('telegram_id', uid).maybeSingle();
  if (u && u.is_banned) return answer('Нет доступа.');

  // не водитель — ведём на верификацию: кнопка сразу открывает бота
  if (!u || u.driver_status !== 'approved') {
    if (u && u.driver_status === 'pending') {
      return answer('Ваша заявка на водителя ещё на проверке. Как одобрим — заказы начнут приходить вам сами.');
    }
    return tg('answerCallbackQuery', { callback_query_id: cq.id, url: `https://t.me/${BOT_USERNAME}?start=verify` });
  }

  if (ride.biz_id && !bizRankOk(u)) return answer(`Заказы магазинов берут водители ${bizRankTxt()}. Получите звание — и они станут доступны.`);
  // проверенный водитель — адрес и действия в личку
  const kind = ride.kind === 'delivery' ? '📦 Доставка' : ride.to_city ? `🛣 Межгород в ${safeName(ride.to_city)}` : '🚕 Поездка';
  const when = ride.scheduled_at
    ? `\n⏰ На ${new Date(ride.scheduled_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
  const dm = await send(uid,
    `${kind} · ${safeName(ride.city)}${when}\n` +
    `📍 ${safeName(ride.from_address)}\n🏁 ${safeName(ride.to_address)}` +
    `${ride.passenger_price ? `\n💰 Пассажир предлагает: <b>${ride.passenger_price} ₽</b>` : ''}` +
    `${ride.comment ? `\n💬 ${safeName(ride.comment)}` : ''}`,
    { reply_markup: { inline_keyboard: [
      [{ text: '✅ Назвать цену', callback_data: `take:${ride.id}`, style: 'success' }],
      [{ text: '💬 Уточнить у пассажира', url: `https://t.me/${BOT_USERNAME}?start=ask_${ride.id}` }],
      [wa('Открыть в приложении', 'driver')]
    ] } });
  if (dm && dm.ok) return answer('Отправил заказ вам в личку — там адрес и кнопка «Назвать цену».');
  return tg('answerCallbackQuery', { callback_query_id: cq.id, url: `https://t.me/${BOT_USERNAME}?start=driver` });
}

/* ---------- long polling ---------- */
let offset = 0;
async function poll() {
  try {
    // chat_member нужен отдельно: без него телеграм не сообщает о людях,
    // вступивших по ссылке-приглашению — а таких большинство
    const allowed = encodeURIComponent(JSON.stringify([
      'message', 'edited_message', 'callback_query', 'chat_member', 'my_chat_member'
    ]));
    const r = await fetch(API('getUpdates') + `?timeout=30&offset=${offset}&allowed_updates=${allowed}`);
    const j = await r.json();
    if (j.ok) for (const u of j.result) { offset = u.update_id + 1; await onUpdate(u); }
  } catch (e) { /* сеть моргнула — продолжаем */ }
  setTimeout(poll, 300);
}

/* ---------- уведомления ---------- */
const tgIdOf = async id => (await db.from('users').select('telegram_id').eq('id', id).maybeSingle()).data?.telegram_id;

// редкие проверки (отзывы, итоги смен, промокоды) хватает делать раз в минуту —
// раньше всё подряд опрашивалось каждые 4 секунды и съедало трафик базы
let notifyTick = 0;
async function notifyLoop() {
    const slow = (notifyTick++ % 15) === 0;
    try {
      // новая заявка -> водителям
      const { data: rides } = await db.from('rides').select('*').eq('status', 'created').eq('notified', false);
      for (const r of rides || []) {
        let q = db.from('users').select('id,telegram_id,rank_code,rank_paused').eq('status', 'online').in('role', ['driver', 'both']);
        if (r.kind === 'delivery') q = q.or('delivery.eq.true,vehicle_type.eq.moto'); // мотокурьеры получают доставку всегда
        else q = q.or('vehicle_type.is.null,vehicle_type.eq.car');  // мотоциклы возят только доставку
        if (r.to_city) q = q.eq('intercity', true);
        if (r.target_driver_id) q = db.from('users').select('id,telegram_id').eq('id', r.target_driver_id);
        const { data: drv } = await q;
        const isDel = r.kind === 'delivery';
        const isInter = !!r.to_city;
        const head = r.target_driver_id
          ? (isDel ? '🎯 <b>Доставка лично вам</b>' : isInter ? '🎯 <b>Межгород лично вам</b>' : '🎯 <b>Заявка лично вам</b>')
          : r.biz_id ? `📦 <b>Доставка от точки</b>\n🏪 ${safeName(r.biz_name)} — проверенная точка`
          : (isDel ? '📦 <b>Новая доставка</b>' : isInter ? `🛣 <b>Межгород в ${r.to_city}</b>` : '🚕 <b>Новая заявка</b>');
        const schedLine = r.scheduled_at
        ? `\n🕒 <b>На ${new Date(r.scheduled_at).toLocaleString('ru', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>`
        : '';
      const extra = `${schedLine}${r.to_city ? `\n🛣 Город назначения: <b>${r.to_city}</b>` : ''}${r.passenger_price ? `\n💰 ${r.biz_id ? 'Точка' : 'Пассажир'} предлагает: <b>${r.passenger_price} ₽</b>` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}${r.biz_id ? `\n💳 Доставку оплачивает: ${bizPayerTxt(r.biz_payer)}\n🔒 Телефон и квартира получателя — после того как вас выберут` : ''}`;
        // рассылаем и сразу запоминаем, кому ушло — иначе потом не понять,
        // кто заявку видел и промолчал, а кто вообще её не получал
        const notifRows = [];
        for (const d of drv || []) {
          if (!d.telegram_id) continue;
          if (r.biz_id && !r.target_driver_id && !bizRankOk(d)) continue;      // заказы точек — со звания
          const ok = await send(d.telegram_id, `${head}\n📍 ${r.from_address}\n🏁 ${r.to_address}\nОт: ${r.passenger_name || 'пассажир'}${extra}`,
            { reply_markup: { inline_keyboard: [[
              { text: 'Открыть заявку', web_app: { url: appUrl('driver', null, { ride: r.id }) } }
            ]] } });
          notifRows.push({ ride_id: r.id, driver_id: d.id, delivered: !!(ok && ok.ok) });
        }
        if (notifRows.length) {
          await db.from('ride_notify').upsert(notifRows, { onConflict: 'ride_id,driver_id', ignoreDuplicates: true })
            .then(() => {}, () => {});
        }
        await db.from('rides').update({ notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['новая заявка -> водителям'] = e.message; console.error('notify:новая заявка -> водителям', e.message); }

    try {
      // отклик -> пассажиру
      const { data: offs } = await db.from('offers').select('*').eq('notified', false).eq('status', 'pending');
      for (const o of offs || []) {
        const { data: ride } = await db.from('rides').select('passenger_id,to_address,biz_id').eq('id', o.ride_id).maybeSingle();
        if (ride) {
          const tid = await tgIdOf(ride.passenger_id);
          const dtg = await tgIdOf(o.driver_id);
          const carTxt = o.car ? `\n🚗 ${safeName(o.car)}` : '';
          let rankTxt = '';
          if (ranksReady && RCFG.feat.offerBadge) {
            const { data: du } = await db.from('users').select('*').eq('id', o.driver_id).maybeSingle();
            if (du && du.rank_code && !du.rank_paused && RANK_NAMES[du.rank_code]) rankTxt = `\n🏅 Звание: ${RANK_NAMES[du.rank_code]}`;
          }
          let sent = null;
          if (tid) sent = await send(tid, `💰 <b>${safeName(o.driver_name) || 'Водитель'} назвал цену: ${o.price} ₽</b>${carTxt}${rankTxt}\nМаршрут: ${safeName(ride.to_address)}`,
            { reply_markup: { inline_keyboard: [
              [{ text: `✅ Согласен, ${o.price} ₽`, callback_data: `acc:${o.id}` }],
              ...(dtg ? [[{ text: '✍️ Написать водителю', callback_data: `ask:${o.ride_id}:${dtg}` }]] : []),
              [wa('Посмотреть все предложения', ride.biz_id ? 'biz' : 'order')]
            ] } });
          // запоминаем сообщение — если водитель поправит цену, погасим его
          if (sent && sent.ok && sent.result) {
            await db.from('offers')
              .update({ notify_msg_id: sent.result.message_id, notify_chat: tid })
              .eq('id', o.id).then(() => {}, () => {});
          }
        }
        await db.from('offers').update({ notified: true }).eq('id', o.id);
      }

    } catch (e) { notifyErrors['отклик -> пассажиру'] = e.message; console.error('notify:отклик -> пассажиру', e.message); }

    try {
      // выбрали -> водителю
      const { data: conf } = await db.from('rides').select('*').eq('status', 'confirmed').eq('driver_notified', false);
      for (const r of conf || []) {
        const schedTxt = r.scheduled_at
        ? `\n🕒 <b>На ${new Date(r.scheduled_at).toLocaleString('ru', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>`
        : '';
      const route = `📍 <b>Откуда:</b> ${r.from_address}\n🏁 <b>Куда:</b> ${r.to_address}${schedTxt}${r.price ? `\n💰 <b>Цена:</b> ${r.price} ₽` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}`;

        // водителю — контакты пассажира
        if (r.driver_id) {
          const tid = await tgIdOf(r.driver_id);
          if (tid) {
            const card = r.biz_id ? await bizDriverCard(r) : await contactCard(r.passenger_id, 'Пассажир');
            await send(tid, `${r.scheduled_at ? '🕒 <b>Вас выбрали на определённое время</b>\n<i>Приезжайте к назначенному часу, не сейчас.</i>' : '✅ <b>Вас выбрали!</b>'}\n\n${route}${card}`,
              { reply_markup: { inline_keyboard: [
                [wa('Открыть заказ', 'driver')],
                [{ text: '🏁 Завершить поездку', callback_data: `done:${r.id}` }]
              ] } });
          }
        }
        // пассажиру — контакты водителя
        if (r.passenger_id) {
          const tid = await tgIdOf(r.passenger_id);
          if (tid) {
            const card = await contactCard(r.driver_id, r.biz_id ? 'Курьер' : 'Водитель');
            await send(tid, `${r.biz_id ? '📦 <b>Курьер взял доставку</b>' : r.scheduled_at ? '🕒 <b>Водитель принял заказ на время</b>' : '🚕 <b>Водитель принял заказ</b>'}\n\n${route}${card}`,
              { reply_markup: { inline_keyboard: [
                [r.biz_id ? wa('🏪 Открыть точку', 'biz') : wa('Открыть поездку', 'order')],
                [{ text: '🏁 Завершить поездку', callback_data: `done:${r.id}` }]
              ] } });
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
          if (tid) await send(tid, r.biz_id
            ? `${base}${drvName ? `\n👤 <b>Курьер:</b> ${drvName}${drvCar ? ` (${drvCar})` : ''}` : ''}`
            : `${base}${drvName ? `\n👤 <b>Водитель:</b> ${drvName}${drvCar ? ` (${drvCar})` : ''}` : ''}\n\nОцените поездку — это поможет другим пассажирам.`,
            { reply_markup: { inline_keyboard: [[r.biz_id ? wa('🏪 Открыть точку', 'biz') : wa('Оценить', 'order')]] } });
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

    if (slow) try {
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
        if (tid) await send(tid, r.biz_id
          ? `🚗 <b>Курьер у вас</b>\nПодъехал за заказом: ${safeName(r.to_address)}`
          : `🚗 <b>Водитель на месте</b>\n${r.from_address}\nМашина ждёт вас.`);
        await db.from('rides').update({ arrived_notified: true }).eq('id', r.id);
      }

    } catch (e) { notifyErrors['водитель приехал -> пассажиру'] = e.message; console.error('notify:водитель приехал -> пассажиру', e.message); }

    if (slow) try {
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

    if (slow) try {
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
    if (slow) try {
      // одна сторона оценила -> напоминаем второй
      const cut2 = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      // ГЛАВНАЯ УТЕЧКА ТРАФИКА была здесь: поездки, по которым никто не
      // оставил оценку, никогда не помечались — и 50 полных строк читались
      // заново каждые 4 секунды, круглые сутки. Теперь только свежие поездки,
      // только нужные поля, а без оценок через сутки — помечаем и забываем
      const since2 = new Date(Date.now() - 3 * 864e5).toISOString();
      const { data: fin2 } = await db.from('rides')
        .select('id,driver_id,passenger_id,from_address,to_address,created_at')
        .eq('status', 'completed').eq('review_nudged', false).gte('created_at', since2).limit(50);
      for (const r of fin2 || []) {
        if (!r.driver_id || !r.passenger_id) {
          await db.from('rides').update({ review_nudged: true }).eq('id', r.id); continue;
        }
        const { data: revs } = await db.from('reviews').select('from_id,created_at').eq('ride_id', r.id);
        if (!revs || revs.length === 0) {
          if (Date.now() - new Date(r.created_at).getTime() > 864e5)
            await db.from('rides').update({ review_nudged: true }).eq('id', r.id);
          continue;
        }
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
    // заказ на время сюда не попадает: он ждёт своего времени (ниже)
    const { data: old } = await db.from('rides').select('*').eq('status', 'created').is('scheduled_at', null).lt('created_at', cut);
    for (const r of old || []) {
      await db.from('rides').update({ status: 'expired' }).eq('id', r.id);
      const tid = await tgIdOf(r.passenger_id);
      if (tid) await send(tid, `⌛️ <b>Заявка устарела</b>\n${r.from_address} → ${r.to_address}\nНикто не откликнулся за 10 минут. Если поездка ещё нужна — создайте новую.`,
        { reply_markup: { inline_keyboard: [[wa('Создать новую', 'order')]] } });
    }
    // заказ на время: прошло 15 минут после назначенного времени, а водителя так и нет
    const cutS = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: oldS } = await db.from('rides').select('*').eq('status', 'created').not('scheduled_at', 'is', null).lt('scheduled_at', cutS);
    for (const r of oldS || []) {
      await db.from('rides').update({ status: 'expired' }).eq('id', r.id);
      const tid = await tgIdOf(r.passenger_id);
      const at = new Date(r.scheduled_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (tid) await send(tid, `⌛️ <b>Заказ на ${at} так никто и не взял</b>\n${safeName(r.from_address)} → ${safeName(r.to_address)}\nЕсли поездка ещё нужна — создайте новую.`,
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
// «ехать», «еду», «надо на» — движение без слова «такси»
const MOVE_RE = /(ехать|ехат|едем|еду|едет|поехал|поеха|съездит|надо на |надо в |нужно на |нужно в |нада на |нада в | до )/;

// адрес: слово подлиннее и сразу число — «первомайская 2», «комсомольская 33».
// Два таких куска в одном сообщении почти всегда означают маршрут,
// даже если ни одного ключевого слова про такси нет.
const NOT_ADDR = /^(лет|год|года|годов|час|часа|часов|мин|минут|руб|рубл|грн|гривен|км|кг|штук|раз|человек|дней|день|недел|месяц|тысяч|номер|тел)$/;
function addrCount(t) {
  let n = 0;
  const re = /([а-яё]{4,})\s*(?:д\.?\s*)?(\d{1,3})(?![\d])/g;
  let m;
  while ((m = re.exec(t))) if (!NOT_ADDR.test(m[1])) n++;
  return n;
}

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

// «Ватутино — Город», «Соцгород - центр», «Ватутино на Город».
// В маленьком городе половина адресов — названия районов, без домов.
const PLACE_RE = /(центр|вокзал|рынок|базар|больниц|поликлин|автостанц|автовокзал|парк|школ|садик|аптек|магазин|шахт|пос[её]лок|мкр|микрорайон|квартал|кольцо|остановк|общежит|терминал|переезд)/i;
const STOPV = /^(работаю|работал|работала|живу|жил|учусь|купил|купила|продам|куплю|смотрю|сижу|стою|иду|еду|хочу|думаю|погода|привет|спасибо|поздравляю)$/i;

// слова, которые точно не адрес: оценки, эмоции, обычная болтовня
const NONPLACE = /^(супер|класс|отлично|хорошо|плохо|дорого|дёшево|дешево|вкусно|вкусный|вкусная|ужас|жесть|правда|неправда|шутка|ерунда|ясно|понятно|спасибо|пожалуйста|конечно|наверное|точно|да|нет|норм|нормально|круто|топ|бомба|огонь|жизнь|боль|любовь|судьба|деньги|время|счастье|проблема|вопрос|ответ|дело|мысли|планы|погода|люди|всё|все|ничего|что|как|кто|где|когда)$/i;
// предлоги внутри части маршрута — признак обычной фразы, а не адреса
const PREP_WORD = /^(в|на|с|со|и|у|о|к|из|по|за|до|от|не|же|ли|бы|то)$/i;

function placeLike(part) {
  const p = String(part || '').trim();
  if (!p) return false;
  const first = p.split(/\s+/)[0];
  if (STOPV.test(first)) return false;                  // начинается с глагола — не адрес
  if (/\d/.test(p)) return true;                       // есть номер дома
  if (PLACE_RE.test(p)) return true;                    // известное место
  return /^[А-ЯЁ]/.test(p);                             // название с большой буквы
}

// «фильтровальная», «пятая школа» — одно-два слова, похожие на название.
// Слабый признак: годится, только если вторая сторона маршрута уже надёжна
function weakPlace(part) {
  const p = String(part || '').trim();
  if (!p || p.length < 4 || p.length > 25) return false;
  const words = p.split(/\s+/);
  if (words.length > 2) return false;
  if (words.some(w => NONPLACE.test(w) || STOPV.test(w) || PREP_WORD.test(w))) return false;
  return /^[а-яёА-ЯЁ][а-яёА-ЯЁ\- ]{3,}$/.test(p);
}

// человек сам помечает сообщение словом-командой — угадывать не нужно.
// «Заказ Ленина 12 - рынок», «Доставка аптека — Шахтёрская 14»
// \b не работает с кириллицей — вместо него запрет на продолжение слова,
// иначе «Заказал вчера пиццу» тоже считался бы командой
const ORDER_WORD = /^\s*(заказ|заказать|поездка|поездку|такси|машина|машину|доставка|доставку|доставить|межгород|курьер)(?![а-яё])[\s,:.—-]*/i;

function orderWord(text) {
  const m = String(text || '').match(ORDER_WORD);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const rest = String(text).slice(m[0].length).trim();
  const kind = /доставк|доставить|курьер/.test(w) ? 'delivery'
             : /межгород/.test(w) ? 'inter'
             : /поездк|такси|машин/.test(w) ? 'ride'
             : null;                       // «заказ» — вид спросим
  return { kind, rest };
}

function routeLine(text) {
  const line = String(text || '').trim().replace(/\s+/g, ' ');
  if (!line || line.length > 60) return false;
  if (/(продам|куплю|отдам|меняю|сдам|сниму|руб|₽|цена|торг)/i.test(line)) return false;

  const short = p => p && p.length <= 25 && p.split(' ').length <= 3;

  // «А — Б» через тире или стрелку: обе стороны должны быть похожи на место
  const m = line.match(/^(.{2,30}?)\s*(?:[-–—]|→|=>|->)\s*(.{2,30})$/);
  if (m) {
    const a = m[1].trim(), b = m[2].trim();
    // одна сторона должна быть надёжной, вторая может быть просто названием:
    // «Ватутина - фильтровальная» — тоже маршрут
    const strongA = placeLike(a) && !NONPLACE.test(a), strongB = placeLike(b) && !NONPLACE.test(b);
    if (short(a) && short(b) &&
        ((strongA && (strongB || weakPlace(b))) ||
         (strongB && weakPlace(a)) ||
         (weakPlace(a) && weakPlace(b)))) return true;
  }

  // «с Ватутино в центр»
  const m2 = line.match(/^(?:с|со|от|из)\s+(.{2,25}?)\s+(?:на|до|в|к)\s+(.{2,25})$/i);
  if (m2 && placeLike(m2[1].trim()) && placeLike(m2[2].trim())) return true;

  // «Ватутино на Город» — без предлога в начале
  const m3 = line.match(/^([А-ЯЁа-яё0-9.\-]{3,25})\s+(?:на|до|в)\s+(.{2,25})$/);
  if (m3 && !STOPV.test(m3[1]) && placeLike(m3[1]) && placeLike(m3[2].trim())) return true;

  return false;
}

// человек рекламирует себя как перевозчика: телефон + слова про перевозки
function driverAdLike(text) {
  const line = String(text || '').replace(/\s+/g, ' ');
  // явная реклама услуг — это не заказ, что бы там ни было ещё
  if (AD_HARD.test(deglyph(line))) return true;
  // пассажир просит («нужно такси…, звоните 8949…») — это заказ, не реклама
  const asks = /(нужн|надо|ищу (такси|машин|водител)|кто (отвез|довез|может|свободен|едет)|подскажите|можно заказать|закаж)/i.test(line);
  const phone = /(?:\+?7|8)?[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/.test(line);
  // «Поездки ЛДНР/РФ, в любое время, в лс!» — номера нет, но зовут в личку
  const dm = /(в|во)\s*(лс|личк|личные|директ)|@[A-Za-z0-9_]{4,}/i.test(line);
  // слова именно предложения услуги: пассажир, который пишет «напишите в лс», их не использует
  if (dm && /(поездки|перевоз|трансфер|в любое время|круглосуточн|24\/7|лднр|по рф|с постами|всего чего|возим|вожу)/i.test(line)) return true;
  if (!phone) return false;
  // предложение от первого лица: «отвезу», «довезу», «могу сделать доставку»
  if (!asks && /(отвезу|довезу|доставлю|могу сделать|сделаю доставк|доставк\S* продукт|круглосуточн|24\/7|в любое время|обращайтесь|по городу и|недорого)/i.test(line)) return true;
  return /(работаю|вожу|возим|катаю|межгород|побереж|бус\b|минивэн|микроавтобус|багажник|мест\b|пассажир|комфорт|трезв|аккуратн|недорого|подача|таксую|на линии|выезжа|поеду|еду в|еду до|могу забрать|заберу|подвезу|подброшу|свободен|свободна|попутн|направлени|есть места|места есть|междугород|опытн\w* водител|переезд|грузоперевоз)/i.test(line);
}

function looksLikeOrder(text) {
  const t = norm(text);
  if (!t) return false;

  // реклама перевозчика — проверяем первой: такие объявления часто длинные,
  // с эмодзи и списками, и отсечка по длине их пропускала
  if (driverAdLike(text)) return true;

  if (t.length > 260) return false;

  // сообщение целиком — короткий сигнал
  if (SOLO.includes(t)) return true;
  if (SOLO_RE.test(t)) return true;

  if (PAST_RE.test(t)) return false;

  // короткая фраза с глаголом перевозки — почти всегда про поездку
  // «Отвезёте?», «Подвезёте до вокзала», «Заберёте с Ленина 42»
  if (t.length <= 80 && VERB_RE.test(t)) return true;

  const hasTrip = TRIP_RE.test(t);

  // человек сам написал «Заказ» или «Доставка» — это точно заявка
  if (ORDER_WORD.test(String(text || ''))) return true;

  // короткий маршрут без номеров домов: «Ватутино — Город», «Ленина 12 - рынок».
  // Проверяем раньше отсечки про магазины: «рынок» тут — это пункт назначения
  if (routeLine(text)) return true;

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

  // маршрут без ключевых слов: «Первомайская 2 подъезд 4 ехать Комсомольская 33».
  // Тут нет ни «такси», ни «подвезите» — только два адреса и «ехать».
  const addrs = addrCount(t);
  if (addrs >= 2) return true;
  if (addrs >= 1 && MOVE_RE.test(t)) return true;

  return false;
}

const groupReplyAt = new Map();   // когда последний раз отвечали в чате
const groupLog = [];              // последние события из групп — для диагностики
function glog(msg) {
  groupLog.unshift(new Date().toLocaleTimeString('ru') + ' — ' + msg);
  if (groupLog.length > 12) groupLog.pop();
}

async function delLater(chatId, messageId, sec) {
  const n = Number(sec);
  if (!n || n <= 0) return;                    // 0 — сообщение остаётся навсегда
  setTimeout(() => { tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {}); }, n * 1000);
}

async function groupSettings() {
  try {
    // берём настройки целиком: если какой-то колонки ещё нет,
    // запрос по списку полей падает и группа перестаёт работать вовсе
    const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) { glog('настройки группы не читаются — ' + error.message); return {}; }
    return data || {};
  } catch (e) { return {}; }
}

// группа наша, если её id прописан у какого-то города
// последние известные группы городов: если база недоступна, бот всё равно
// узнаёт свою группу и продолжает чистить спам. Раньше при сбое базы
// он считал группу чужой и не трогал вообще ничего
const groupCache = new Map([
  ['-1003876675606', { name: 'Енакиево', group_link: 't.me/bombily_enk' }],
  ['-1004308723949', { name: 'Горловка', group_link: 't.me/bombily_gorlovka' }]
]);
/* ---------- журнал: вступления в группы и /start (v163) ---------- */
async function tgLog(row) { try { await db.from('tg_events').insert(row); } catch (e) {} }
async function groupKind(chatId) {
  try {
    const { data } = await db.from('cities').select('name,group_id,driver_group_id')
      .or(`group_id.eq.${Number(chatId)},driver_group_id.eq.${Number(chatId)}`).limit(1);
    const c = data && data[0];
    if (!c) return null;
    return { city: c.name, type: String(c.driver_group_id) === String(chatId) ? 'drivers' : 'city' };
  } catch (e) { return null; }
}
async function cityByGroup(chatId) {
  try {
    const { data, error } = await db.from('cities').select('name,group_link').eq('group_id', chatId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) groupCache.set(String(chatId), data);
    return data || null;
  } catch (e) {
    const c = groupCache.get(String(chatId));
    // настройки в этот момент тоже не читаются, поэтому заказы и приветствия
    // сами выключаются — остаётся только защита от спама
    return c ? { ...c, offline: true } : { name: 'группа', group_link: null, offline: true };
  }
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
          `👋 ${names.join(', ')}, добро пожаловать в <b>Bombily | ${city.name}</b>\n\nЗдесь новости и объявления. Машину вызывайте кнопками ниже. Адрес увидите только вы и водитель.`,
          { reply_markup: ORDER_KB });
        if (r && r.result) delLater(chatId, r.result.message_id, st.group_welcome_sec ?? 120);
      }
    }
    return;
  }

  const text = String(m.text || m.caption || '');
  if (m.from && m.from.is_bot) return;

  // команды вроде /driver или /order, набранные в чате: отвечаем лично
  if (text.startsWith('/')) {
    try { if (await groupCommand(m, chatId)) return; } catch (e) { console.error('groupCommand', e.message); }
  }

  // администраторов группы не трогаем
  let isAdminHere = false;
  try {
    const cm = await tg('getChatMember', { chat_id: chatId, user_id: m.from && m.from.id });
    if (cm && cm.ok && ['creator', 'administrator'].includes(cm.result.status)) isAdminHere = true;
    if (cm && cm.ok) tagCheck(m, chatId, cm.result).catch(() => {});
  } catch (e) {}

  // спам ловим первым делом — до всякой модерации заказов
  if (st.antispam_on !== false && !isAdminHere && (text || m.sender_chat)) {
    const spamUid = (m.sender_chat && m.sender_chat.id) || (m.from && m.from.id);
    const res = spamScore(text, {
      senderChat: !!m.sender_chat,
      forwarded: !!(m.forward_origin || m.forward_from || m.forward_from_chat),
      isNew: recentJoin.has(`${chatId}:${m.from && m.from.id}`),
      name: m.from ? `${m.from.first_name || ''} ${m.from.last_name || ''}`.trim() : '',
      strikes: strikesOf(chatId, spamUid)
    });
    // объявление перевозчика — не спам, а возможный водитель: его удалит
    // модерация и позовёт оформиться. Баним только если там запрещёнка
    const isDriverAd = driverAdLike(text) && !/запрещённое/.test(res.why);
    if (res.score >= 5 && !isDriverAd) { await spamHandle(m, chatId, city, st, res); return; }
  }

  // реклама, анкеты и номера телефонов — убираем, даже если база недоступна
  if (st.group_no_ads !== false && !isAdminHere && text && selfAdLike(text) && !orderish(text)) {
    await adHandle(m, chatId, city, text);
    return;
  }

  if (!st.group_moderate) { glog(`${city.name}: приходят сообщения, но «убирать заказы» выключено`); return; }
  if (!text) return;
  if (isAdminHere) { glog(`${city.name}: писал администратор — пропускаем · «${preview}»`); return; }

  const isOrder = looksLikeOrder(text);
  const isReply = !isOrder && looksLikeDriverReply(text);
  if (!isOrder && !isReply) {
    // похоже, человек всё-таки хотел заказать, но написал так, что не разобрать.
    // Сообщение не трогаем, а в личку подсказываем, как надо
    await maybeHint(m, chatId, city, text);
    glog(`${city.name}: не похоже на заказ · «${preview}»`);
    return;
  }

  // мягкий режим: сообщение не трогаем, а отвечаем под ним, как оформить
  if (st.group_order_mode === 'reply') {
    await softOrderReply(m, chatId, city, st, text, isReply);
    return;
  }

  const del = await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id });
  if (del && del.ok) glog(`${city.name}: УДАЛЕНО · «${preview}»`);
  else glog(`${city.name}: удалить не вышло (${del && del.description ? del.description : 'нет прав?'}) · «${preview}»`);

  const name = m.from && m.from.first_name ? m.from.first_name : '';
  const fromId = m.from && m.from.id;

  // это заказ пассажира — не читаем нотацию, а сразу предлагаем оформить:
  // человеку остаётся одно нажатие, приложение открывать не надо
  if (!isReply && fromId && !driverAdLike(text)) {
    try {
      if (await chatOrderStart(m, chatId, city)) {
        glog(`${city.name}: предложил оформить заказ из чата · ${name}`);
        return;
      }
    } catch (e) { console.error('chatOrderStart', e.message); }
  }

  // сначала пробуем написать человеку лично — так он не чувствует себя
  // отчитанным при всех, и сразу получает кнопку, куда идти.
  // Личка возможна, только если он раньше запускал бота.
  let dmOk = false;
  if (fromId) {
    const quoted = text.length > 300 ? text.slice(0, 300) + '…' : text;

    // водитель рекламировал себя с номером — ему нужен другой разговор,
    // а не предложение оформить заявку
    const { data: au } = await db.from('users').select('role,driver_status').eq('telegram_id', fromId).maybeSingle();
    const isDrv = au && ['driver', 'both'].includes(au.role);
    const isAd = driverAdLike(text);

    // предлагает возить, но у нас не оформлен — зовём подать заявку,
    // иначе он просто уйдёт работать мимо сервиса
    if (isAd && !isDrv && !isReply) {
      const pending = au && au.driver_status === 'pending';
      const dm3 = await send(fromId,
        `🚗 <b>Вы предлагаете поездки?</b>\n` +
        `Я убрал объявление из чата — реклама с личным номером там запрещена.\n\n` +
        `<blockquote expandable>${safeName(quoted)}</blockquote>\n\n` +
        (pending
          ? `Ваша заявка на водителя уже на проверке — как одобрим, заказы начнут приходить сюда автоматически.`
          : `Оформитесь у нас как водитель — это бесплатно и занимает пару минут:\n\n` +
            `• заказы приходят вам сами, не надо сидеть в чате\n` +
            `• ваша карточка с машиной и рейтингом публикуется в группе\n` +
            `• пассажиры видят, что вы проверены — доверия больше\n` +
            `• поездки идут в рейтинг, и постоянные клиенты возвращаются к вам`),
        pending ? {} : { reply_markup: { inline_keyboard: [[wa('🚗 Стать водителем', 'driver')]] } });
      if (dm3 && dm3.ok) { glog(`${city.name}: позвал оформиться водителем · ${name}`); return; }
    }

    if (isDrv && isAd && !isReply) {
      const dm2 = await send(fromId,
        `🚗 Я убрал ваше объявление из чата.

` +
        `<blockquote expandable>${safeName(quoted)}</blockquote>

` +
        `Реклама с личным номером запрещена: такие поездки не попадают в ваш рейтинг, ` +
        `а пассажир остаётся без защиты — если что-то пойдёт не так, мы не сможем помочь ни ему, ни вам.

` +
        `Чтобы вас видели: включите смену и карточку водителя в кабинете — она сама публикуется в группе с вашей машиной и рейтингом.`,
        { reply_markup: { inline_keyboard: [[wa('Открыть кабинет', 'driver')]] } });
      if (dm2 && dm2.ok) { glog(`${city.name}: объявление водителя убрано · ${name}`); return; }
    }

    const dmText = isReply
      ? `🚗 ${name ? name + ', в' : 'В'}ы ответили на заказ в чате — я убрал сообщение.\n\n` +
        `<blockquote expandable>${safeName(quoted)}</blockquote>\n\n` +
        `Заявки принимаются только в приложении: там видно все свободные заказы, ` +
        `а поездка попадёт в ваш рейтинг. В чате договариваться нельзя — ни вам, ни пассажиру не будет защиты.`
      : `🚖 ${name ? name + ', я' : 'Я'} убрал ваше сообщение из чата — заказы там не работают.\n\n` +
        `<blockquote expandable>${safeName(quoted)}</blockquote>\n\n` +
        `Давайте оформлю как заявку: её сразу увидят все свободные водители, ` +
        `они назовут цену, а вы выберете подходящую. Ваш номер и адрес не увидит никто, кроме того, кто возьмёт заказ.`;
    const dm = await send(fromId, dmText, {
      reply_markup: { inline_keyboard: [[wa(isReply ? '🚗 Смотреть заявки' : '🚖 Оформить заказ', isReply ? 'driver' : 'order')]] }
    });
    dmOk = !!(dm && dm.ok);
    glog(`${city.name}: ${dmOk ? 'написал в личку' : 'в личку не дошло (не запускал бота)'} · ${name}`);
  }
  // дошло лично — в чате не пишем, чтобы не позорить человека и не сорить
  if (dmOk) return;

  // не частим с ответами — но считаем по человеку, а не по всей группе:
  // иначе двое написали заказ подряд, и второй молча терял сообщение
  const rk = `${chatId}:${fromId || 0}`;
  const last = groupReplyAt.get(rk) || 0;
  if (Date.now() - last < 60 * 1000) return;
  groupReplyAt.set(rk, Date.now());
  if (groupReplyAt.size > 3000) groupReplyAt.clear();

  const txtOrder = `🚖 ${name ? safeName(name) + ', я' : 'Я'} сохранил ваш заказ — осталось нажать кнопку.\n\nОткроется бот, там будет ваш адрес и кнопка «Оформить». Водители сразу увидят заявку и назовут цену.\n<i>Ваш номер и адрес видит только тот, кто возьмёт заказ.</i>`;
  const txtReply = `🚗 ${name ? safeName(name) + ', з' : 'З'}аказы принимаются только в боте Bombily.\n\nТам видно все свободные заявки, а поездка засчитается в ваш рейтинг. Договариваться в чате нельзя.`;
  const r = await send(chatId, isReply ? txtReply : txtOrder,
    { reply_markup: { inline_keyboard: [[{ text: isReply ? '🚗 Смотреть заявки' : '🚖 Забрать мой заказ', url: `https://t.me/${BOT_USERNAME}?start=chat` }]] } });
  if (r && r.result) delLater(chatId, r.result.message_id, st.group_del_sec ?? 90);
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
  const head = `🚖 <b>Вызвать машину — кнопки внизу</b> 👇\n<i>Бомбилы · ${city}</i>`;
  const foot = `\n\n🔒 Адрес видит только водитель — в чат его писать не нужно.`;
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

// список машин, которые сейчас на линии в городе.
// всплывашка Telegram вмещает ~200 знаков, поэтому режем и дописываем «и ещё N»
async function carsOnLine(cityName) {
  const { data } = await db.from('users')
    .select('car, vehicle_type')
    .eq('city', cityName)
    .eq('role', 'driver')
    .eq('driver_status', 'online')
    .eq('is_banned', false);

  const list = data || [];
  if (!list.length) return 'Сейчас на линии никого нет.\n\nОставьте заказ в боте — он придёт всем водителям.';

  const cars = list.map(d => {
    const c = (d.car || '').trim();
    if (c) return c;
    return d.vehicle_type === 'moto' ? 'мотоцикл' : 'машина не указана';
  });

  const head = `На линии ${cars.length} ${plural(cars.length, ['машина', 'машины', 'машин'])}:\n`;
  const out = [];
  let len = head.length;
  for (const c of cars) {
    if (len + c.length + 3 > 185) break;
    out.push(c); len += c.length + 3;
  }
  const rest = cars.length - out.length;
  return head + out.map(c => '• ' + c).join('\n') + (rest > 0 ? `\n…и ещё ${rest}` : '');
}

async function updatePin(city, renewHours) {
  const kb = ORDER_KB;
  const s = await cityStats(city.name);
  const text = pinText(city.name, s);

  let { data: pin } = await db.from('group_pins').select('*').eq('city_name', city.name).maybeSingle();

  // пора показать сводку заново — удаляем старую и отправляем свежую вниз чата
  if (pin && pin.message_id && renewHours !== 0) {
    const last = pin.renewed_at ? new Date(pin.renewed_at).getTime() : 0;
    if (renewHours === -1 || Date.now() - last > renewHours * 3600 * 1000) {
      await tg('unpinChatMessage', { chat_id: city.group_id, message_id: pin.message_id }).catch(() => {});
      await tg('deleteMessage', { chat_id: city.group_id, message_id: pin.message_id }).catch(() => {});
      await db.from('group_pins').delete().eq('city_name', city.name);
      pin = null;
    }
  }

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
    last_text: text, updated_at: new Date().toISOString(),
    renewed_at: new Date().toISOString()
  });
  glog(`${city.name}: закреп создан`);
}

async function pinLoop() {
  let mins = 5;
  try {
    // берём настройки целиком: если колонки ещё нет, запрос по имени падает
    const { data: st, error: stErr } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (stErr) glog('закреп: не читаются настройки — ' + stErr.message);
    if (st && st.pin_minutes) mins = Math.max(2, Number(st.pin_minutes));
    const renew = st && st.pin_renew_hours ? Number(st.pin_renew_hours) : 0;
    if (st && st.pin_enabled) {
      const { data: cities } = await db.from('cities').select('name,group_id').not('group_id', 'is', null);
      for (const c of cities || []) {
        try { await updatePin(c, renew); } catch (e) { glog(`${c.name}: закреп — ${e.message}`); }
      }
    }
  } catch (e) { console.error('pinLoop', e.message); }
  setTimeout(pinLoop, mins * 60 * 1000);
}


/* ============ карточка водителя в группе города ============
   водитель включает тумблер — его карточка появляется в чате.
   раз в N минут публикуется заново (старая убирается),
   между публикациями обновляется только статус: свободен / занят. */

async function driverStatusNow(d) {
  if (d.status !== 'online') return 'offline';
  const { data: busy } = await db.from('rides')
    .select('id').eq('driver_id', d.id).in('status', ['confirmed', 'in_progress']).limit(1);
  return (busy && busy.length) ? 'busy' : 'free';
}

// звание в карточке водителя: «· 🥉 Бронза» (на паузе — не показываем)
function rankBit(d) {
  const RE = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💠', diamond: '💎' };
  if (!d || !d.rank_code || d.rank_paused || !RE[d.rank_code]) return '';
  return ` · ${RE[d.rank_code]} ${RANK_NAMES[d.rank_code]}`;
}

function driverCardText(d, state, reviews) {
  const car = d.vehicle_type === 'moto'
    ? (d.car ? d.car + ' · мотоцикл' : 'мотоцикл')
    : (d.car || 'машина не указана');
  const rate = Number(d.rating || 5).toFixed(1);
  const cnt = reviews ? ` (${reviews} ${plural(reviews, ['отзыв', 'отзыва', 'отзывов'])})` : '';
  const mark = state === 'free' ? '🟢 <b>Свободен</b>'
             : state === 'busy' ? '🔴 <b>Занят</b> — сейчас на заказе'
             : '⚫ Не на линии';

  const lines = [
    `🚗 <b>${safeName(noContacts(d.name) || 'Водитель')}</b>${rankBit(d)} · ⭐ ${rate}${cnt}`,
    car
  ];
  if (d.spot) lines.push(`📍 Стоит: ${safeName(noContacts(d.spot))}`);
  const extra = [];
  if (d.delivery) extra.push('берёт доставку');
  if (d.intercity) extra.push('возит в другие города');
  if (extra.length) lines.push(extra.join(' · '));
  lines.push('');
  lines.push(mark);
  return lines.join('\n');
}

function driverCardKb(d, state) {
  if (state !== 'free') return {};
  return { reply_markup: { inline_keyboard: [[
    { text: `🚖 Вызвать ${d.name || 'водителя'}`, url: `https://t.me/${BOT_USERNAME}?start=drv_${d.id}`, style: 'success' }
  ]] } };
}

// сколько минут между публикациями
async function dpostMinutes() {
  try {
    const { data } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    const n = data && data.dpost_minutes;
    return Number.isFinite(Number(n)) && Number(n) >= 5 ? Number(n) : 30;
  } catch (e) { return 30; }
}

let dpostFirst = true;   // после перезапуска один раз обновляем все карточки (новый текст)
async function driverPostsLoop() {
  try {
    const everyMin = await dpostMinutes();
    const { data: drivers } = await db.from('users')
      .select('*')
      .eq('show_in_group', true).eq('is_banned', false);

    for (const d of drivers || []) {
      try {
        const { data: city } = await db.from('cities')
          .select('name,group_id').eq('name', d.city).maybeSingle();
        if (!city || !city.group_id) continue;

        const { data: post } = await db.from('driver_posts')
          .select('*').eq('driver_id', d.id).maybeSingle();

        const state = await driverStatusNow(d);

        // ушёл с линии — карточку убираем
        if (state === 'offline') {
          if (post && post.message_id) {
            await tg('deleteMessage', { chat_id: post.chat_id, message_id: post.message_id }).catch(() => {});
            await db.from('driver_posts').delete().eq('driver_id', d.id);
          }
          continue;
        }

        const { count: reviews } = await db.from('reviews')
          .select('id', { count: 'exact', head: true }).eq('driver_id', d.id);

        const text = driverCardText(d, state, reviews || 0);
        const kb = driverCardKb(d, state);
        const nowMs = Date.now();
        const lastMs = post && post.last_post_at ? new Date(post.last_post_at).getTime() : 0;
        const needRepost = !post || !post.message_id || (nowMs - lastMs) >= everyMin * 60000;

        if (needRepost) {
          // публикуем заново, старую карточку убираем
          if (post && post.message_id) {
            await tg('deleteMessage', { chat_id: post.chat_id, message_id: post.message_id }).catch(() => {});
          }
          const r = await tg('sendMessage', {
            chat_id: city.group_id, text, parse_mode: 'HTML',
            disable_web_page_preview: true, ...kb
          });
          if (r && r.ok) {
            await db.from('driver_posts').upsert({
              driver_id: d.id, city: d.city, chat_id: city.group_id,
              message_id: r.result.message_id,
              last_post_at: new Date().toISOString(), last_status: state
            });
          }
        } else if (post.last_status !== state || dpostFirst) {
          // между публикациями меняем только статус
          const r = await tg('editMessageText', {
            chat_id: post.chat_id, message_id: post.message_id,
            text, parse_mode: 'HTML', disable_web_page_preview: true, ...kb
          });
          if (r && r.ok) await db.from('driver_posts').update({ last_status: state }).eq('driver_id', d.id);
        }
      } catch (e) { glog(`карточка ${d.name}: ${e.message}`); }
    }
  } catch (e) { console.error('driverPosts', e.message); }
  dpostFirst = false;
  setTimeout(driverPostsLoop, 60 * 1000);      // проверяем раз в минуту
}
setTimeout(driverPostsLoop, 45 * 1000);

/* ---------- зов на линию (v168) ----------
   Заявка ждёт водителя дольше N минут, а свободных водителей в городе не хватает —
   бот пишет водителям, которые сейчас не на линии, но недавно заходили. Без адресов и цен.
   Когда заявки разобрали (или они закрылись) — то же сообщение меняется само.
   Вышел по зову и довёз — +баллы (если включено). Ночью — только тем, кто сам включил.
   Настройки — settings.call_cfg (панель «Ещё → Зов на линию»), журнал — call_log и call_sent.
   Пока миграции db-29 нет — всё молчит. */
const CALL_DEF = { on: true, waitMin: 4, cooldownMin: 120, perWave: 15, gapMin: 15, activeDays: 14, nightFrom: 23, nightTo: 7, bonus: 2 };
const CALL_LIM = { waitMin: [1, 9], cooldownMin: [30, 1440], perWave: [1, 50], gapMin: [5, 180], activeDays: [1, 60], nightFrom: [0, 23], nightTo: [0, 23], bonus: [0, 20] };
let CCFG = { ...CALL_DEF };
let callReady = false;

function callCfgClean(c) {
  const src = c && typeof c === 'object' ? c : {};
  const out = { on: src.on === undefined ? CALL_DEF.on : !!src.on };
  for (const k of Object.keys(CALL_LIM)) {
    const [lo, hi] = CALL_LIM[k];
    const v = src[k] === null || src[k] === '' ? NaN : Number(src[k]);
    out[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : CALL_DEF[k];
  }
  return out;
}
async function callCfgLoad() {
  try {
    const { data } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    CCFG = callCfgClean(data && data.call_cfg);
  } catch (e) {}
  return CCFG;
}
// таблицы из миграции db-29 на месте?
async function callCheck() {
  try { const { error } = await db.from('call_log').select('id').limit(1); callReady = !error; }
  catch (e) { callReady = false; }
  return callReady;
}
function callNight(cfg = CCFG) {
  const h = localHour();
  if (cfg.nightFrom === cfg.nightTo) return false;
  return cfg.nightFrom > cfg.nightTo ? (h >= cfg.nightFrom || h < cfg.nightTo) : (h >= cfg.nightFrom && h < cfg.nightTo);
}
// подходит ли водитель под заявку — как в списке заявок у водителя
function callFits(d, r) {
  if (r.biz_id && typeof bizRankOk === 'function' && !bizRankOk(d)) return false;
  if (d.vehicle_type === 'moto') return r.kind === 'delivery';
  if (r.kind === 'delivery' && !d.delivery) return false;
  if (r.to_city && !d.intercity) return false;
  return true;
}
function callKinds(rides) {
  let ride = 0, del = 0, ic = 0;
  for (const r of rides) { if (r.kind === 'delivery') del++; else if (r.to_city) ic++; else ride++; }
  return [ride ? `🚕 ${ride}` : '', del ? `📦 ${del}` : '', ic ? `🛣 ${ic}` : ''].filter(Boolean).join(' · ');
}
function callText(city, rides, free) {
  return `🔥 <b>${safeName(city)}: ждут водителя</b>\n\n` +
    `Заявок без водителя: <b>${rides.length}</b> (${callKinds(rides)})` +
    (free ? '' : '\nСвободных водителей на линии нет.') +
    `\n\nВыйдете на линию — заявки придут сразу.`;
}
const CALL_OFF_KB = { inline_keyboard: [[{ text: '🔕 Не звать меня', callback_data: 'call:off' }]] };

// раз в минуту: закрыть отработавшие волны, позвать водителей, где ждут
let callBusy = false;
async function callLoop() {
  if (callBusy) return;
  callBusy = true;
  try {
    if (!callReady && !(await callCheck())) return;
    await callCfgLoad();
    await callClose();
    if (CCFG.on) await callWave();
  } catch (e) { console.error('call', e.message); }
  finally { callBusy = false; }
}

async function callWave() {
  const now = Date.now();
  // ждут дольше N минут; через 10 минут заявка сама закрывается — такие уже не трогаем
  const { data: rides } = await db.from('rides').select('*')
    .eq('status', 'created').is('driver_id', null).is('scheduled_at', null)
    .lt('created_at', new Date(now - CCFG.waitMin * 60e3).toISOString())
    .gt('created_at', new Date(now - 10 * 60e3).toISOString());
  const byCity = {};
  for (const r of rides || []) {
    if (r.target_driver_id || !r.city) continue;          // заявку для конкретного водителя видит только он
    (byCity[r.city] = byCity[r.city] || []).push(r);
  }
  const cities = Object.keys(byCity);
  const out = [];
  if (!cities.length) return out;
  const night = callNight();
  let paid = false;
  try { const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle(); paid = !!(st && st.paid_mode); } catch (e) {}

  for (const city of cities) {
    const waiting = byCity[city];
    // один город — не чаще раза в gapMin минут
    const { data: last } = await db.from('call_log').select('created_at').eq('city', city).order('created_at', { ascending: false }).limit(1);
    if (last && last[0] && now - new Date(last[0].created_at).getTime() < CCFG.gapMin * 60e3) continue;

    const { data: drv } = await db.from('users').select('*').eq('city', city)
      .in('role', ['driver', 'both']).eq('driver_status', 'approved').limit(1000);
    const all = (drv || []).filter(d => !d.is_banned);
    const { data: busy } = await db.from('rides').select('driver_id').eq('city', city).in('status', ['confirmed', 'in_progress']);
    const busySet = new Set((busy || []).map(x => String(x.driver_id)));
    const free = all.filter(d => d.status === 'online' && !busySet.has(String(d.id)));
    // зовём, если какую-то заявку некому взять или заявок больше, чем свободных
    const uncovered = waiting.filter(r => !free.some(d => callFits(d, r)));
    if (!uncovered.length && waiting.length <= free.length) continue;
    const need = uncovered.length ? uncovered : waiting;

    const cand = all.filter(d => d.status !== 'online' && d.telegram_id && d.call_on !== false
        && (!night || d.call_night === true)
        && d.last_active && now - new Date(d.last_active).getTime() <= CCFG.activeDays * 864e5
        && (!d.call_at || now - new Date(d.call_at).getTime() >= CCFG.cooldownMin * 60e3)
        && (!paid || (d.sub_until && new Date(d.sub_until).getTime() > now))
        && need.some(r => callFits(d, r)))
      .sort((a, b) => new Date(b.last_active) - new Date(a.last_active))
      .slice(0, CCFG.perWave);
    if (!cand.length) continue;

    const { data: log, error } = await db.from('call_log').insert({
      city, waiting: waiting.length, free: free.length, sent: 0, ride_ids: waiting.map(r => String(r.id)).join(',')
    }).select('id').maybeSingle();
    if (error || !log) continue;

    const text = callText(city, waiting, free.length);
    const rows = [];
    for (const d of cand) {
      const r = await send(d.telegram_id, text, { reply_markup: { inline_keyboard: [
        [wa('🟢 Выйти на линию', 'driver', { id: d.telegram_id, first_name: d.name })],
        [{ text: '🔕 Не звать меня', callback_data: 'call:off' }]
      ] } }).catch(() => null);
      if (r && r.ok && r.result) rows.push({ call_id: log.id, user_id: String(d.id), tg_id: d.telegram_id, msg_id: r.result.message_id, sent_at: new Date(now).toISOString() });
    }
    if (rows.length) await db.from('call_sent').insert(rows);
    // отметку ставим всем, кого пробовали: заблокировавших бота не дёргаем каждую волну
    await db.from('users').update({ call_at: new Date(now).toISOString() }).in('id', cand.map(d => d.id));
    await db.from('call_log').update(rows.length ? { sent: rows.length }
      : { sent: 0, closed_at: new Date().toISOString(), outcome: 'none' }).eq('id', log.id);
    out.push({ city, sent: rows.length, waiting: waiting.length, free: free.length });
  }
  return out;
}

// заявки разобрали или они закрылись — меняем сообщения, чтобы никто не выходил зря
async function callClose() {
  const { data: open } = await db.from('call_log').select('*').is('closed_at', null).order('created_at').limit(20);
  for (const w of open || []) {
    const ids = String(w.ride_ids || '').split(',').filter(Boolean);
    let rs = [];
    if (ids.length) { const { data } = await db.from('rides').select('id,status,driver_id').in('id', ids); rs = data || []; }
    const still = rs.filter(r => r.status === 'created' && !r.driver_id);
    if (still.length && Date.now() - new Date(w.created_at).getTime() < 12 * 60e3) continue;
    const taken = rs.some(r => r.driver_id && ['confirmed', 'in_progress', 'completed'].includes(r.status));
    const outcome = taken ? 'taken' : still.length ? 'timeout' : 'gone';
    await db.from('call_log').update({ closed_at: new Date().toISOString(), outcome }).eq('id', w.id);
    const { data: msgs } = await db.from('call_sent').select('tg_id,msg_id').eq('call_id', w.id).not('msg_id', 'is', null);
    const text = outcome === 'taken'
      ? '✅ <b>Заявки уже разобрали</b>\nСпасибо! Позову снова, когда будут ждать водителя.'
      : '⌛️ <b>Уже неактуально</b>\nЗаявки закрылись. Позову снова, когда будут ждать водителя.';
    for (const m of msgs || []) {
      await tg('editMessageText', { chat_id: m.tg_id, message_id: m.msg_id, text, parse_mode: 'HTML', reply_markup: CALL_OFF_KB }).catch(() => {});
    }
  }
}

// водитель вышел на линию — если его недавно звали, отмечаем
async function callCame(userId) {
  if (!callReady || !userId) return;
  await db.from('call_sent').update({ online_at: new Date().toISOString() })
    .eq('user_id', String(userId)).is('online_at', null)
    .gte('sent_at', new Date(Date.now() - 30 * 60e3).toISOString());
}

// поездка завершена: водитель вышел по зову и взял этот заказ — отмечаем и даём баллы
async function callTook(rideId) {
  if (!callReady || !rideId) return;
  try {
    const { data: r } = await db.from('rides').select('*').eq('id', rideId).maybeSingle();
    if (!r || r.status !== 'completed' || !r.driver_id) return;
    const tc = new Date(r.confirmed_at || r.created_at).getTime();
    const { data } = await db.from('call_sent').select('*').eq('user_id', String(r.driver_id)).is('ride_id', null)
      .not('online_at', 'is', null)
      .gte('sent_at', new Date(tc - 60 * 60e3).toISOString()).lte('sent_at', new Date(tc).toISOString())
      .order('sent_at', { ascending: false }).limit(1);
    const cs = data && data[0];
    if (!cs || new Date(cs.online_at).getTime() > tc) return;
    const { data: mark } = await db.from('call_sent').update({ ride_id: String(r.id) }).eq('id', cs.id).is('ride_id', null).select('id');
    if (!mark || !mark.length) return;                         // эту отметку уже поставили
    const t1 = r.completed_at ? new Date(r.completed_at).getTime() : Date.now();
    const short = t1 - tc < ((RCFG && RCFG.lim && RCFG.lim.minMinutes) || 5) * 60000;
    if (!CCFG.bonus || r.auto_closed || short) return;
    const ok = await ptAdd(r.driver_id, CCFG.bonus, 'call', ptRoute(r), 'call:' + cs.id, { ride_id: String(r.id) });
    if (ok) {
      await db.from('call_sent').update({ bonus: true }).eq('id', cs.id);
      await rankRecalc(r.driver_id);
    }
  } catch (e) { console.error('callTook', e.message); }
}

// кнопки «Не звать меня» / «Звать снова» под сообщением
async function callToggle(cq, on) {
  const uid = cq.from && cq.from.id;
  const { error } = await db.from('users').update({ call_on: on }).eq('telegram_id', uid);
  if (error) { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' }); return; }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: on ? 'Хорошо, буду звать' : 'Хорошо, больше не позову' });
  const m = cq.message;
  if (!m || !m.message_id) return;
  // это сообщение больше не трогаем, когда волна закроется
  if (!on && callReady) await db.from('call_sent').update({ msg_id: null }).eq('tg_id', uid).eq('msg_id', m.message_id);
  await tg('editMessageText', {
    chat_id: m.chat ? m.chat.id : uid, message_id: m.message_id, parse_mode: 'HTML',
    text: on ? '🔔 <b>Хорошо, снова буду звать</b>\nКогда заявки ждут водителя, а свободных нет — напишу.'
             : '🔕 <b>Хорошо, больше не позову</b>\nВключить снова — кнопкой ниже или в приложении: Заявки → Настройки смены.',
    ...(on ? {} : { reply_markup: { inline_keyboard: [[{ text: '🔔 Звать снова', callback_data: 'call:on' }]] } })
  }).catch(() => {});
}

// строка для утренней сводки
async function callReportLine(y0, t0) {
  if (!callReady) return '';
  try {
    const { data: w } = await db.from('call_log').select('id,sent').gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString());
    const waves = (w || []).filter(x => x.sent > 0);
    if (!waves.length) return '';
    const { data: s } = await db.from('call_sent').select('online_at,ride_id').in('call_id', waves.map(x => x.id));
    const came = (s || []).filter(x => x.online_at).length, took = (s || []).filter(x => x.ride_id).length;
    return `📣 Звали на линию: ${waves.length} ${plural(waves.length, ['раз', 'раза', 'раз'])} · вышли ${came} · довезли ${took}`;
  } catch (e) { return ''; }
}

// панель: правила и итоги
function callCfgDiff(a, b) {
  const L = { on: 'включено', waitMin: 'ждёт дольше, мин', cooldownMin: 'одного не чаще, мин', perWave: 'за раз', gapMin: 'город не чаще, мин',
    activeDays: 'заходили за, дн', nightFrom: 'ночь с', nightTo: 'ночь до', bonus: 'баллы' };
  return Object.keys(L).filter(k => a[k] !== b[k]).map(k => `${L[k]}: ${k === 'on' ? (b[k] ? 'да' : 'нет') : b[k]}`).join('; ');
}
async function callAdmin(me, act, body) {
  if (act === 'call-cfg-get') {
    await callCfgLoad();
    if (!callReady) await callCheck();
    return { ok: true, ready: callReady, cfg: CCFG, def: CALL_DEF, lim: CALL_LIM };
  }
  if (act === 'call-cfg-set') {
    const next = callCfgClean(body.cfg);
    const diff = callCfgDiff(CCFG, next);
    if (!diff) return { ok: true, cfg: CCFG, same: true };
    const { error } = await db.from('settings').update({ call_cfg: next }).eq('id', 1);
    if (error) return { code: 500, ok: false, error: /call_cfg/.test(error.message) ? 'no_column' : 'save_failed' };
    CCFG = next;
    await audit(me, 'call-cfg', null, null, diff);
    return { ok: true, cfg: CCFG, diff };
  }
  if (act === 'call-stats') {
    if (!callReady && !(await callCheck())) return { ok: true, missing: true };
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: w } = await db.from('call_log').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(300);
    const waves = (w || []).filter(x => x.sent > 0);
    let s = [];
    if (waves.length) s = await ptAll(() => db.from('call_sent').select('call_id,online_at,ride_id,bonus').in('call_id', waves.map(x => x.id)).order('id'), 5);
    const per = {};
    for (const x of s) { const p = per[x.call_id] = per[x.call_id] || { came: 0, took: 0 }; if (x.online_at) p.came++; if (x.ride_id) p.took++; }
    const rows = waves.slice(0, 20).map(x => ({ at: x.created_at, city: x.city, waiting: x.waiting, free: x.free, sent: x.sent,
      outcome: x.outcome || null, came: (per[x.id] || {}).came || 0, took: (per[x.id] || {}).took || 0 }));
    const tot = { waves: waves.length, sent: waves.reduce((a, x) => a + (x.sent || 0), 0),
      came: s.filter(x => x.online_at).length, took: s.filter(x => x.ride_id).length };
    const { count: off } = await db.from('users').select('*', { count: 'exact', head: true }).eq('call_on', false).in('role', ['driver', 'both']);
    return { ok: true, tot, rows, off: off || 0 };
  }
  return { code: 400, ok: false, error: 'unknown' };
}
setTimeout(() => { callLoop().catch(() => {}); }, 50 * 1000);
setInterval(() => { callLoop().catch(() => {}); }, 60 * 1000);
/* ---------- конец: зов на линию ---------- */

/* ---------- v177: «Работа водителей» — статистика и снятие допуска у давно неработающих ---------- */
async function workAdmin(me, act, body) {
  if (act === 'work-list') {
    const days = [7, 30].includes(Number(body.days)) ? Number(body.days) : 7;
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const drv = await ptAll(() => db.from('users').select('*').eq('driver_status', 'approved').order('id'), 5);
    if (!drv.length) return { ok: true, days, rows: [] };
    const ids = new Set(drv.map(d => String(d.id)));
    const [sh, of, rd, last] = await Promise.all([
      ptAll(() => db.from('shifts').select('driver_id,started_at,ended_at,minutes').gte('started_at', since).order('started_at'), 20),
      ptAll(() => db.from('offers').select('driver_id,status').gte('created_at', since).order('created_at'), 50),
      ptAll(() => db.from('rides').select('driver_id,status,cancelled_by').gte('created_at', since).not('driver_id', 'is', null).order('created_at'), 50),
      ptAll(() => db.from('rides').select('driver_id,completed_at').eq('status', 'completed').not('driver_id', 'is', null).order('completed_at', { ascending: false }), 50)
    ]);
    const S = {}; const g = id => S[id] = S[id] || { mins: 0, offers: 0, done: 0, refused: 0, last_ride: null };
    for (const x of sh) { if (!ids.has(String(x.driver_id))) continue;
      const m = x.minutes || (x.ended_at ? 0 : Math.round((Date.now() - new Date(x.started_at)) / 60000));
      g(x.driver_id).mins += Math.max(0, Math.min(m, days * 1440)); }
    for (const x of of) if (ids.has(String(x.driver_id))) g(x.driver_id).offers++;
    for (const x of rd) { if (!ids.has(String(x.driver_id))) continue;
      if (x.status === 'completed') g(x.driver_id).done++;
      else if (x.cancelled_by === 'driver') g(x.driver_id).refused++; }
    for (const x of last) { if (!ids.has(String(x.driver_id))) continue; const o = g(x.driver_id); if (!o.last_ride) o.last_ride = x.completed_at; }
    const rows = drv.filter(d => d.staff_role !== 'owner').map(d => { const o = g(d.id); return {
      id: d.id, name: d.name, tag: d.telegram_id ? String(d.telegram_id).slice(-4) : '', city: d.city, rating: d.rating,
      rank: d.rank_code || null, rank_paused: !!d.rank_paused, online: d.status === 'online', banned: !!d.is_banned,
      hours: Math.round(o.mins / 6) / 10, offers: o.offers, done: o.done, refused: o.refused,
      last_ride: o.last_ride, last_active: d.last_active || null, since: d.created_at || null }; });
    return { ok: true, days, rows };
  }
  if (act === 'work-revoke') {
    const list = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 200);
    let n = 0;
    for (const tid of list) {
      const { data: t } = await db.from('users').select('*').eq('id', tid).maybeSingle();
      if (!t || t.driver_status !== 'approved' || t.staff_role === 'owner' || String(t.telegram_id) === String(OWNER)) continue;
      const { data: sh } = await db.from('shifts').select('*').eq('driver_id', tid).is('ended_at', null).limit(1);
      if (sh && sh.length) {
        const mins = Math.max(1, Math.round((Date.now() - new Date(sh[0].started_at)) / 60000));
        await db.from('shifts').update({ ended_at: new Date().toISOString(), minutes: mins }).eq('id', sh[0].id);
      }
      await db.from('offers').update({ status: 'cancelled' }).eq('driver_id', tid).eq('status', 'pending');
      const { error } = await db.from('users').update({ driver_status: 'none', role: 'passenger', status: 'offline' }).eq('id', tid);
      if (error) continue;
      kickFromDriverGroups(t, 'revoke').catch(() => {}); setDriverTag(t, false).catch(() => {});
      await audit(me, 'driver-status', tid, t.name, 'снял права водителя (давно не работает)');
      n++;
    }
    return { ok: true, n };
  }
  return { code: 400, ok: false, error: 'unknown' };
}
/* ---------- конец: работа водителей ---------- */

/* ---------- доставка для точек (v169) ----------
   Магазин, аптека, кафе подключаются из приложения; точка работает только после проверки владельцем.
   Сотрудники вызывают курьера: адрес точки подставляется сам. Телефон, имя и квартира получателя
   лежат в закрытой biz_orders и открываются только водителю, который взял заказ.
   Курьер деньги за товар не берёт — только оплаченный товар (решение владельца 25.10).
   Пока миграции db-30 нет — всё молчит. */
const BIZ_KINDS = { shop: 'Магазин', pharmacy: 'Аптека', cafe: 'Кафе', flowers: 'Цветы', water: 'Вода', other: 'Другое' };
const BIZ_WHAT = ['Пакет', 'Коробка', 'Букет', 'Еда', 'Документы'];
const BIZ_ST = { pending: 'ждёт проверки', active: 'работает', rejected: 'отклонена', blocked: 'приостановлена' };
let bizReady = false;
async function bizCheck() {
  try { const { error } = await db.from('businesses').select('id').limit(1); bizReady = !error; }
  catch (e) { bizReady = false; }
  return bizReady;
}
const bizTxt = (v, n) => String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function bizPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length === 11 ? d : null;
}
const bizPhoneTxt = d => d && d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : (d || '');
const bizPayerTxt = p => p === 'client' ? 'получатель' : 'точка';
const bizInviteLink = code => `https://t.me/${BOT_USERNAME}?start=biz_${code}`;
const bizCode = () => crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || String(Date.now()).slice(-10);

// точка человека: сначала работающая, потом на проверке
async function bizOf(userId) {
  if (!bizReady || !userId) return null;
  const { data: st } = await db.from('biz_staff').select('*').eq('user_id', String(userId));
  if (!st || !st.length) return null;
  const { data: bs } = await db.from('businesses').select('*').in('id', st.map(x => x.biz_id));
  const rank = { active: 0, pending: 1, blocked: 2, rejected: 3 };
  const list = (bs || []).slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || new Date(b.created_at) - new Date(a.created_at));
  const b = list[0];
  if (!b) return null;
  const s = st.find(x => String(x.biz_id) === String(b.id));
  return { biz: b, role: (s && s.role) || 'staff' };
}
async function bizIsStaff(userId, bizId) {
  if (!bizReady || !userId || !bizId) return false;
  const { data } = await db.from('biz_staff').select('user_id').eq('biz_id', bizId).eq('user_id', String(userId)).maybeSingle();
  return !!data;
}
async function bizStaffList(bizId) {
  const { data: st } = await db.from('biz_staff').select('*').eq('biz_id', bizId).order('added_at');
  const ids = (st || []).map(x => x.user_id);
  let us = [];
  if (ids.length) { const { data } = await db.from('users').select('id,name,telegram_id').in('id', ids); us = data || []; }
  return (st || []).map(x => {
    const u = us.find(y => String(y.id) === String(x.user_id)) || {};
    return { user_id: x.user_id, role: x.role, name: u.name || '—', tag: String(u.telegram_id || '').slice(-4) };
  }).sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1));
}

// подсказка цены: сколько обычно платят за доставку в этом городе за 60 дней
const bizHintCache = new Map();
async function bizHint(city) {
  const c = bizHintCache.get(city);
  if (c && Date.now() - c.t < 30 * 60e3) return c.v;
  let v = null;
  try {
    const { data } = await db.from('rides').select('price').eq('city', city).eq('kind', 'delivery').eq('status', 'completed')
      .gte('created_at', new Date(Date.now() - 60 * 864e5).toISOString()).not('price', 'is', null).limit(1000);
    const ps = (data || []).map(x => Number(x.price)).filter(x => x > 0).sort((a, b) => a - b);
    if (ps.length >= 5) {
      const q = f => ps[Math.min(ps.length - 1, Math.floor(f * (ps.length - 1)))];
      const r10 = x => Math.round(x / 10) * 10;
      v = { lo: r10(q(0.25)), hi: Math.max(r10(q(0.25)), r10(q(0.75))), n: ps.length };
    }
  } catch (e) {}
  bizHintCache.set(city, { t: Date.now(), v });
  return v;
}

// приложение: что за точка у человека
async function bizMe(me) {
  if (!bizReady && !(await bizCheck())) return { ok: true, ready: false };
  const x = await bizOf(me.id);
  if (!x) return { ok: true, ready: true, biz: null };
  const b = x.biz;
  const out = { ok: true, ready: true, role: x.role,
    biz: { id: b.id, name: b.name, kind: b.kind, city: b.city, address: b.address, phone: b.phone, status: b.status, created_at: b.created_at } };
  if (b.status === 'active') {
    out.hint = await bizHint(b.city);
    out.staff = await bizStaffList(b.id);
    if (x.role === 'owner') {
      if (!b.invite_code) {
        const code = bizCode();
        await db.from('businesses').update({ invite_code: code }).eq('id', b.id);
        b.invite_code = code;
      }
      out.invite = bizInviteLink(b.invite_code);
    }
  }
  return out;
}

// заявка на подключение
async function bizApply(me, body) {
  const name = bizTxt(body.name, 60), address = bizTxt(body.address, 120);
  const kind = BIZ_KINDS[body.kind] ? body.kind : 'other';
  const phone = bizPhone(body.phone);
  if (name.length < 2 || address.length < 3) return { code: 400, error: 'bad_input' };
  if (!phone) return { code: 400, error: 'bad_phone' };
  if (!me.city) return { code: 400, error: 'no_city' };
  const cur = await bizOf(me.id);
  if (cur && ['active', 'pending'].includes(cur.biz.status)) return { code: 400, error: 'already' };
  if (cur && cur.biz.status === 'blocked') return { code: 400, error: 'blocked' };
  const { count } = await db.from('businesses').select('*', { count: 'exact', head: true })
    .eq('owner_id', me.id).gte('created_at', new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= 3) return { code: 429, error: 'too_many' };
  const { data: b, error } = await db.from('businesses')
    .insert({ name, kind, city: me.city, address, phone, owner_id: me.id, status: 'pending' }).select().maybeSingle();
  if (error || !b) return { code: 500, error: 'save_failed' };
  await db.from('biz_staff').insert({ biz_id: b.id, user_id: me.id, role: 'owner' });
  bizNotifyOwner(b, me).catch(() => {});
  return { ok: true, biz: { id: b.id, name: b.name, kind: b.kind, city: b.city, address: b.address, phone: b.phone, status: b.status } };
}
async function bizNotifyOwner(b, u) {
  if (!OWNER) return;
  const ph = await phoneOf(u.id);
  await send(OWNER,
    `🏪 <b>Новая точка на проверку</b>\n\n<b>${safeName(b.name)}</b> · ${BIZ_KINDS[b.kind] || 'точка'}\n📍 ${safeName(b.city)}, ${safeName(b.address)}\n📞 ${bizPhoneTxt(b.phone)}\n\n` +
    `Подал: ${safeName(u.name)} #${String(u.telegram_id || '').slice(-4)}${ph ? ` · ${safeName(ph)}` : ''}\n\n` +
    `<i>Перед тем как одобрить — позвоните или загляните: точка настоящая?</i>`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: 'bza:' + b.id }, { text: '❌ Отклонить', callback_data: 'bzr:' + b.id }]] } });
}

// решение по точке: одобрить, отклонить, приостановить
async function bizDecide(actor, id, status) {
  const { data: b } = await db.from('businesses').select('*').eq('id', id).maybeSingle();
  if (!b) return { code: 404, error: 'no_biz' };
  if (b.status === status) return { ok: true, same: true, biz: b };
  const was = b.status;
  const upd = { status, decided_at: new Date().toISOString(), decided_by: actor ? String(actor.name || actor.id || '') : null };
  await db.from('businesses').update(upd).eq('id', id);
  Object.assign(b, upd);
  await audit(actor || {}, 'biz-' + status, null, b.name, `${b.name} (${b.city}): ${BIZ_ST[was] || was} → ${BIZ_ST[status]}`);
  const tid = await tgIdOf(b.owner_id);
  if (tid) {
    const t = status === 'active'
      ? (was === 'blocked'
        ? `✅ <b>Точка «${safeName(b.name)}» снова работает</b>\nМожно вызывать курьера.`
        : `✅ <b>Точка «${safeName(b.name)}» подключена!</b>\n\nВ приложении появился режим «Точка»: вызывайте курьера в пару нажатий — адрес точки подставится сам.\n\nСотрудников можно пригласить там же, в разделе «Точка».`)
      : status === 'rejected'
      ? `❌ <b>Заявку на точку «${safeName(b.name)}» отклонили</b>\nЕсли это ошибка — напишите в поддержку.`
      : `⛔ <b>Точка «${safeName(b.name)}» приостановлена</b>\nВызвать курьера от её имени сейчас нельзя. Вопросы — в поддержку.`;
    await send(tid, t, status === 'active' ? { reply_markup: { inline_keyboard: [[wa('🏪 Открыть точку', 'biz')]] } } : {}).catch(() => {});
  }
  return { ok: true, biz: b };
}
async function bizDecideCq(cq, status) {
  const ans = (text, alert) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert });
  if (cq.from.id !== OWNER) return ans('Это может только владелец', true);
  const { data: actor } = await db.from('users').select('*').eq('telegram_id', OWNER).maybeSingle();
  const r = await bizDecide(actor || { name: 'владелец' }, cq.data.slice(4), status);
  if (r.error) return ans('Точка не найдена', true);
  await ans(r.same ? 'Уже сделано' : status === 'active' ? 'Одобрено' : 'Отклонено');
  if (cq.message) {
    await tg('editMessageReplyMarkup', { chat_id: cq.from.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (!r.same) await send(cq.from.id, status === 'active'
      ? `✅ Точка «${safeName(r.biz.name)}» подключена — хозяину ушло сообщение.`
      : `❌ Заявка точки «${safeName(r.biz.name)}» отклонена.`).catch(() => {});
  }
}

// сотрудник по ссылке-приглашению: /start biz_CODE
async function bizJoinPrompt(chat, code) {
  if (!bizReady && !(await bizCheck())) return send(chat, 'Приглашение пока не работает. Попробуйте позже.');
  const { data: b } = await db.from('businesses').select('*').eq('invite_code', String(code || '').slice(0, 20)).maybeSingle();
  if (!b || b.status !== 'active') return send(chat, 'Ссылка-приглашение недействительна. Попросите у хозяина точки новую.');
  const { data: u } = await db.from('users').select('id').eq('telegram_id', chat).maybeSingle();
  if (!u) return send(chat, `🏪 <b>Приглашение в точку «${safeName(b.name)}»</b>\n\nСначала откройте приложение — оно создаст ваш профиль. Потом нажмите на ссылку-приглашение ещё раз.`,
    { reply_markup: { inline_keyboard: [[wa('Открыть приложение', 'order')]] } });
  if (await bizIsStaff(u.id, b.id)) return send(chat, `Вы уже в точке «${safeName(b.name)}».`, { reply_markup: { inline_keyboard: [[wa('🏪 Открыть точку', 'biz')]] } });
  return send(chat, `🏪 <b>Вас приглашают в точку «${safeName(b.name)}»</b>\n📍 ${safeName(b.address)}\n\nВы сможете вызывать курьера от имени точки.`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Присоединиться', callback_data: 'bzj:' + b.invite_code }]] } });
}
async function bizJoin(cq, code) {
  const chat = cq.from.id;
  const ans = (text, alert) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert });
  if (!bizReady && !(await bizCheck())) return ans('Пока не работает', true);
  const { data: b } = await db.from('businesses').select('*').eq('invite_code', code).maybeSingle();
  if (!b || b.status !== 'active') return ans('Приглашение недействительно', true);
  const { data: u } = await db.from('users').select('id,name,telegram_id,is_banned').eq('telegram_id', chat).maybeSingle();
  if (!u) return ans('Сначала откройте приложение', true);
  if (u.is_banned) return ans('Нет доступа', true);
  if (!(await bizIsStaff(u.id, b.id))) {
    const { count } = await db.from('biz_staff').select('*', { count: 'exact', head: true }).eq('biz_id', b.id);
    if ((count || 0) >= 20) return ans('В точке уже 20 сотрудников', true);
    await db.from('biz_staff').insert({ biz_id: b.id, user_id: u.id, role: 'staff' });
    const otid = await tgIdOf(b.owner_id);
    if (otid && String(otid) !== String(chat)) send(otid,
      `👤 ${safeName(u.name)} #${String(u.telegram_id).slice(-4)} присоединился к точке «${safeName(b.name)}».\nУбрать — в приложении: Точка → Сотрудники.`).catch(() => {});
  }
  await ans('Готово!');
  if (cq.message) await tg('editMessageText', { chat_id: chat, message_id: cq.message.message_id, parse_mode: 'HTML',
    text: `✅ <b>Вы в точке «${safeName(b.name)}»</b>\nВызывайте курьера в приложении — режим «Точка».`,
    reply_markup: { inline_keyboard: [[wa('🏪 Открыть точку', 'biz', { id: chat, first_name: u.name })]] } }).catch(() => {});
}

// вызов курьера
async function bizOrder(me, body) {
  const x = await bizOf(me.id);
  if (!x || x.biz.status !== 'active') return { code: 403, error: 'no_biz' };
  const b = x.biz;
  const to = bizTxt(noContacts(body.to_address), 200);       // адрес виден всем водителям — номера вырезаем
  const phone = bizPhone(body.recipient_phone);
  if (to.length < 3) return { code: 400, error: 'bad_address' };
  { const why = adSpam(body.to_address, body.note); if (why) { adAlert(me, why, [body.to_address, body.note].filter(Boolean).join(' | ')); return { code: 400, error: 'ad_text' }; } }
  if (!phone) return { code: 400, error: 'bad_phone' };
  const what = BIZ_WHAT.includes(body.what) ? body.what : '';
  const note = bizTxt(noContacts(body.note), 150);
  const payer = body.payer === 'client' ? 'client' : 'biz';
  const pr = parseInt(body.price);
  const price = Number.isFinite(pr) && pr > 0 ? Math.min(100000, pr) : null;
  const { count: act } = await db.from('rides').select('*', { count: 'exact', head: true }).eq('biz_id', b.id).in('status', ['created', 'confirmed']);
  if ((act || 0) >= 15) return { code: 429, error: 'too_many' };
  const { data: ride, error } = await db.from('rides').insert({
    passenger_id: me.id, passenger_name: b.name, from_address: b.address, to_address: to,
    status: 'created', city: b.city, kind: 'delivery', comment: [what, note].filter(Boolean).join(' · ') || null,
    passenger_price: price, biz_id: b.id, biz_name: b.name, biz_payer: payer
  }).select().single();
  if (error || !ride) return { code: 500, error: 'create_failed' };
  const { error: e2 } = await db.from('biz_orders').insert({ ride_id: ride.id, biz_id: b.id, created_by: me.id,
    recipient_phone: phone, recipient_name: bizTxt(body.recipient_name, 60) || null, details: bizTxt(body.details, 120) || null });
  if (e2) { await db.from('rides').delete().eq('id', ride.id); return { code: 500, error: 'create_failed' }; }
  return { ok: true, ride };
}

async function bizStaffRemove(me, body) {
  const x = await bizOf(me.id);
  if (!x || x.role !== 'owner') return { code: 403, error: 'not_owner' };
  if (String(body.user_id) === String(me.id)) return { code: 400, error: 'self' };
  await db.from('biz_staff').delete().eq('biz_id', x.biz.id).eq('user_id', String(body.user_id)).neq('role', 'owner');
  return { ok: true, staff: await bizStaffList(x.biz.id) };
}
async function bizLeave(me) {
  const x = await bizOf(me.id);
  if (!x) return { ok: true };
  if (x.role === 'owner') return { code: 400, error: 'owner' };
  await db.from('biz_staff').delete().eq('biz_id', x.biz.id).eq('user_id', String(me.id));
  return { ok: true };
}
async function bizNewInvite(me) {
  const x = await bizOf(me.id);
  if (!x || x.role !== 'owner' || x.biz.status !== 'active') return { code: 403, error: 'not_owner' };
  const code = bizCode();
  await db.from('businesses').update({ invite_code: code }).eq('id', x.biz.id);
  return { ok: true, invite: bizInviteLink(code) };
}

async function bizApi(me, body) {
  const act = String(body.action || '');
  if (act === 'me') return bizMe(me);
  if (!bizReady && !(await bizCheck())) return { code: 400, error: 'not_ready' };
  if (act === 'apply') return bizApply(me, body);
  if (act === 'order') return bizOrder(me, body);
  if (act === 'staff-remove') return bizStaffRemove(me, body);
  if (act === 'leave') return bizLeave(me);
  if (act === 'new-invite') return bizNewInvite(me);
  return { code: 400, error: 'unknown' };
}

// курьер забрал заказ в точке
async function bizPicked(me, ride) {
  if (!ride.biz_id) return { code: 400, error: 'not_biz' };
  if (ride.picked_at) return { ok: true, same: true };
  await db.from('rides').update({ picked_at: new Date().toISOString() }).eq('id', ride.id);
  const tid = await tgIdOf(ride.passenger_id);
  if (tid) send(tid, `📦 <b>Курьер забрал заказ</b> — везёт\n🏁 ${safeName(ride.to_address)}\n👤 ${safeName(me.name)}${me.car ? ` · ${safeName(me.car)}` : ''}`,
    { reply_markup: { inline_keyboard: [[wa('🏪 Открыть точку', 'biz')]] } }).catch(() => {});
  return { ok: true };
}

// водителю, которого выбрали: где забрать и кому отдать
async function bizDriverCard(r) {
  if (!bizReady || !r || !r.biz_id) return '';
  const [{ data: b }, { data: o }] = await Promise.all([
    db.from('businesses').select('name,address,phone').eq('id', r.biz_id).maybeSingle(),
    db.from('biz_orders').select('*').eq('ride_id', r.id).maybeSingle()]);
  let s = '';
  if (b) s += `\n\n🏪 <b>Забрать:</b> ${safeName(b.name)}, ${safeName(b.address)}${b.phone ? `\n📞 <a href="tel:+${b.phone}">${bizPhoneTxt(b.phone)}</a>` : ''}`;
  if (o) s += `\n\n👤 <b>Получатель:</b> ${safeName(o.recipient_name || 'имя не указано')}${o.recipient_phone ? `\n📞 <a href="tel:+${o.recipient_phone}">${bizPhoneTxt(o.recipient_phone)}</a>` : ''}${o.details ? `\n🚪 ${safeName(o.details)}` : ''}`;
  s += `\n💳 Доставку оплачивает: <b>${bizPayerTxt(r.biz_payer)}</b>`;
  return s;
}
// водителю в приложении: точка и получатель (только тому, кто взял заказ)
async function bizContact(r) {
  if (!bizReady || !r || !r.biz_id) return null;
  const [{ data: b }, { data: o }] = await Promise.all([
    db.from('businesses').select('name,address,phone').eq('id', r.biz_id).maybeSingle(),
    db.from('biz_orders').select('*').eq('ride_id', r.id).maybeSingle()]);
  return { biz: b ? { name: b.name, address: b.address, phone: b.phone ? '+' + b.phone : null } : null,
    recipient: o ? { name: o.recipient_name, phone: o.recipient_phone ? '+' + o.recipient_phone : null, details: o.details } : null };
}

// утренняя сводка
async function bizReportLine(y0, t0) {
  if (!bizReady) return '';
  try {
    const { data: rs } = await db.from('rides').select('biz_id,status').not('biz_id', 'is', null)
      .gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString());
    const all = rs || [];
    const { count: pend } = await db.from('businesses').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    if (!all.length && !pend) return '';
    return `🏪 Точки: доставок ${all.length}, довезли ${all.filter(r => r.status === 'completed').length}${pend ? ` · ждут проверки: ${pend}` : ''}`;
  } catch (e) { return ''; }
}

// панель: «Ещё → Точки» (право biz)
async function bizAdmin(me, act, body) {
  if (!bizReady && !(await bizCheck())) return { ok: true, missing: true };
  if (act === 'biz-list') {
    const { data: bs } = await db.from('businesses').select('*').order('created_at', { ascending: false }).limit(500);
    const list = bs || [];
    const owners = [...new Set(list.map(b => b.owner_id))];
    let us = [];
    if (owners.length) { const { data } = await db.from('users').select('id,name,telegram_id').in('id', owners); us = data || []; }
    const m0 = new Date(); m0.setHours(0, 0, 0, 0); m0.setDate(1);
    const ids = list.filter(b => ['active', 'blocked'].includes(b.status)).map(b => b.id);
    let rs = [], st = [];
    if (ids.length) {
      rs = await ptAll(() => db.from('rides').select('biz_id,status,created_at').in('biz_id', ids).gte('created_at', m0.toISOString()).order('created_at'), 10);
      const { data } = await db.from('biz_staff').select('biz_id').in('biz_id', ids); st = data || [];
    }
    const items = list.map(b => {
      const u = us.find(x => String(x.id) === String(b.owner_id)) || {};
      const mine = rs.filter(r => String(r.biz_id) === String(b.id));
      const { invite_code, ...rest } = b;
      return { ...rest, owner_name: u.name || '—', owner_tag: String(u.telegram_id || '').slice(-4),
        month: mine.filter(r => r.status === 'completed').length, month_all: mine.length,
        last: mine.length ? mine[mine.length - 1].created_at : null,
        staff: st.filter(x => String(x.biz_id) === String(b.id)).length };
    });
    return { ok: true, items };
  }
  if (act === 'biz-card') {
    const { data: b } = await db.from('businesses').select('*').eq('id', body.id).maybeSingle();
    if (!b) return { code: 404, error: 'no_biz' };
    const staff = await bizStaffList(b.id);
    const { data: rides } = await db.from('rides').select('id,status,created_at,to_address,price,driver_id,biz_payer')
      .eq('biz_id', b.id).order('created_at', { ascending: false }).limit(20);
    const { invite_code, ...rest } = b;
    return { ok: true, biz: rest, staff, rides: rides || [], owner_phone: await phoneOf(b.owner_id) };
  }
  if (act === 'biz-set') {
    if (!['active', 'rejected', 'blocked'].includes(body.status)) return { code: 400, error: 'bad_status' };
    return bizDecide(me, body.id, body.status);
  }
  if (act === 'biz-edit') {
    const { data: b } = await db.from('businesses').select('*').eq('id', body.id).maybeSingle();
    if (!b) return { code: 404, error: 'no_biz' };
    const upd = {};
    if (body.name !== undefined) { const v = bizTxt(body.name, 60); if (v.length >= 2 && v !== b.name) upd.name = v; }
    if (body.address !== undefined) { const v = bizTxt(body.address, 120); if (v.length >= 3 && v !== b.address) upd.address = v; }
    if (body.phone !== undefined) { const v = bizPhone(body.phone); if (v && v !== b.phone) upd.phone = v; }
    if (body.kind !== undefined && BIZ_KINDS[body.kind] && body.kind !== b.kind) upd.kind = body.kind;
    if (body.note !== undefined) { const v = bizTxt(body.note, 200) || null; if (v !== (b.note || null)) upd.note = v; }
    if (!Object.keys(upd).length) return { ok: true, same: true };
    await db.from('businesses').update(upd).eq('id', b.id);
    const L = { name: 'название', address: 'адрес', phone: 'телефон', kind: 'вид', note: 'пометка' };
    await audit(me, 'biz-edit', null, b.name, Object.keys(upd).map(k => `${L[k]}: ${k === 'kind' ? BIZ_KINDS[upd[k]] : upd[k] || '—'}`).join('; '));
    return { ok: true };
  }
  if (act === 'biz-rule-get') return { ok: true, bizMin: RCFG.bizMin, ranks: ranksReady };
  if (act === 'biz-rule-set') {
    const v = body.bizMin === 'none' || RANK_CODES.includes(body.bizMin) ? body.bizMin : null;
    if (!v) return { code: 400, error: 'bad_rank' };
    if (v === RCFG.bizMin) return { ok: true, same: true };
    const next = rankCfgClean({ ...RCFG, bizMin: v });
    const { error } = await db.from('settings').update({ rank_cfg: next }).eq('id', 1);
    if (error) return { code: 500, error: 'save_failed' };
    const was = RCFG.bizMin; RCFG = next;
    await audit(me, 'biz-rule', null, null, `заказы точек: ${was === 'none' ? 'всем' : 'от ' + RANK_GEN[was]} → ${v === 'none' ? 'всем' : 'от ' + RANK_GEN[v]}`);
    return { ok: true, bizMin: v };
  }
  if (act === 'biz-staff-remove') {
    const { data: b } = await db.from('businesses').select('name').eq('id', body.id).maybeSingle();
    await db.from('biz_staff').delete().eq('biz_id', body.id).eq('user_id', String(body.user_id)).neq('role', 'owner');
    await audit(me, 'biz-staff-remove', String(body.user_id), b ? b.name : null, 'убран из сотрудников точки');
    return { ok: true, staff: await bizStaffList(body.id) };
  }
  return { code: 400, error: 'unknown' };
}
setTimeout(() => { bizCheck().catch(() => {}); }, 15 * 1000);
setInterval(() => { if (!bizReady) bizCheck().catch(() => {}); }, 5 * 60 * 1000);
/* ---------- конец: доставка для точек ---------- */

/* ============ доступ в водительскую группу ============
   допуск сняли или человека забанили — убираем из группы.
   допуск вернули — разбаниваем и присылаем ссылку обратно. */

async function driverGroupsOf(cityName) {
  const q = db.from('cities').select('driver_group_id').not('driver_group_id', 'is', null);
  const { data } = cityName ? await q.eq('name', cityName) : await q;
  const ids = [...new Set((data || []).map(c => c.driver_group_id).filter(Boolean))];
  return ids;
}

/* ============ метка «Водитель Бомбил» в группе города ============
   Метка видна всем рядом с именем, как «Админ». Ставит только бот:
   проверенным водителям — ставит, снятым и забаненным — убирает.
   Telegram: до 16 знаков, без эмодзи, только для обычных участников. */
const DRIVER_TAG = 'Водитель Бомбил';
const tagMemo = new Map();   // кого недавно проверяли — чтобы не дёргать базу на каждое сообщение

async function cityGroupsOf(cityName) {
  const q = db.from('cities').select('group_id').not('group_id', 'is', null);
  const { data } = cityName ? await q.eq('name', cityName) : await q;
  return [...new Set((data || []).map(c => c.group_id).filter(Boolean))];
}

async function setDriverTag(user, on) {
  if (!user || !user.telegram_id) return;
  // метка зависит от ранга: «Бомбила Золото», а без ранга — «Водитель Бомбил»
  let tag = '';
  if (on) {
    let full = user;
    if (!('rank_code' in user) || !('city' in user)) {
      const { data } = await db.from('users').select('*').eq('telegram_id', user.telegram_id).maybeSingle();
      if (data) full = { ...data, ...user };
    }
    user = full;
    tag = rankTag(full);
  }
  // меняется город у водителя редко, а снимать метку надо везде — берём все группы
  const groups = await cityGroupsOf(on ? user.city : null);
  for (const gid of groups) {
    const r = await tg('setChatMemberTag', { chat_id: gid, user_id: user.telegram_id, tag }).catch(() => null);
    if (r && !r.ok && r.description && !/not found|PARTICIPANT|USER_NOT/i.test(r.description)) {
      glog(`метка ${safeName(user.name)}: ${r.description}`);
    }
  }
  tagMemo.delete(String(user.telegram_id));
}

// человек написал в группе — проверяем, правильная ли у него метка
async function tagCheck(m, chatId, member) {
  const uid = m.from && m.from.id;
  if (!uid || !member || member.status === 'creator' || member.status === 'administrator') return;
  const k = String(uid);
  const memo = tagMemo.get(k);
  if (memo && Date.now() - memo < 10 * 60 * 1000) return;
  tagMemo.set(k, Date.now());
  if (tagMemo.size > 5000) tagMemo.clear();

  const { data: u, error } = await db.from('users')
    .select('*').eq('telegram_id', uid).maybeSingle();
  if (error) { tagMemo.delete(k); return; }   // база не ответила — не трогаем метку
  const want = u && u.driver_status === 'approved' && !u.is_banned ? rankTag(u) : '';
  const have = String(member.tag || m.sender_tag || '');
  if (have === want) return;
  // чужие метки, поставленные админами вручную, не трогаем — только «водительские»
  if (!want && !/водител|бомбил|такси/i.test(have)) return;
  await tg('setChatMemberTag', { chat_id: chatId, user_id: uid, tag: want }).catch(() => {});
}

async function kickFromDriverGroups(user, reason) {
  if (!user || !user.telegram_id) return;
  const groups = await driverGroupsOf(user.city);
  for (const gid of groups) {
    try {
      await tg('banChatMember', { chat_id: gid, user_id: user.telegram_id });
      glog(`группа водителей: ${safeName(user.name)} исключён (${reason})`);
    } catch (e) { glog(`исключение ${safeName(user.name)}: ${e.message}`); }
  }
  if (groups.length) {
    await send(user.telegram_id,
      reason === 'ban'
        ? '⛔ Ваш аккаунт заблокирован. Доступ в группу водителей закрыт.'
        : '📕 Допуск к заказам снят — вы убраны из группы водителей.\n\nЕсли это ошибка, напишите нам через «Связь с админом».'
    ).catch(() => {});
  }
}

async function inviteToDriverGroups(user) {
  if (!user || !user.telegram_id) return;
  const groups = await driverGroupsOf(user.city);
  for (const gid of groups) {
    try {
      await tg('unbanChatMember', { chat_id: gid, user_id: user.telegram_id, only_if_banned: true });
      const inv = await tg('createChatInviteLink', {
        chat_id: gid, member_limit: 1, name: `для ${String(user.name || '').slice(0, 20)}`
      });
      if (inv && inv.ok) {
        await send(user.telegram_id,
          '✅ Допуск открыт. Вот ссылка в группу водителей — там приходят уведомления о новых заказах.',
          { reply_markup: { inline_keyboard: [[{ text: '👥 Вступить в группу', url: inv.result.invite_link }]] } }
        ).catch(() => {});
      }
    } catch (e) { glog(`приглашение ${safeName(user.name)}: ${e.message}`); }
  }
}

/* ============ лента заказов для водителей ============
   отдельная группа только для водителей. адресов там нет —
   только город, вид заказа и цена. подробности в приложении. */

function feedText(r, state) {
  const kind = (r.kind === 'delivery' ? '📦 Доставка'
             : r.to_city ? '🛣 Межгород'
             : '🚕 Поездка') + (r.biz_name ? ` · 🏪 ${safeName(r.biz_name)}` : '');

  // во сколько заявку создали — чтобы зашедший позже видел, что он пропустил
  const at = r.created_at
    ? new Date(r.created_at).toLocaleString('ru', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      })
    : '';
  // как быстро разобрали
  const mins = (a, b) => {
    if (!a || !b) return null;
    const m = Math.floor((new Date(b) - new Date(a)) / 60000);
    return m >= 0 && m < 1440 ? m : null;
  };
  const fast = m => m === null ? ''
    : m < 1 ? ' — меньше чем за минуту'
    : ` — за ${m} ${m % 10 === 1 && m % 100 !== 11 ? 'минуту' : (m % 10 >= 2 && m % 10 <= 4 && (m % 100 < 10 || m % 100 >= 20)) ? 'минуты' : 'минут'}`;

  if (state === 'taken') {
    const m = mins(r.created_at, r.confirmed_at);
    return `${kind} · ${safeName(r.city)}${at ? `\n🕐 ${at}` : ''}\n\n<b>✅ Заказ взяли</b>${fast(m)}.\n<i>Кто был в приложении — тот и взял.</i>`;
  }
  if (state === 'gone') {
    const noOne = String(r.status || '').startsWith('cancelled') && !r.driver_id;
    const m = mins(r.created_at, Date.now());
    return `${kind} · ${safeName(r.city)}${at ? `\n🕐 ${at}` : ''}\n\n<b>❌ Заказ не состоялся</b>${m !== null ? ` — висел ${m} мин` : ''}.\n<i>${noOne ? 'Никто не откликнулся.' : 'Заявка отменена.'}</i>`;
  }

  const when = r.scheduled_at
    ? `\n⏰ На ${new Date(r.scheduled_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  // канал закрытый, туда попадают только допущенные водители — адрес показываем.
  // цену по-прежнему прячем, иначе торг теряет смысл
  const route = r.from_address
    ? `\n📍 ${safeName(r.from_address)}\n🏁 ${safeName(r.to_address || (r.to_city ? 'в ' + r.to_city : '—'))}`
    : '';
  const rk = r.biz_id && bizRankTxt() ? `\n🏅 Брать могут водители ${bizRankTxt()}` : '';
  return `<b>${kind}</b> · ${safeName(r.city)}${when}${route}${rk}\n\nОткройте приложение, чтобы взять.`;
}

async function feedPublish(ride) {
  try {
    const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (st && st.driver_feed_enabled === false) return;

    const { data: city } = await db.from('cities')
      .select('driver_group_id').eq('name', ride.city).maybeSingle();
    if (!city || !city.driver_group_id) return;

    const r = await tg('sendMessage', {
      chat_id: city.driver_group_id,
      text: feedText(ride, 'open'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '🚗 Открыть Бомбилы', url: `https://t.me/${BOT_USERNAME}` }
      ]] }
    });
    if (r && r.ok) {
      await db.from('ride_feed').upsert({
        ride_id: ride.id, chat_id: city.driver_group_id,
        message_id: r.result.message_id, state: 'open'
      });
    }
  } catch (e) { glog('лента водителей: ' + e.message); }
}

async function feedUpdate(rideId, state) {
  try {
    const { data: f } = await db.from('ride_feed').select('*').eq('ride_id', rideId).maybeSingle();
    if (!f || f.state === state) return;
    const { data: ride } = await db.from('rides').select('*').eq('id', rideId).maybeSingle();
    if (!ride) return;
    await tg('editMessageText', {
      chat_id: f.chat_id, message_id: f.message_id,
      text: feedText(ride, state), parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [] }   // кнопку убираем: тыкать уже некуда
    }).catch(() => {});
    await db.from('ride_feed').update({ state }).eq('ride_id', rideId);
  } catch (e) { glog('лента водителей: ' + e.message); }
}

// следим за заявками: новые публикуем, принятые и отменённые правим
let feedSeen = new Set();
let feedStarted = 0;

async function feedLoop() {
  try {
    const since = new Date(Date.now() - 20 * 60000).toISOString();
    const { data: rides } = await db.from('rides')
      .select('id,city,kind,to_city,passenger_price,scheduled_at,status,created_at,from_address,to_address')
      .gte('created_at', since).order('created_at', { ascending: true }).limit(100);

    for (const r of rides || []) {
      // первый прогон после запуска — просто запоминаем, чтобы не спамить старым
      if (!feedStarted) { feedSeen.add(r.id); continue; }

      if (!feedSeen.has(r.id)) {
        feedSeen.add(r.id);
        if (r.status === 'created') { await feedPublish(r); await groupFeedPublish(r); }
        continue;
      }
      if (['confirmed', 'in_progress', 'completed'].includes(r.status)) { await feedUpdate(r.id, 'taken'); await groupFeedUpdate(r.id, 'taken'); }
      else if (String(r.status).startsWith('cancel') || r.status === 'expired') { await feedUpdate(r.id, 'gone'); await groupFeedUpdate(r.id, 'gone'); }
    }
    feedStarted = 1;

    // чистим память, чтобы не росла бесконечно
    if (feedSeen.size > 2000) feedSeen = new Set([...feedSeen].slice(-500));
  } catch (e) { console.error('feedLoop', e.message); }
  setTimeout(feedLoop, 10 * 1000);
}
setTimeout(feedLoop, 30 * 1000);

/* ================= рассылка ================= */

// кому пойдёт сообщение
async function audienceQuery(audience, city) {
  // берём всех с телеграмом, а лишних отсеиваем уже в коде:
  // условия вида «не равно» в базе молча выбрасывают записи с пустым полем
  let q = db.from('users').select('id,telegram_id,name,city,driver_status,no_broadcast')
    .not('telegram_id', 'is', null);
  if (city && city !== 'all') q = q.eq('city', city);
  const { data } = await q.limit(5000);
  let list = (data || []).filter(u => u.no_broadcast !== true);

  if (audience === 'drivers')    list = list.filter(u => u.driver_status === 'approved');
  if (audience === 'passengers') list = list.filter(u => u.driver_status !== 'approved');

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

    // если вместо адреса написано «app» — делаем кнопку, открывающую само приложение.
    // так человек заходит изнутри телеграма и подтягивает свежую версию,
    // не набирая /start вручную
    const asApp = b.btn_text && String(b.btn_url || '').trim().toLowerCase() === 'app';
    const kbFixed = b.btn_text && b.btn_url && !asApp
      ? { reply_markup: { inline_keyboard: [[{ text: b.btn_text, url: b.btn_url }]] } }
      : {};

    let sent = 0, failed = 0, blocked = 0;
    for (const u of list) {
      // кнопку приложения собираем персонально: в ссылке нужен uid человека
      const kb = asApp
        ? { reply_markup: { inline_keyboard: [[{
            text: b.btn_text,
            web_app: { url: appUrl('home', { id: u.telegram_id, first_name: u.name }) }
          }]] } }
        : kbFixed;

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


/* ---------- предварительные заказы: напоминания ---------- */
async function schedLoop() {
  try {
    const now = Date.now();
    const soon = new Date(now + 7 * 60 * 60 * 1000).toISOString();   // ловим и ранние напоминания
    const { data: rides } = await db.from('rides').select('*')
      .not('scheduled_at', 'is', null)
      .in('status', ['created', 'confirmed'])
      .lte('scheduled_at', soon)
      .gte('scheduled_at', new Date(now - 30 * 60 * 1000).toISOString())
      .limit(50);

    for (const r of rides || []) {
      const when = new Date(r.scheduled_at);
      const mins = Math.round((when - now) / 60000);
      const timeStr = when.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const dayStr = when.toLocaleString('ru', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

      // раннее напоминание водителю — за столько, сколько он сам выбрал
      if (r.driver_id && !r.early_sent) {
        const { data: dv } = await db.from('users').select('remind_before,telegram_id').eq('id', r.driver_id).maybeSingle();
        const before = dv && dv.remind_before ? Number(dv.remind_before) : 120;
        if (mins <= before && mins > 45) {
          if (dv && dv.telegram_id) {
            const h = Math.floor(mins / 60), mm = mins % 60;
            await send(dv.telegram_id,
              `🔔 <b>Напоминание о заказе</b>\nЧерез ${h ? h + ' ч ' : ''}${mm} мин вам ехать.\n\n🕒 ${dayStr}\n📍 ${r.from_address}\n🏁 ${r.to_address}${r.price ? `\n💰 ${r.price} ₽` : ''}\n\nПодробности и телефон пассажира придут ещё раз за 40 минут.`,
              { reply_markup: { inline_keyboard: [[wa('Открыть заказ', 'driver')]] } });
          }
          await db.from('rides').update({ early_sent: true }).eq('id', r.id);
        }
      }

      // за 40 минут — напоминание обеим сторонам
      if (r.driver_id && !r.remind_sent && mins <= 40 && mins > 0) {
        const route = `📍 ${r.from_address}\n🏁 ${r.to_address}`;
        const pt = await tgIdOf(r.passenger_id);
        if (pt) {
          const dcard = await contactCard(r.driver_id, 'Водитель');
          await send(pt, `⏰ <b>Через ${mins} мин ваша поездка</b>\n\n${route}\n🕒 ${timeStr}${r.price ? `\n💰 ${r.price} ₽` : ''}${dcard}`,
            { reply_markup: { inline_keyboard: [[wa('Открыть заказ', 'order')]] } });
        }
        const dt = await tgIdOf(r.driver_id);
        if (dt) {
          const pcard = await contactCard(r.passenger_id, 'Пассажир');
          await send(dt, `⏰ <b>Через ${mins} мин заказ</b>\n\n${route}\n🕒 ${timeStr}${r.price ? `\n💰 ${r.price} ₽` : ''}${r.comment ? `\n💬 ${r.comment}` : ''}${pcard}\n\nПора выезжать.`,
            { reply_markup: { inline_keyboard: [[wa('Открыть заказ', 'driver')]] } });
        }
        await db.from('rides').update({ remind_sent: true }).eq('id', r.id);
      }

      // за 40 минут никто не взял — трясём всех водителей города и честно говорим пассажиру
      if (!r.driver_id && !r.nodriver_sent && mins <= 40) {
        let q = db.from('users').select('telegram_id').eq('city', r.city).in('role', ['driver', 'both']);
        if (r.kind === 'delivery') q = q.or('delivery.eq.true,vehicle_type.eq.moto');
        else q = q.or('vehicle_type.is.null,vehicle_type.eq.car');
        const { data: drv } = await q;
        for (const d of drv || []) {
          if (!d.telegram_id) continue;
          await send(d.telegram_id,
            `🕒 <b>Заказ на ${timeStr}, водителя нет</b>\n📍 ${r.from_address}\n🏁 ${r.to_address}${r.passenger_price ? `\n💰 Пассажир предлагает ${r.passenger_price} ₽` : ''}\n\nЧеловек ждёт машину. Если можете — возьмите.`,
            { reply_markup: { inline_keyboard: [[wa('Взять заказ', 'driver')]] } });
        }
        const pt2 = await tgIdOf(r.passenger_id);
        if (pt2) await send(pt2,
          `⚠️ <b>Заказ на ${timeStr} пока никто не взял</b>\n\nМы напомнили всем водителям города. Если через полчаса никого не будет — лучше поискать машину другим способом, чтобы не опоздать.`);
        await db.from('rides').update({ nodriver_sent: true }).eq('id', r.id);
      }
    }
  } catch (e) { console.error('schedLoop', e.message); }
  setTimeout(schedLoop, 5 * 60 * 1000);
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
/* ============ права персонала по разделам ============
   владелец может всё и всегда.
   у остальных — только то, что выдано галочками в панели. */
const PERM_GROUPS = {
  users:      'Люди: поиск, телефоны, пометки, бан',
  drivers:    'Водители: машины и допуск на линию',
  rides:      'Заявки: просмотр и вмешательство',
  complaints: 'Жалобы',
  support:    'Поддержка: переписка с людьми',
  broadcast:  'Рассылка по боту',
  promos:     'Промокоды',
  balance:    'Баланс и подписки',
  refs:       'Рефералка и метки источников',
  cities:     'Города и ссылки на группы',
  settings:   'Общие настройки',
  stats:      'Отчёты и статистика',
  audit:      'Журнал действий',
  ranks:      'Ранги и баллы: правила, журнал баллов, ручные начисления',
  biz:        'Точки: магазины и кафе — проверка и доставки'
};

// какое действие к какому разделу относится
const ACT_PERM = {
  'user-search':'users','user-phone':'users','edit-user':'users','ban':'users',
  'avatars':'users','avatar-fetch':'users','apps-phones':'users','activity':'users',
  'admin-counts':'users','send-msg':'users',

  'driver-status':'drivers','cars-pending':'drivers','cars-pending-list':'drivers',
  'car-approve':'drivers','car-edit':'drivers','car-remove':'drivers',
  'car-add-admin':'drivers','cars-of-user':'drivers','doc-urls':'drivers',

  'rides-list':'rides','del-review':'rides','ride-notify-list':'rides','ride-card':'rides',

  'complaint-resolve':'complaints','resolve-complaint':'complaints',

  'support-list':'support','support-answer':'support','support-hide':'support',
  'support-count':'support','support-answered':'support',

  'broadcast-send':'broadcast','broadcast-list':'broadcast','broadcast-count':'broadcast',
  'winback':'broadcast','winback-list':'broadcast','winback-set':'broadcast',

  'promo-create':'promos','create-promo':'promos','promo-list':'promos',
  'promo-delete':'promos','delete-promo':'promos',

  'adjust-balance':'balance',

  'src-list':'refs','src-save':'refs','src-delete':'refs',

  'city-list':'cities','city-save':'cities','city-delete':'cities','pin-now':'cities',

  'settings-update':'settings','save-settings':'settings',
  'work-list':'drivers','work-revoke':'drivers',
  'guard-get':'settings','guard-set':'settings','guard-list':'settings','guard-reset':'settings',
  'call-cfg-get':'settings','call-cfg-set':'settings','call-stats':'settings',
  'biz-list':'biz','biz-card':'biz','biz-set':'biz','biz-edit':'biz','biz-staff-remove':'biz','biz-rule-get':'biz','biz-rule-set':'biz',

  'stats':'stats','days-stats':'stats','rides-stats':'stats','drivers-stats':'stats','tg-stats':'stats',

  'audit-list':'audit','audit-actors':'audit','audit-clear':'audit',

  'rank-cfg-get':'ranks','rank-cfg-set':'ranks','ranks-recalc':'ranks','points-list':'ranks','points-drivers':'ranks',
  'points-driver':'ranks','points-adjust':'ranks','points-void':'ranks','inv-list':'ranks'
};

function isOwner(u) {
  return u && (u.staff_role === 'owner' || String(u.telegram_id) === String(OWNER));
}
function permsOf(u) {
  return Array.isArray(u && u.perms) ? u.perms : [];
}
function can(u, group) {
  if (isOwner(u)) return true;
  return permsOf(u).includes(group);
}
// назначать роли и раздавать права может только владелец
const OWNER_ONLY = ['set-role', 'perms-set'];
function canAct(u, act) {
  if (isOwner(u)) return true;
  if (OWNER_ONLY.includes(act)) return false;
  const g = ACT_PERM[act];
  if (!g) return true;               // действие без раздела — оставляем как было
  return permsOf(u).includes(g);
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
    if (me && action === undefined && 'actor_id' in me) {      // вызов одним объектом
      await db.from('audit_log').insert({ actor_id: me.actor_id || null, actor_name: me.actor_name || null, actor_role: me.actor_role || 'staff',
        action: me.action || null, target_id: me.target_id || null, target_name: me.target_name || null,
        details: me.details ? String(me.details).slice(0, 1000) : null });
      return;
    }
    await db.from('audit_log').insert({
      actor_id: me.id, actor_name: me.name, actor_role: me.staff_role || 'staff',
      action, target_id: tid || null, target_name: targetName || null,
      details: details ? String(details).slice(0, 1000) : null
    });
  } catch (e) {}
}

const rateMap = new Map();
// безопасная вставка имени в сообщение (имя может содержать угловые скобки)
// телефоны и ники не должны попадать в публичные надписи: имя, место стоянки.
// Контакты показываются только тому, кто взял заказ.
// v175/176: пауза за частые отмены — ступени и включение меняются в панели (Ещё → Защита от спама)
const GUARD_DEF = { on: true, steps: [3, 7, 15, 60, 180, 720], alertFrom: 5 };
let GCFG = { ...GUARD_DEF }, _gAt = 0;
function guardClean(c) {
  c = c || {};
  let steps = Array.isArray(c.steps) ? c.steps.map(x => Math.round(Number(x))).filter(x => Number.isFinite(x) && x >= 0 && x <= 10080).slice(0, 10) : GUARD_DEF.steps;
  if (!steps.length) steps = GUARD_DEF.steps;
  const af = Math.round(Number(c.alertFrom));
  return { on: c.on !== false, steps, alertFrom: Number.isFinite(af) && af >= 2 && af <= 20 ? af : GUARD_DEF.alertFrom };
}
async function guardLoad(force) {
  if (!force && Date.now() - _gAt < 60e3) return GCFG;
  try { const { data } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    GCFG = guardClean(data && data.guard_cfg); _gAt = Date.now(); } catch (e) {}
  return GCFG;
}
// сколько минут паузы за n отмен: 1-я бесплатно, 2-я — steps[0], 3-я — steps[1]…
function guardMins(n) { return n < 2 ? 0 : GCFG.steps[Math.min(n - 2, GCFG.steps.length - 1)]; }
async function guardResetAt(uid) {
  const { data, error } = await db.from('users').select('cancel_reset_at').eq('id', uid).maybeSingle();
  return !error && data && data.cancel_reset_at ? data.cancel_reset_at : null;
}
async function guardState(uid, resetAt) {
  let since = new Date(Date.now() - 24 * 3600e3).toISOString();
  if (resetAt && resetAt > since) since = resetAt;
  const { data } = await db.from('rides').select('created_at')
    .eq('passenger_id', uid).eq('status', 'cancelled_by_passenger_free').is('biz_id', null)
    .gt('created_at', since).order('created_at', { ascending: false }).limit(30);
  const n = (data || []).length, mins = guardMins(n);
  const left = mins ? Math.ceil((new Date(data[0].created_at).getTime() + mins * 60e3 - Date.now()) / 60e3) : 0;
  return { n, mins, left: left > 0 ? left : 0 };
}
const _cdAlerted = new Map();
async function cancelCooldown(u) {
  await guardLoad();
  if (!GCFG.on) return 0;
  const { n, mins, left } = await guardState(u.id, await guardResetAt(u.id));
  if (!left) return 0;
  if (n >= GCFG.alertFrom && _cdAlerted.get(u.id) !== n) {
    _cdAlerted.set(u.id, n);
    const tid = u.telegram_id ? String(u.telegram_id).slice(-4) : '';
    send(OWNER, `⚠️ <b>Частые отмены заявок</b>\n${safeName(u.name)} #${tid} — ${n} отмен за сутки, пауза ${waitTxt(mins)}.\nСнять паузу — панель: Ещё → Защита от спама.`,
      { reply_markup: { inline_keyboard: [[{ text: '⛔ Забанить', callback_data: 'adban:' + u.id }]] } }).catch(() => {});
  }
  return left;
}
async function guardAdmin(me, act, body) {
  if (act === 'guard-get') { await guardLoad(true); return { ok: true, cfg: GCFG, def: GUARD_DEF }; }
  if (act === 'guard-set') {
    const next = guardClean(body.cfg);
    const { error } = await db.from('settings').update({ guard_cfg: next }).eq('id', 1);
    if (error) return { code: 500, ok: false, error: /guard_cfg/.test(error.message) ? 'no_column' : 'save_failed' };
    GCFG = next; _gAt = Date.now();
    await audit(me, 'guard-cfg', null, null, `${next.on ? 'вкл' : 'выкл'}; паузы ${next.steps.join('/')} мин; сигнал с ${next.alertFrom}`);
    return { ok: true, cfg: GCFG };
  }
  if (act === 'guard-list') {
    await guardLoad();
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data: r } = await db.from('rides').select('passenger_id').eq('status', 'cancelled_by_passenger_free')
      .is('biz_id', null).gt('created_at', since).limit(2000);
    const cnt = {};
    for (const x of r || []) cnt[x.passenger_id] = (cnt[x.passenger_id] || 0) + 1;
    const ids = Object.keys(cnt).filter(id => cnt[id] >= 2).slice(0, 60);
    if (!ids.length) return { ok: true, rows: [] };
    const { data: us } = await db.from('users').select('*').in('id', ids);
    const rows = [];
    for (const u of us || []) {
      const st = await guardState(u.id, u.cancel_reset_at || null);
      if (!st.n) continue;
      rows.push({ id: u.id, name: u.name, tag: u.telegram_id ? String(u.telegram_id).slice(-4) : '', banned: !!u.is_banned, n: st.n, left: GCFG.on ? st.left : 0 });
    }
    rows.sort((x, y) => y.left - x.left || y.n - x.n);
    return { ok: true, rows };
  }
  if (act === 'guard-reset') {
    const { data: t } = await db.from('users').select('id,name,telegram_id').eq('id', String(body.user_id || '')).maybeSingle();
    if (!t) return { code: 404, ok: false, error: 'not_found' };
    const { error } = await db.from('users').update({ cancel_reset_at: new Date().toISOString() }).eq('id', t.id);
    if (error) return { code: 500, ok: false, error: /cancel_reset_at/.test(error.message) ? 'no_column' : 'save_failed' };
    _cdAlerted.delete(t.id);
    await audit(me, 'guard-reset', t.telegram_id, t.name, 'снята пауза за отмены');
    return { ok: true };
  }
  return { code: 400, ok: false, error: 'unknown' };
}
function waitTxt(m) { return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + ' мин' : ''}`.trim() : `${m} мин`; }

// v174: реклама в заявке — ссылки, @ники, слишком длинный текст
function adSpam(...parts) {
  for (let i = 0; i < parts.length; i++) {
    const t = String(parts[i] || '');
    if (!t) continue;
    if (i < 2 && t.length > 120) return 'длинный текст';
    if (/(https?:\/\/|www\.|t\.me|telegram\.me|tg:\/\/|\.(ru|com|org|net|рф|me|io)\b)/i.test(t)) return 'ссылка';
    if (/@[a-zA-Z0-9_]{3,}/.test(t)) return '@ник';
    if (/[a-z0-9_]{3,}_?bot\b/i.test(t)) return 'бот';
  }
  return null;
}
async function adAlert(u, why, text) {
  if (!u) return;
  const tid = u.telegram_id ? String(u.telegram_id).slice(-4) : '';
  send(OWNER, `🚫 <b>Попытка рекламы через заявку</b>\n${safeName(u.name)} #${tid} (${why})\n\n<code>${safeName(String(text).slice(0, 300))}</code>`,
    { reply_markup: { inline_keyboard: [[{ text: '⛔ Забанить', callback_data: 'adban:' + u.id }]] } }).catch(() => {});
}

function noContacts(s) {
  return String(s || '')
    .replace(/(?:\+?\d[\s\-()]*){10,}/g, ' ')
    .replace(/(?:\+?7|8)?[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g, ' ')
    .replace(/@[a-zA-Z0-9_]{4,}/g, ' ')
    .replace(/(?:t\.me|wa\.me|viber|whatsapp)\S*/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

function safeName(v) {
  return String(v || '?').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============ сторож: замечает накрутку и раздачу прав ============
// раз в 5 минут смотрит, что изменилось. если что-то выбивается — пишет владельцу.
let guardKnownStaff = null;     // кого знаем как персонал
let guardLastAlert  = 0;        // чтобы не заваливать сообщениями

function staffDiffers(a, b) {
  if (a.size !== b.size) return true;
  for (const [id, u] of a) {
    const v = b.get(id);
    if (!v || v.staff_role !== u.staff_role) return true;
  }
  return false;
}

async function guardCheck() {
  try {
    const since = new Date(Date.now() - 10 * 60000).toISOString();

    // 1) наплыв новых пользователей
    const { count: fresh } = await db.from('users')
      .select('id', { count: 'exact', head: true }).gte('created_at', since);

    // 2) наплыв заявок
    const { count: freshRides } = await db.from('rides')
      .select('id', { count: 'exact', head: true }).gte('created_at', since);

    // 3) кто сейчас с правами
    // настоящие права — только эти три. 'none' и пустое значение правами не являются
    const REAL_ROLES = ['owner', 'admin', 'moderator'];
    // база могла не ответить — раньше пустой ответ принимался за «у всех
    // сняли права», и сторож поднимал ложную тревогу сразу про всех
    const readStaff = async () => {
      const { data, error } = await db.from('users')
        .select('id,name,telegram_id,staff_role').in('staff_role', REAL_ROLES);
      if (error || !Array.isArray(data)) return null;
      return new Map(data.map(u => [String(u.id), u]));
    };
    let now = await readStaff();
    let staffChecked = false;
    // заметили перемены — перечитываем через 15 секунд. Тревога только
    // если второй ответ базы совпал с первым, иначе это был сбой связи
    if (now && guardKnownStaff && staffDiffers(guardKnownStaff, now)) {
      await new Promise(r => setTimeout(r, 15000));
      const again = await readStaff();
      if (!again || staffDiffers(now, again)) now = null;
      else staffChecked = true;
    }
    if (!now) console.error('guard: состав персонала не прочитан или ответы не сошлись — пропускаю');

    const alerts = [];

    if ((fresh || 0) >= 20)
      alerts.push(`👥 За 10 минут завелось <b>${fresh}</b> новых пользователей — похоже на накрутку.`);

    if ((freshRides || 0) >= 20)
      alerts.push(`📋 За 10 минут создано <b>${freshRides}</b> заявок — похоже на накрутку.`);

    // сравниваем состав персонала с прошлой проверкой
    if (now && guardKnownStaff) {
      for (const [id, u] of now) {
        const was = guardKnownStaff.get(id);
        if (!was) {
          alerts.push(`🛑 Новые права: <b>${safeName(u.name)}</b> стал <b>${u.staff_role}</b> (ID ${u.telegram_id}).`);
        } else if (was.staff_role !== u.staff_role) {
          alerts.push(`🛑 Роль изменена: <b>${safeName(u.name)}</b> — было ${was.staff_role}, стало <b>${u.staff_role}</b>.`);
        }
      }
      for (const [id, u] of guardKnownStaff) {
        if (!now.has(id))
          alerts.push(`⚠️ Права сняты: <b>${safeName(u.name)}</b> (был ${u.staff_role}).`);
      }
    }
    if (now) guardKnownStaff = now;

    if (!alerts.length) return;

    // не чаще одного письма в 15 минут, чтобы не спамить
    if (Date.now() - guardLastAlert < 15 * 60000) return;
    guardLastAlert = Date.now();

    await send(OWNER,
      '🚨 <b>Похоже, что-то не так</b>\n' +
      (staffChecked ? '<i>Изменения в правах подтверждены повторной проверкой.</i>\n' : '') +
      '\n' + alerts.join('\n\n') +
      '\n\nЕсли это не вы — проверьте панель и напишите /backup, чтобы сохранить копию до изменений.'
    );
  } catch (e) {
    console.error('guard', e.message);
  }
}

setInterval(guardCheck, 5 * 60000);
setTimeout(guardCheck, 20000);   // первый прогон вскоре после запуска — запомнить состав персонала

// ============ документы живут ограниченное время ============
// после проверки фото хранится несколько дней и удаляется само.
// в базе остаётся только отметка: кто проверил и когда.
async function docsKeepDays() {
  try {
    const { data } = await db.from('settings').select('docs_keep_days').eq('id', 1).maybeSingle();
    const n = data && data.docs_keep_days;
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 3;
  } catch (e) { return 3; }
}

// вытащить путь внутри хранилища из полной ссылки
function storagePath(url, bucket) {
  if (!url) return null;
  const mark = '/object/public/' + bucket + '/';
  const i = String(url).indexOf(mark);
  if (i === -1) return null;
  return decodeURIComponent(String(url).slice(i + mark.length).split('?')[0]);
}

async function wipeDocs() {
  const nowIso = new Date().toISOString();
  let wiped = 0;

  try {
    // машины
    const { data: cars } = await db.from('cars')
      .select('id,doc_pts,doc_license').lte('docs_wipe_at', nowIso).limit(200);
    for (const c of cars || []) {
      const paths = [storagePath(c.doc_pts, 'docs'), storagePath(c.doc_license, 'docs')].filter(Boolean);
      if (paths.length) await db.storage.from('docs').remove(paths).catch(() => {});
      await db.from('cars').update({ doc_pts: null, doc_license: null, docs_wipe_at: null }).eq('id', c.id);
      wiped++;
    }

    // водители
    const { data: us } = await db.from('users')
      .select('id,doc_license,doc_pts,doc_car').lte('docs_wipe_at', nowIso).limit(200);
    for (const u of us || []) {
      const paths = [storagePath(u.doc_license, 'docs'), storagePath(u.doc_pts, 'docs'), storagePath(u.doc_car, 'docs')].filter(Boolean);
      if (paths.length) await db.storage.from('docs').remove(paths).catch(() => {});
      await db.from('users').update({ doc_license: null, doc_pts: null, doc_car: null, docs_wipe_at: null }).eq('id', u.id);
      wiped++;
    }
  } catch (e) { console.error('wipeDocs', e.message); }

  if (wiped) console.log('документы удалены у', wiped, 'записей');
  setTimeout(wipeDocs, 60 * 60 * 1000);      // раз в час
}
setTimeout(wipeDocs, 90 * 1000);             // первый прогон вскоре после запуска

// ============ ежедневная резервная копия ============
// раз в сутки складываем все таблицы в один архив и шлём владельцу в Telegram.
// это единственная копия — платных бэкапов на бесплатном тарифе нет.
const BACKUP_TABLES = [
  'users', 'contacts', 'rides', 'offers', 'reviews', 'messages', 'shifts',
  'cars', 'complaints', 'payments', 'promos', 'sources', 'settings',
  'cities', 'broadcasts', 'audit_log', 'support_msgs', 'admin_msgs',
  'group_pins', 'winback_queue', 'reports', 'pending_refs', 'pending_src', 'tg_events', 'points', 'inv_links', 'invitees',
  'businesses', 'biz_staff', 'biz_orders', 'call_log', 'call_sent', 'ride_notify', 'ride_ask', 'spam_log'
];
// по какому полю листать таблицу (у кого нет id)
const BACKUP_KEY = { contacts: 'user_id', group_pins: 'city_name', inv_links: 'code', invitees: 'tg_id',
  pending_refs: 'tg_id', pending_src: 'tg', sources: 'code', biz_staff: 'user_id', biz_orders: 'ride_id' };

async function makeBackup() {
  const dump = {};
  let rows = 0;
  for (const t of BACKUP_TABLES) {
    try {
      // база отдаёт не больше 1000 строк за раз — листаем страницами, иначе копия неполная
      const all = [];
      let err = null;
      for (let i = 0; i < 500; i++) {
        const { data, error } = await db.from(t).select('*').order(BACKUP_KEY[t] || 'id').range(i * 1000, i * 1000 + 999);
        if (error) { err = error.message; break; }
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      if (err && !all.length) { dump[t] = { error: err }; continue; }
      dump[t] = all;
      rows += all.length;
    } catch (e) {
      dump[t] = { error: String(e.message || e) };
    }
  }
  const json = JSON.stringify({ made_at: new Date().toISOString(), rows, tables: dump });
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  return { gz, rows, size: gz.length };
}

async function sendBackup(chatId) {
  const { gz, rows, size } = await makeBackup();
  const day = new Date().toISOString().slice(0, 10);
  const mb = (size / 1048576).toFixed(2);

  // телеграм не принимает файлы тяжелее 50 МБ
  if (size > 49 * 1048576) {
    await send(chatId, `⚠️ Копия слишком большая (${mb} МБ) — Telegram столько не примет.\nНужно выгружать частями, напишите разработчику.`);
    return false;
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `🗄 Копия базы за ${day}\nЗаписей: ${rows} · размер ${mb} МБ\n\nХраните файл в надёжном месте: внутри телефоны и переписка.`);
  form.append('document', new Blob([gz], { type: 'application/gzip' }), `bombily-${day}.json.gz`);

  const r = await fetch(API('sendDocument'), { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('backup send', j.description);
  return !!j.ok;
}

// ждём 4 утра по местному времени
function msUntilBackup() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(4, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

function scheduleBackup() {
  setTimeout(async () => {
    try { await sendBackup(OWNER); } catch (e) { console.error('backup', e.message); }
    scheduleBackup();          // ставим следующую
  }, msUntilBackup());
}
scheduleBackup();

/* ---------- сводки в Telegram (v162) ----------
   утром в 9:00 — владельцу итоги вчерашнего дня,
   по понедельникам в 10:00 — итоги недели в группе водителей каждого города.
   Отметка «уже отправлено» хранится в settings — после перезапуска не дублируем. */
const RP_MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const RP_WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const rpYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const rpDay0 = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// что случилось с заявками за отрезок времени (город — по желанию)
async function rpStats(from, to, city) {
  let q = db.from('rides').select('id,status,price,city,created_at,driver_id')
    .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).limit(5000);
  if (city) q = q.eq('city', city);
  const { data: rows } = await q;
  const list = rows || [];
  const waitIds = list.filter(r => r.status === 'created').map(r => r.id);
  const offersBy = {};
  for (let i = 0; i < waitIds.length; i += 200) {
    const { data: offs } = await db.from('offers').select('ride_id').in('ride_id', waitIds.slice(i, i + 200));
    (offs || []).forEach(o => { offersBy[o.ride_id] = (offersBy[o.ride_id] || 0) + 1; });
  }
  const s = { total: list.length, done: 0, money: 0, noOffers: 0, notPicked: 0, cancelP: 0, cancelD: 0, going: 0,
    byHour: Array(24).fill(0), lostByHour: Array(24).fill(0), missByHour: Array(24).fill(0), byDriver: {} };
  const now = Date.now();
  for (const r of list) {
    const st = String(r.status || '');
    const h = new Date(r.created_at).getHours();     // часы по Москве (TZ задан в начале файла)
    s.byHour[h]++;
    if (st === 'completed') {
      s.done++; s.money += Number(r.price) || 0;
      if (r.driver_id) s.byDriver[r.driver_id] = (s.byDriver[r.driver_id] || 0) + 1;
    } else if (st === 'confirmed' || st === 'in_progress') s.going++;
    else if (st === 'created') {
      if (now - new Date(r.created_at).getTime() < 30 * 60000) s.going++;
      else { if (offersBy[r.id]) s.notPicked++; else { s.noOffers++; s.missByHour[h]++; } s.lostByHour[h]++; }
    } else if (st.includes('cancelled')) {
      if (st.includes('driver')) { s.cancelD++; s.missByHour[h]++; } else s.cancelP++;
      s.lostByHour[h]++;
    }
  }
  s.lost = s.noOffers + s.notPicked + s.cancelP + s.cancelD;
  return s;
}
async function rpNames(ids) {
  if (!ids.length) return {};
  const { data } = await db.from('users').select('id,name').in('id', ids);
  const m = {}; (data || []).forEach(u => { m[u.id] = u.name; });
  return m;
}
// два самых «горячих» отрезка по 3 часа: «с 7 до 10 и с 17 до 20»
function rpPeak(h) {
  const w = [];
  for (let i = 0; i <= 21; i++) w.push([h[i] + h[i + 1] + h[i + 2], i]);
  w.sort((a, b) => b[0] - a[0]);
  if (!w[0][0]) return '';
  const w1 = w[0][1];
  const x = w.find(z => z[0] > 0 && Math.abs(z[1] - w1) >= 3);
  return [w1].concat(x ? [x[1]] : []).sort((a, b) => a - b).map(st => `с ${st} до ${st + 3}`).join(' и ');
}
async function rpCount(table, build) {
  try { let q = db.from(table).select('*', { count: 'exact', head: true }); q = build(q); const { count } = await q; return count || 0; }
  catch (e) { return 0; }
}

async function dailyReportText() {
  const t0 = rpDay0(new Date());
  const y0 = new Date(t0.getTime() - 864e5), yy0 = new Date(t0.getTime() - 2 * 864e5);
  const [s, p, newU, pend, cmp, sup, onl] = await Promise.all([
    rpStats(y0, t0), rpStats(yy0, y0),
    rpCount('users', q => q.gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString())),
    rpCount('users', q => q.eq('driver_status', 'pending')),
    rpCount('complaints', q => q.in('status', ['new', 'pending'])),
    rpCount('support_msgs', q => q.eq('answered', false)),
    rpCount('users', q => q.eq('status', 'online'))
  ]);
  const L = [`📊 <b>Итоги за вчера</b> · ${y0.getDate()} ${RP_MON[y0.getMonth()]}, ${RP_WD[y0.getDay()]}`, ''];
  if (!s.total) L.push('Заявок не было.');
  else {
    L.push(`Заявок: <b>${s.total}</b> <i>(позавчера ${p.total})</i>`);
    L.push(`Доехали: <b>${s.done}</b> из ${s.total}`);
    if (s.lost) {
      const why = [[s.noOffers, 'никто не откликнулся'], [s.notPicked, 'не выбрали водителя'], [s.cancelP, 'отменил пассажир'], [s.cancelD, 'отказался водитель']]
        .filter(x => x[0]).map(x => `${x[1]} — ${x[0]}`).join(', ');
      L.push(`Потеряли: <b>${s.lost}</b> (${why})`);
    }
    L.push(`Заработали водители: <b>${s.money.toLocaleString('ru')} ₽</b>`);
  }
  L.push(`Новых людей: <b>${newU}</b>`);
  const [jn, lv, stn] = await Promise.all([
    rpCount('tg_events', q => q.eq('kind', 'join').gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString())),
    rpCount('tg_events', q => q.eq('kind', 'leave').gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString())),
    rpCount('tg_events', q => q.eq('kind', 'start').eq('is_new', true).gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString()))
  ]);
  if (jn || lv || stn) L.push(`Группы: вступили <b>${jn}</b>, вышли <b>${lv}</b> · в бота пришли: <b>${stn}</b>`);
  if (ranksReady) {
    try {
      const pr = await ptAll(() => db.from('points').select('driver_id,delta,reason,meta').neq('reason', 'start')
        .gte('created_at', y0.toISOString()).lt('created_at', t0.toISOString()).order('id'), 10);
      const plus = pr.filter(x => x.delta > 0).reduce((a, x) => a + x.delta, 0);
      const minus = pr.filter(x => x.delta < 0).reduce((a, x) => a + x.delta, 0);
      const ups = pr.filter(x => x.reason === 'rank_up');
      const inv = await rpCount('invitees', q => q.gte('joined_at', y0.toISOString()).lt('joined_at', t0.toISOString()));
      let line = `🏅 Баллы: +${plus}${minus ? ` / −${-minus}` : ''}`;
      if (ups.length) {
        const nm = await rpNames([...new Set(ups.map(x => x.driver_id))]);
        line += ` · новые звания: ${ups.slice(0, 5).map(x => `${safeName(nm[x.driver_id] || 'водитель')} — ${RANK_NAMES[x.meta] || x.meta}`).join(', ')}`;
      }
      if (inv) line += ` · по приглашениям пришли: ${inv}`;
      if (plus || minus || ups.length || inv) L.push(line);
    } catch (e) {}
  }
  const callLn = await callReportLine(y0, t0);
  if (callLn) L.push(callLn);
  const bizLn = await bizReportLine(y0, t0);
  if (bizLn) L.push(bizLn);
  const top = Object.entries(s.byDriver).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const nm = await rpNames([top[0]]);
    L.push('', `🏆 Больше всех возил: <b>${safeName(nm[top[0]] || 'водитель')}</b> — ${top[1]} ${plural(top[1], ['поездка', 'поездки', 'поездок'])}`);
  }
  const att = [];
  if (pend) att.push(`${pend} ${plural(pend, ['водитель ждёт', 'водителя ждут', 'водителей ждут'])} проверки`);
  if (cmp) att.push(`${cmp} ${plural(cmp, ['жалоба', 'жалобы', 'жалоб'])}`);
  if (sup) att.push(`${sup} ${plural(sup, ['обращение', 'обращения', 'обращений'])} в поддержку`);
  if (s.noOffers >= 2) att.push(`${s.noOffers} ${plural(s.noOffers, ['заявка осталась', 'заявки остались', 'заявок остались'])} совсем без ответа водителей`);
  if (!onl) att.push('на линии сейчас никого');
  L.push('', att.length ? '⚠️ <b>Требует внимания:</b>\n' + att.map(a => '• ' + a).join('\n') : '✅ Ничего срочного');
  return L.join('\n');
}
async function sendDailyReport(chat) {
  const text = await dailyReportText();
  return send(chat, text, { reply_markup: { inline_keyboard: [[wa('📊 Открыть статистику', 'stat', { id: chat })]] } });
}

// итоги прошлой недели (пн–вс) по одному городу
async function weeklyReport(city) {
  const t0 = rpDay0(new Date());
  const dow = (t0.getDay() + 6) % 7;                       // понедельник = 0
  const thisMon = new Date(t0.getTime() - dow * 864e5);
  const lastMon = new Date(thisMon.getTime() - 7 * 864e5), prevMon = new Date(lastMon.getTime() - 7 * 864e5);
  const [s, p] = await Promise.all([rpStats(lastMon, thisMon, city), rpStats(prevMon, lastMon, city)]);
  const sun = new Date(thisMon.getTime() - 864e5);
  const per = lastMon.getMonth() === sun.getMonth()
    ? `${lastMon.getDate()}–${sun.getDate()} ${RP_MON[sun.getMonth()]}`
    : `${lastMon.getDate()} ${RP_MON[lastMon.getMonth()]} – ${sun.getDate()} ${RP_MON[sun.getMonth()]}`;
  const L = [`📈 <b>Итоги недели · ${safeName(city)}</b>`, per, ''];
  if (!s.total) { L.push('За неделю заявок не было.'); return { text: L.join('\n'), total: 0 }; }
  L.push(`Поездок: <b>${s.done}</b> <i>(неделей раньше — ${p.done})</i>`);
  L.push(`Заявок: <b>${s.total}</b>, из них уехали ${s.done}`);
  const top = Object.entries(s.byDriver).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) {
    const nm = await rpNames(top.map(x => x[0]));
    L.push('', '🏆 <b>Больше всех возили:</b>');
    top.forEach((x, i) => L.push(`${i + 1}. ${safeName(nm[x[0]] || 'водитель')} — ${x[1]} ${plural(x[1], ['поездка', 'поездки', 'поездок'])}`));
  }
  const pk = rpPeak(s.byHour);
  if (pk) L.push('', `⏰ Чаще всего заказывают ${pk} часов.`);
  const miss = s.noOffers + s.cancelD;          // люди хотели уехать, а машины не нашлось
  if (miss) {
    const lp = rpPeak(s.missByHour);
    L.push(`😔 Без машины остались ${miss} ${plural(miss, ['человек', 'человека', 'человек'])}${lp ? ` — чаще всего ${lp} часов` : ''}. Выходите на линию в это время — заказы ждут!`);
  }
  L.push('', 'Хорошей недели! 🚕');
  return { text: L.join('\n'), total: s.total };
}
// previewChat — прислать всё себе в личку, в группы ничего не отправлять
async function sendWeeklyReports(previewChat) {
  const { data: cities } = await db.from('cities').select('*').eq('active', true);
  let sent = 0;
  for (const c of cities || []) {
    const r0 = await weeklyReport(c.name);
    if (previewChat) {
      if (!c.driver_group_id && !r0.total) continue;
      await send(previewChat, r0.text + (c.driver_group_id ? '' : '\n\n<i>У города нет группы водителей — туда это не уйдёт.</i>'));
      sent++; continue;
    }
    if (!c.driver_group_id || !r0.total) continue;
    const r = await send(c.driver_group_id, r0.text, {
      reply_markup: { inline_keyboard: [[{ text: '🚗 Выйти на линию', url: `https://t.me/${BOT_USERNAME}?startapp=driver` }]] }
    });
    if (r && r.ok) sent++; else console.error('weekly', c.name, r && r.description);
  }
  return sent;
}
// раз в 5 минут смотрим, не пора ли отправить
async function reportTick() {
  try {
    const { data: st } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (!st || !('report_daily_last' in st)) return;   // миграция db-25 ещё не выполнена
    const now = new Date();
    const h = now.getHours();
    const today = rpYmd(now);
    if (st.report_daily_on !== false && h >= 9 && h < 22 && st.report_daily_last !== today) {
      await db.from('settings').update({ report_daily_last: today }).eq('id', 1);
      await sendDailyReport(OWNER);
    }
    if (st.report_weekly_on !== false && now.getDay() === 1 && h >= 10 && h < 21 && st.report_weekly_last !== today) {
      await db.from('settings').update({ report_weekly_last: today }).eq('id', 1);
      await sendWeeklyReports();
    }
  } catch (e) { console.error('report', e.message); }
}
setInterval(reportTick, 5 * 60000);
setTimeout(reportTick, 90 * 1000);

/* ---------- ранги и баллы водителей (v165) ----------
   Все цифры — в settings.rank_cfg: их меняет владелец в панели «Ещё → Ранги и баллы».
   Если там пусто — работают значения по умолчанию ниже.
   Баллы — в закрытой таблице points: каждая строка — за что и сколько.
   Ранги: Бронза → Серебро → Золото → Платина → Алмаз. Месяц без поездок — ранг на паузе,
   пока водитель не сделает 5 поездок. Пока миграция db-27/28 не выполнена — всё молчит. */
const RANK_CODES = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
const RANK_NAMES = { bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', platinum: 'Платина', diamond: 'Алмаз' };
const RANK_GEN = { bronze: 'Бронзы', silver: 'Серебра', gold: 'Золота', platinum: 'Платины', diamond: 'Алмаза' };
const RANK_IDX = Object.fromEntries(RANK_CODES.map((c, i) => [c, i]));
const RANK_TAG = { bronze: 'Бомбила Бронза', silver: 'Бомбила Серебро', gold: 'Бомбила Золото', platinum: 'Бомбила Платина', diamond: 'Бомбила Алмаз' };
const RANK_DEF = {
  pts: { ride: 5, peak: 1, star: 1, fast: 1, ref: 10, invJoin: 1, invRide: 10, cancel: -15, complaint: -30, invSpam: -10 },
  lim: { dayCap: 40, perPassenger: 2, minMinutes: 5, fastSec: 60, freeCant: 1, noshowMin: 10, earlyHours: 2,
    pauseDays: 30, unpauseRides: 5, invMonthCap: 30, invStayDays: 7, invBurst: 5 },
  peak: [[7, 10], [17, 21]],
  ranks: {
    bronze:   { pts: 50,   rides: 5 },
    silver:   { pts: 250,  rides: 30 },
    gold:     { pts: 1000, rides: 120, rating: 4.7, cancel: 10 },
    platinum: { pts: 3000, rides: 350, rating: 4.8, cancel: 5, days: 180 },
    diamond:  { pts: 8000, rides: 900, rating: 4.9, cancel: 3, days: 365 }
  },
  feat: { invites: true, minRides: true, offerBadge: true, topList: true }
};
// пределы для каждого числа — чтобы опечатка в панели ничего не сломала
const RANK_LIM = {
  pts: { ride: [0, 100], peak: [0, 50], star: [0, 50], fast: [0, 50], ref: [0, 500], invJoin: [0, 100], invRide: [0, 500],
    cancel: [-500, 0], complaint: [-1000, 0], invSpam: [-500, 0] },
  lim: { dayCap: [0, 1000], perPassenger: [1, 20], minMinutes: [0, 60], fastSec: [10, 600], freeCant: [0, 7], noshowMin: [3, 60],
    earlyHours: [0, 72], pauseDays: [7, 365], unpauseRides: [1, 50], invMonthCap: [0, 1000], invStayDays: [1, 60], invBurst: [2, 100] },
  rank: { pts: [1, 1000000], rides: [0, 100000], rating: [0, 5], cancel: [0, 100], days: [0, 3650] }
};
function rankCfgClean(x) {
  const src = x && typeof x === 'object' ? x : {};
  const out = JSON.parse(JSON.stringify(RANK_DEF));
  const num = (v, [a, b], dflt) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !isFinite(n)) return dflt;
    return Math.min(b, Math.max(a, n));
  };
  for (const g of ['pts', 'lim']) for (const k of Object.keys(RANK_DEF[g])) out[g][k] = Math.round(num(src[g] && src[g][k], RANK_LIM[g][k], RANK_DEF[g][k]));
  if (Array.isArray(src.peak)) {
    out.peak = src.peak.filter(p => Array.isArray(p) && p.length === 2)
      .map(([a, b]) => [Math.round(num(a, [0, 23], -1)), Math.round(num(b, [1, 24], -1))])
      .filter(([a, b]) => a >= 0 && b > a).slice(0, 3);
  }
  for (const c of RANK_CODES) {
    const s = (src.ranks && src.ranks[c]) || {}, d = RANK_DEF.ranks[c], o = {};
    o.pts = Math.round(num(s.pts, RANK_LIM.rank.pts, d.pts));
    o.rides = Math.round(num(s.rides, RANK_LIM.rank.rides, d.rides));
    for (const k of ['rating', 'cancel', 'days']) {
      const v = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : d[k];
      if (v === null || v === undefined || v === '' || v === false) continue;        // условие выключено
      const n = num(v, RANK_LIM.rank[k], null);
      if (n === null) continue;
      o[k] = k === 'rating' ? Math.round(n * 10) / 10 : Math.round(n);
    }
    out.ranks[c] = o;
  }
  // следующий ранг не может быть легче предыдущего
  for (let i = 1; i < RANK_CODES.length; i++) {
    const p = out.ranks[RANK_CODES[i - 1]], r = out.ranks[RANK_CODES[i]];
    if (r.pts <= p.pts) r.pts = p.pts + 1;
    if (r.rides < p.rides) r.rides = p.rides;
  }
  for (const k of Object.keys(RANK_DEF.feat)) out.feat[k] = src.feat && src.feat[k] !== undefined ? !!src.feat[k] : RANK_DEF.feat[k];
  // заказы точек (магазинов) — с какого звания: none — всем
  out.bizMin = src.bizMin === 'none' || RANK_CODES.includes(src.bizMin) ? src.bizMin : 'bronze';
  return out;
}
// может ли водитель брать заказы точек
function bizRankOk(u) {
  const min = (RCFG && RCFG.bizMin) || 'bronze';
  if (min === 'none' || !ranksReady) return true;
  if (!u || !u.rank_code || u.rank_paused || !(u.rank_code in RANK_IDX)) return false;
  return RANK_IDX[u.rank_code] >= RANK_IDX[min];
}
const bizRankTxt = () => {
  const min = (RCFG && RCFG.bizMin) || 'bronze';
  return min === 'none' ? '' : `от ${{ bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💠', diamond: '💎' }[min]} ${RANK_GEN[min]}`;
};
let RCFG = rankCfgClean(null);
async function rankCfgLoad() {
  try {
    const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
    if (!error && data) RCFG = rankCfgClean(data.rank_cfg);
  } catch (e) {}
}
const ranksList = () => RANK_CODES.map(c => ({ code: c, name: RANK_NAMES[c], ...RCFG.ranks[c] }));
let ranksReady = false;      // таблица points есть — миграция выполнена

// метка в группе города: по рангу, а без ранга или на паузе — обычная
const rankTag = u => (u && u.rank_code && !u.rank_paused && RANK_TAG[u.rank_code]) || DRIVER_TAG;
const ptPeak = d => { const h = new Date(d).getHours(); return RCFG.peak.some(([a, b]) => h >= a && h < b); };   // часы по Москве
const ptRoute = r => r ? `${String(r.from_address || '').slice(0, 50)} → ${String(r.to_address || '').slice(0, 50)}` : '';
const ptDay0 = () => { const x = new Date(); x.setHours(0, 0, 0, 0); return x.toISOString(); };
const ptWeek0 = () => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString(); };
const ptMonth0 = () => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(1); return x.toISOString(); };
const ptCap = () => RCFG.lim.dayCap > 0 ? RCFG.lim.dayCap : Infinity;

// записать баллы; уникальный ключ не даёт начислить дважды за одно и то же
async function ptAdd(driverId, delta, reason, note, uniq, extra = {}) {
  if (!ranksReady || !driverId) return false;
  try {
    const row = { driver_id: String(driverId), delta: Math.round(delta), reason,
      note: note ? String(note).slice(0, 140) : null, uniq_key: uniq || null, ...extra };
    const { data, error } = await db.from('points').insert(row).select('id').maybeSingle();
    if (error) { if (!/duplicate|unique/i.test(error.message)) console.error('points', error.message); return false; }
    return data ? data.id : true;
  } catch (e) { console.error('points', e.message); return false; }
}
// все строки по запросу — постранично: база отдаёт не больше 1000 за раз
async function ptAll(build, maxPages = 50) {
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await build().range(i * 1000, i * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
// сколько баллов за поездки водитель уже получил сегодня (для дневного предела)
async function ptToday(driverId) {
  const { data } = await db.from('points').select('delta').eq('driver_id', String(driverId))
    .in('reason', ['ride', 'star']).gte('created_at', ptDay0()).limit(1000);
  return (data || []).reduce((a, x) => a + (x.delta || 0), 0);
}
// сколько настоящих поездок засчитано (для «минимума поездок»)
const ptRides = rows => rows.reduce((a, x) => {
  if (x.reason === 'ride') return a + 1;
  if (x.reason === 'start') {
    const m = String(x.meta || '').match(/rides:(\d+)/) || String(x.note || '').match(/за (\d+)/);
    return a + (m ? Number(m[1]) : Math.round((x.delta || 0) / 5));
  }
  return a;
}, 0);

// поездка завершена — начисляем баллы водителю
async function awardRide(rideId) {
  callTook(rideId).catch(() => {});                  // вышел на линию по зову и довёз — отметка и баллы
  if (!ranksReady || !rideId) return;
  try {
    const { data: r } = await db.from('rides').select('*').eq('id', rideId).maybeSingle();
    if (!r || r.status !== 'completed' || !r.driver_id) return;
    const P = RCFG.pts, L = RCFG.lim;
    const uniq = 'ride:' + r.id;
    const base = { ride_id: String(r.id), peer_id: r.passenger_id ? String(r.passenger_id) : null };
    const route = ptRoute(r);
    if (r.auto_closed) { await ptAdd(r.driver_id, 0, 'ride_auto', route, uniq, base); return; }
    const t0 = new Date(r.confirmed_at || r.created_at).getTime();
    const t1 = r.completed_at ? new Date(r.completed_at).getTime() : Date.now();
    if (t1 - t0 < L.minMinutes * 60000) { await ptAdd(r.driver_id, 0, 'ride_short', route, uniq, base); return; }
    if (r.passenger_id) {
      // доставки одной точки — не накрутка: им засчитываем втрое больше в день
      const peer = r.biz_id ? 'biz:' + r.biz_id : String(r.passenger_id);
      if (r.biz_id) base.peer_id = peer;
      const { count: same } = await db.from('points').select('*', { count: 'exact', head: true })
        .eq('driver_id', String(r.driver_id)).eq('peer_id', peer).eq('reason', 'ride').gte('created_at', ptDay0());
      if ((same || 0) >= L.perPassenger * (r.biz_id ? 3 : 1)) { await ptAdd(r.driver_id, 0, 'ride_same', route, uniq, base); return; }
    }
    let pts = P.ride; const tags = [];
    if (P.peak && ptPeak(r.scheduled_at || r.confirmed_at || r.created_at)) { pts += P.peak; tags.push('peak'); }
    if (P.fast) try {
      const { data: of } = await db.from('offers').select('created_at').eq('ride_id', r.id).eq('driver_id', r.driver_id)
        .order('created_at', { ascending: true }).limit(1);
      if (of && of[0] && of[0].created_at && new Date(of[0].created_at) - new Date(r.created_at) < L.fastSec * 1000) { pts += P.fast; tags.push('fast'); }
    } catch (e) {}
    const give = Math.max(0, Math.min(pts, ptCap() - await ptToday(r.driver_id)));
    if (give < pts) tags.push('cap');
    const ok = await ptAdd(r.driver_id, give, 'ride', route, uniq, { ...base, meta: tags.join(',') || null });
    if (!ok) return;                                   // за эту поездку уже начисляли
    await refBonusCheck(r.driver_id);
    await invFirstRide(r);
    await rankRecalc(r.driver_id);
  } catch (e) { console.error('awardRide', e.message); }
}
// пассажир поставил 5★ — +1, если за саму поездку баллы были
async function awardStar(rideId, driverId) {
  if (!ranksReady) return;
  try {
    const find = async () => (await db.from('points').select('delta').eq('driver_id', String(driverId)).eq('uniq_key', 'ride:' + rideId).limit(1)).data;
    let rr = await find();
    if (!rr || !rr[0]) { await awardRide(rideId); rr = await find(); }   // отзыв пришёл раньше, чем баллы за поездку
    if (!RCFG.pts.star || !rr || !rr[0] || rr[0].delta <= 0) return rankRecalc(driverId);
    if (ptCap() - await ptToday(driverId) <= 0) return rankRecalc(driverId);
    const { data: r } = await db.from('rides').select('id,from_address,to_address,passenger_id').eq('id', rideId).maybeSingle();
    await ptAdd(driverId, RCFG.pts.star, 'star', ptRoute(r), 'star:' + rideId, { ride_id: String(rideId), peer_id: r && r.passenger_id ? String(r.passenger_id) : null });
    await rankRecalc(driverId);
  } catch (e) { console.error('awardStar', e.message); }
}
// приглашённый водитель сделал 10 поездок — бонус тому, кто его привёл
async function refBonusCheck(driverId) {
  try {
    if (!RCFG.pts.ref) return;
    const { data: u } = await db.from('users').select('id,name,ref_by').eq('id', driverId).maybeSingle();
    if (!u || !u.ref_by) return;
    const { data: inv } = await db.from('users').select('id,driver_status').eq('id', u.ref_by).maybeSingle();
    if (!inv || inv.driver_status !== 'approved') return;
    const { count } = await db.from('rides').select('*', { count: 'exact', head: true }).eq('driver_id', driverId).eq('status', 'completed');
    if ((count || 0) < 10) return;
    if (await ptAdd(inv.id, RCFG.pts.ref, 'ref', u.name, 'ref:' + driverId)) await rankRecalc(inv.id);
  } catch (e) {}
}

// водитель отменил взятый заказ: от причины зависит, будет ли штраф
async function driverCancelPoints(drv, ride, reason) {
  if (!ranksReady) return null;
  try {
    const P = RCFG.pts, L = RCFG.lim;
    const uniq = 'cancel:' + ride.id + ':' + drv.id;
    const base = { ride_id: String(ride.id), peer_id: ride.passenger_id ? String(ride.passenger_id) : null, meta: reason };
    const route = ptRoute(ride);
    // заказ на время, до которого ещё далеко, — пассажир успеет найти другого
    if (ride.scheduled_at && L.earlyHours > 0 && new Date(ride.scheduled_at) - Date.now() > L.earlyHours * 3600e3) {
      await ptAdd(drv.id, 0, 'cancel_early', route, uniq, base); return { delta: 0, kind: 'early' };
    }
    if (reason === 'agreed') {
      const pid = await ptAdd(drv.id, 0, 'cancel_wait', route, uniq, base);
      const ptg = ride.passenger_id ? await tgIdOf(ride.passenger_id) : null;
      if (pid && pid !== true && ptg) {
        await send(ptg, `Водитель ${safeName(drv.name)} отменил заказ\n${safeName(route)}\n\nПричина: <b>договорились с пассажиром</b>. Это так?`, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Да, так', callback_data: `ccy:${pid}` }, { text: '❌ Нет, отказался сам', callback_data: `ccn:${pid}` }]] }
        }).catch(() => {});
      }
      return { delta: 0, kind: 'wait' };
    }
    if (reason === 'noshow') {
      // минута запаса на разницу часов телефона и сервера — в пользу водителя
      if (ride.arrived_at && Date.now() - new Date(ride.arrived_at).getTime() >= (L.noshowMin - 1) * 60000) {
        await ptAdd(drv.id, 0, 'cancel_noshow', route, uniq, base); return { delta: 0, kind: 'noshow' };
      }
      reason = 'other'; base.meta = 'noshow_early';
    }
    if (reason === 'cant' && L.freeCant > 0) {
      const { count } = await db.from('points').select('*', { count: 'exact', head: true })
        .eq('driver_id', String(drv.id)).eq('reason', 'cancel_free').gte('created_at', ptWeek0());
      if ((count || 0) < L.freeCant) { await ptAdd(drv.id, 0, 'cancel_free', route, uniq, base); return { delta: 0, kind: 'free' }; }
    }
    const ok = await ptAdd(drv.id, P.cancel, 'cancel', route, uniq, base);
    if (ok) await rankRecalc(drv.id);
    return { delta: ok ? P.cancel : 0, kind: 'penalty' };
  } catch (e) { console.error('cancelPoints', e.message); return null; }
}
// пассажир ответил на «Это так?»
async function cancelConfirm(cq) {
  const yes = cq.data.startsWith('ccy:');
  const pid = cq.data.slice(4);
  const answer = (text, alert) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert });
  if (!ranksReady) return answer('Попробуйте чуть позже');
  const { data: row } = await db.from('points').select('*').eq('id', pid).maybeSingle();
  if (!row) return answer('Заказ не найден');
  const { data: ride } = await db.from('rides').select('id,passenger_id').eq('id', row.ride_id).maybeSingle();
  const ptg = ride && ride.passenger_id ? await tgIdOf(ride.passenger_id) : null;
  if (!ptg || String(ptg) !== String(cq.from.id)) return answer('Это не ваш заказ.', true);
  let changed = false;
  if (row.reason === 'cancel_wait') {
    const { data: upd } = await db.from('points').update(yes ? { reason: 'cancel_ok' } : { reason: 'cancel', delta: RCFG.pts.cancel, meta: 'denied' })
      .eq('id', row.id).eq('reason', 'cancel_wait').select('id');
    changed = !!(upd && upd.length);
  }
  await answer(changed ? 'Спасибо, учли' : 'Ответ уже учтён');
  if (cq.message) {
    const orig = String(cq.message.text || '').split('\n\nПричина')[0];
    tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: orig + '\n\n' + (yes ? '✅ Вы подтвердили: договорились.' : '❌ Вы ответили: водитель отказался сам.') }).catch(() => {});
  }
  if (!changed) return;
  const dtg = await tgIdOf(row.driver_id);
  if (dtg) send(dtg, yes ? '✅ Пассажир подтвердил отмену по договорённости — баллы не списаны.'
    : `❌ Пассажир не подтвердил отмену по договорённости — списано ${-RCFG.pts.cancel} баллов.`).catch(() => {});
  if (!yes) await rankRecalc(row.driver_id);
}
// подтверждённая жалоба на водителя (админ вынес предупреждение или бан)
async function complaintPoints(targetId, complaintId) {
  if (!ranksReady || !targetId || !complaintId || !RCFG.pts.complaint) return;
  try {
    const { data: c } = await db.from('complaints').select('*').eq('id', complaintId).maybeSingle();
    if (!c || c.kind === 'review' || String(c.target_id) !== String(targetId)) return;
    const { data: u } = await db.from('users').select('id,driver_status').eq('id', targetId).maybeSingle();
    if (!u || u.driver_status !== 'approved') return;
    if (await ptAdd(targetId, RCFG.pts.complaint, 'complaint', String(c.reason || '').slice(0, 100), 'complaint:' + complaintId)) await rankRecalc(targetId);
  } catch (e) {}
}

// пересчитать сумму, ранг и паузу; смену записываем в журнал баллов,
// ставим метку в группе и пишем водителю (кроме самого первого раза)
async function rankRecalc(driverId, opts = {}) {
  if (!ranksReady || !driverId) return null;
  try {
    const { data: u } = await db.from('users').select('*').eq('id', driverId).maybeSingle();
    if (!u) return null;
    const rows = await ptAll(() => db.from('points').select('delta,reason,meta,note,created_at').eq('driver_id', String(driverId)).order('id'));
    const total = rows.reduce((a, x) => a + (x.delta || 0), 0);
    const rides = ptRides(rows);
    const since90 = Date.now() - 90 * 864e5;
    let done90 = 0, canc90 = 0, pen90 = 0;
    for (const x of rows) {
      if (new Date(x.created_at).getTime() < since90) continue;
      const r = String(x.reason);
      if (r.startsWith('ride')) done90++;
      else if (r.startsWith('cancel')) { canc90++; if (r === 'cancel') pen90++; }
    }
    const cancelPct = done90 + canc90 ? pen90 / (done90 + canc90) * 100 : 0;
    const days = u.created_at ? (Date.now() - new Date(u.created_at).getTime()) / 864e5 : 0;
    const rating = Number(u.rating) || 5;
    const minR = RCFG.feat.minRides;
    let rank = null;
    for (const R of ranksList()) {        // каждый следующий ранг строже предыдущего во всём
      if (total < R.pts || (minR && rides < (R.rides || 0)) || (R.rating && rating < R.rating)
        || (R.cancel != null && cancelPct >= R.cancel) || (R.days && days < R.days)) break;
      rank = R.code;
    }
    // месяц без поездок — пауза, пока не сделает нужное число поездок
    const { data: last } = await db.from('rides').select('created_at').eq('driver_id', driverId).eq('status', 'completed')
      .order('created_at', { ascending: false }).limit(1);
    const lastAt = last && last[0] ? new Date(last[0].created_at).getTime() : 0;
    let pausedAt = u.rank_paused_at ? new Date(u.rank_paused_at).getTime() : null;
    if (!pausedAt && rank && lastAt && Date.now() - lastAt > RCFG.lim.pauseDays * 864e5) pausedAt = Date.now();
    let sincePause = 0;
    if (pausedAt) {
      const { count } = await db.from('rides').select('*', { count: 'exact', head: true }).eq('driver_id', driverId)
        .eq('status', 'completed').gt('created_at', new Date(pausedAt).toISOString());
      sincePause = count || 0;
      if (sincePause >= RCFG.lim.unpauseRides) pausedAt = null;
    }
    const paused = !!(pausedAt && rank);
    const prevIdx = u.rank_code && u.rank_code in RANK_IDX ? RANK_IDX[u.rank_code] : -1;
    const newIdx = rank ? RANK_IDX[rank] : -1;
    const changed = prevIdx !== newIdx || !!u.rank_paused !== paused;
    if (changed || Number(u.points_total || 0) !== total || !!u.rank_paused_at !== paused) {
      await db.from('users').update({ points_total: total, rank_code: rank, rank_paused: paused,
        rank_paused_at: paused ? new Date(pausedAt).toISOString() : null }).eq('id', driverId);
      lbCache.clear();
    }
    let evOk = true;
    if (changed) {
      const R = rank ? RANK_NAMES[rank] : null, Pn = prevIdx >= 0 ? RANK_NAMES[RANK_CODES[prevIdx]] : null;
      // события в журнал баллов — видно водителю в истории и владельцу в панели
      const evs = [];
      if (newIdx > prevIdx) evs.push(['rank_up', rank, `новое звание — ${R}`]);
      else if (newIdx < prevIdx) evs.push(['rank_down', rank || 'none', R ? `звание снижено до «${R}»` : `звание «${Pn}» снято`]);
      if (paused && !u.rank_paused) evs.push(['rank_pause', rank, `«${R}» на паузе: больше ${RCFG.lim.pauseDays} дней без поездок`]);
      else if (!paused && u.rank_paused && rank) evs.push(['rank_resume', rank, `«${R}» снова действует`]);
      // ключ с минутой — два одновременных пересчёта не запишут событие дважды
      if (evs.length) {
        evOk = false;
        for (const ev of evs) if (await ptAdd(driverId, 0, ev[0], ev[2], `ev:${ev[0]}:${ev[1]}:${Math.floor(Date.now() / 60000)}`, { meta: ev[1] })) evOk = true;
      }
    }
    if (changed && u.driver_status === 'approved' && !u.is_banned) {
      setDriverTag({ ...u, rank_code: rank, rank_paused: paused }, true).catch(() => {});
      // карточка в группе обновится в течение минуты
      db.from('driver_posts').update({ last_status: 'rank' }).eq('driver_id', u.id).then(() => {}, () => {});
      if (!opts.silent && evOk && u.telegram_id) {
        const R = rank ? RANK_NAMES[rank] : null, Pc = prevIdx >= 0 ? RANK_CODES[prevIdx] : null;
        const n = total.toLocaleString('ru');
        let msg = '';
        if (paused && !u.rank_paused) msg = `⏸ <b>Ранг «${R}» на паузе</b>\n\nБольше месяца не было поездок. Сделайте ${RCFG.lim.unpauseRides} поездок — значок и метка вернутся.`;
        else if (newIdx > prevIdx && !paused) msg = `🏅 <b>Новый ранг — ${R}!</b>\n\nУ вас ${n} ${plural(total, ['балл', 'балла', 'баллов'])}. Значок уже на вашей карточке у пассажиров, метка «${RANK_TAG[rank]}» — в группе города.`;
        else if (!paused && u.rank_paused && newIdx >= prevIdx) msg = `▶️ <b>Ранг «${R}» снова действует</b>\n\nСпасибо, что вернулись на линию!`;
        else if (newIdx < prevIdx && Pc) {
          const P = RCFG.ranks[Pc], why = [];
          if (total < P.pts) why.push(`баллов ${n} из ${P.pts.toLocaleString('ru')}`);
          if (minR && rides < (P.rides || 0)) why.push(`поездок ${rides} из ${P.rides}`);
          if (P.rating && rating < P.rating) why.push(`рейтинг ${rating.toFixed(1).replace('.', ',')} — нужно от ${String(P.rating).replace('.', ',')}`);
          if (P.cancel != null && cancelPct >= P.cancel) why.push(`отказов ${Math.round(cancelPct)}% за 3 месяца — нужно меньше ${P.cancel}%`);
          if (P.days && days < P.days) why.push(`стаж ${Math.floor(days)} дней из ${P.days}`);
          msg = `📉 <b>Ранг сейчас — ${R || 'без ранга'}</b>\n\nДля «${RANK_GEN[Pc]}» не хватает: ${why.join('; ') || 'условий'}. Ранг вернётся сам, как только всё выполните.`;
        }
        if (msg) send(u.telegram_id, msg, { reply_markup: { inline_keyboard: [[wa('🏅 Мой ранг', 'rank', { id: u.telegram_id })]] } }).catch(() => {});
      }
    }
    return { total, rank, paused, sincePause, rides, cancelPct: Math.round(cancelPct * 10) / 10, done90, canc90, pen90, days: Math.floor(days), rating };
  } catch (e) { console.error('rankRecalc', e.message); return null; }
}

// баллы за поездки до запуска рангов — по тем же правилам: не больше 2 поездок
// с одним пассажиром в день, не больше дневного предела, без коротких и закрытых ботом
async function ptBackfill(driverId) {
  const rides = await ptAll(() => db.from('rides').select('id,passenger_id,created_at,confirmed_at,completed_at,auto_closed')
    .eq('driver_id', driverId).eq('status', 'completed').order('created_at').order('id'), 20);
  const seen = new Set((await ptAll(() => db.from('points').select('ride_id').eq('driver_id', String(driverId))
    .not('ride_id', 'is', null).order('id'), 20)).map(x => String(x.ride_id)));
  const L = RCFG.lim, per = Math.max(1, RCFG.pts.ride);
  const dayMax = isFinite(ptCap()) ? Math.floor(ptCap() / per) : Infinity;
  const perDay = {}, perPass = {};
  let n = 0;
  for (const r of rides) {
    if (seen.has(String(r.id)) || r.auto_closed) continue;
    if (r.confirmed_at && r.completed_at && new Date(r.completed_at) - new Date(r.confirmed_at) < L.minMinutes * 60000) continue;
    const day = rpYmd(new Date(r.created_at)), pk = day + ':' + (r.passenger_id || '-');
    if ((perPass[pk] || 0) >= L.perPassenger || (perDay[day] || 0) >= dayMax) continue;
    perPass[pk] = (perPass[pk] || 0) + 1; perDay[day] = (perDay[day] || 0) + 1; n++;
  }
  await ptAdd(driverId, n * RCFG.pts.ride, 'start', `за ${n} ${plural(n, ['поездку', 'поездки', 'поездок'])} до запуска рангов`, 'start', { meta: 'rides:' + n });
}

/* ---------- приглашения в группу города ----------
   У каждого водителя своя ссылка. Бот видит, кто по чьей ссылке вошёл (или кто кого добавил).
   За само вступление — мало и только через неделю, если человек остался и прошёл проверку.
   Основное — когда друг сделал первую поездку. Защита от накрутки:
   считаем только новых людей, лимит в месяц, всплеск по одной ссылке — заморозка и сообщение владельцу,
   приглашённого забанили за спам — штраф пригласившему. */
const invBurstSent = new Map();
async function invOnJoin(cm, who, g) {
  try {
    if (!ranksReady || !RCFG.feat.invites || !g || g.type !== 'city' || !who || who.is_bot) return;
    let inviter = null, how = null;
    const nm = cm.invite_link && cm.invite_link.name;
    if (nm && /^drv:/.test(nm)) {
      const { data: l } = await db.from('inv_links').select('driver_id').eq('code', nm.slice(4)).maybeSingle();
      if (l) { inviter = l.driver_id; how = 'link'; }
    } else if (cm.from && cm.from.id !== who.id && !cm.from.is_bot) {
      const { data: a } = await db.from('users').select('id,driver_status').eq('telegram_id', cm.from.id).maybeSingle();
      if (a && a.driver_status === 'approved') { inviter = a.id; how = 'added'; }
    }
    if (!inviter) return;
    const { data: ex } = await db.from('invitees').select('tg_id').eq('tg_id', who.id).maybeSingle();
    if (ex) return;                                       // этого человека уже кто-то приводил
    const { data: inv } = await db.from('users').select('id,name,telegram_id').eq('id', inviter).maybeSingle();
    if (!inv || String(inv.telegram_id) === String(who.id)) return;
    let status = 'wait';
    // уже был в приложении или в группе раньше — это не новый человек
    const { data: known } = await db.from('users').select('id').eq('telegram_id', who.id).maybeSingle();
    const { count: wasIn } = await db.from('tg_events').select('*', { count: 'exact', head: true }).eq('kind', 'join')
      .eq('tg_id', who.id).lt('created_at', new Date(Date.now() - 120000).toISOString());
    if (known || wasIn) status = 'old';
    if (status === 'wait') {
      const { count: recent } = await db.from('invitees').select('*', { count: 'exact', head: true })
        .eq('inviter_id', String(inviter)).gte('joined_at', new Date(Date.now() - 3600e3).toISOString());
      if ((recent || 0) >= RCFG.lim.invBurst) {
        status = 'burst';
        const k = String(inviter), t = invBurstSent.get(k) || 0;
        if (Date.now() - t > 3600e3 && OWNER) {
          invBurstSent.set(k, Date.now());
          send(OWNER, `⚠️ <b>Подозрительно много вступлений</b>\nПо приглашению водителя ${safeName(inv.name)} за час пришло больше ${RCFG.lim.invBurst} человек (${safeName(g.city)}).\nБаллы за них не начисляются. Посмотреть: Ещё → Ранги и баллы → Друзья.`,
            { reply_markup: { inline_keyboard: [[wa('Открыть панель', 'admin')]] } }).catch(() => {});
        }
      }
    }
    await db.from('invitees').insert({ tg_id: who.id, inviter_id: String(inviter), chat_id: cm.chat.id, city: g.city,
      name: String(who.first_name || '').slice(0, 64), how, status, joined_at: new Date().toISOString() });
  } catch (e) { console.error('invOnJoin', e.message); }
}
// начислить за приглашение — не больше лимита в месяц
async function invAward(inviterId, pts, reason, note, uniq) {
  if (!pts) return false;
  const { data: u } = await db.from('users').select('id,driver_status').eq('id', inviterId).maybeSingle();
  if (!u || u.driver_status !== 'approved') return false;
  let give = pts, meta = null;
  if (pts > 0) {
    const { data } = await db.from('points').select('delta').eq('driver_id', String(inviterId)).in('reason', ['inv_join', 'inv_ride'])
      .gte('created_at', ptMonth0()).limit(1000);
    const used = (data || []).reduce((a, x) => a + (x.delta || 0), 0);
    give = Math.max(0, Math.min(pts, RCFG.lim.invMonthCap - used));
    if (give < pts) meta = 'cap';
  }
  const ok = await ptAdd(inviterId, give, reason, note, uniq, { meta });
  if (ok && give) await rankRecalc(inviterId);
  return ok;
}
// через неделю: остался ли человек в группе и прошёл ли проверку
async function invCheck() {
  if (!ranksReady || !RCFG.feat.invites) return;
  try {
    const cutoff = new Date(Date.now() - RCFG.lim.invStayDays * 864e5).toISOString();
    const rows = await ptAll(() => db.from('invitees').select('*').eq('status', 'wait').lte('joined_at', cutoff).order('joined_at'), 5);
    for (const r of rows) {
      const m = await tg('getChatMember', { chat_id: r.chat_id, user_id: r.tg_id }).catch(() => null);
      const st = m && m.ok && m.result ? m.result.status : null;
      if (!st) continue;                                  // телеграм не ответил — проверим в следующий раз
      let status = 'left';
      if (st === 'member' || st === 'administrator' || st === 'creator') status = 'ok';
      else if (st === 'restricted') status = m.result.is_member === false ? 'left' : (m.result.can_send_messages === false ? 'nocap' : 'ok');
      else if (st === 'kicked') status = 'spam';
      await db.from('invitees').update({ status, checked_at: new Date().toISOString() }).eq('tg_id', r.tg_id).eq('status', 'wait');
      if (status === 'ok') await invAward(r.inviter_id, RCFG.pts.invJoin, 'inv_join', r.name, 'invj:' + r.tg_id);
      if (status === 'spam') await invSpam(r.tg_id);
    }
  } catch (e) { console.error('invCheck', e.message); }
}
// приглашённого забанили как спамера — штраф пригласившему (один раз)
async function invSpam(tgId) {
  try {
    if (!ranksReady || !RCFG.pts.invSpam) return;
    const { data: r } = await db.from('invitees').select('*').eq('tg_id', tgId).maybeSingle();
    if (!r || ['old', 'burst'].includes(r.status)) return;
    await db.from('invitees').update({ status: 'spam' }).eq('tg_id', tgId);
    if (await ptAdd(r.inviter_id, RCFG.pts.invSpam, 'inv_spam', r.name, 'invs:' + tgId)) await rankRecalc(r.inviter_id);
  } catch (e) {}
}
// разбанили — «это не спам»: штраф отменяем
async function invUnspam(tgId) {
  try {
    if (!ranksReady) return;
    const { data: r } = await db.from('invitees').select('*').eq('tg_id', tgId).maybeSingle();
    if (!r) return;
    await db.from('invitees').update({ status: 'ok' }).eq('tg_id', tgId).eq('status', 'spam');
    const { data: row } = await db.from('points').select('*').eq('driver_id', String(r.inviter_id)).eq('uniq_key', 'invs:' + tgId).maybeSingle();
    if (row && row.reason === 'inv_spam') {
      await db.from('points').update({ reason: 'void', delta: 0, meta: `inv_spam|${row.delta}|разбанен` }).eq('id', row.id);
      await rankRecalc(r.inviter_id);
    }
  } catch (e) {}
}
// первая поездка приглашённого — главный бонус пригласившему
async function invFirstRide(r) {
  try {
    if (!RCFG.feat.invites || !RCFG.pts.invRide || !r.passenger_id || r.biz_id) return;
    const ptg = await tgIdOf(r.passenger_id);
    if (!ptg) return;
    const { data: iv } = await db.from('invitees').select('*').eq('tg_id', ptg).maybeSingle();
    if (!iv || iv.ride_pts || ['old', 'burst', 'spam'].includes(iv.status)) return;
    if (String(iv.inviter_id) === String(r.driver_id)) return;      // сам себе возил — не считается
    const { count } = await db.from('rides').select('*', { count: 'exact', head: true }).eq('passenger_id', r.passenger_id).eq('status', 'completed');
    if ((count || 0) > 1) { await db.from('invitees').update({ ride_pts: true }).eq('tg_id', ptg); return; }   // не первая
    await db.from('invitees').update({ ride_pts: true }).eq('tg_id', ptg);
    await invAward(iv.inviter_id, RCFG.pts.invRide, 'inv_ride', iv.name, 'invr:' + ptg);
  } catch (e) { console.error('invFirstRide', e.message); }
}
// личная ссылка водителя в группу его города (создаём один раз)
async function invLinkFor(me) {
  const { data: c } = await db.from('cities').select('*').eq('name', me.city).maybeSingle();
  if (!c || !c.group_id) return { noGroup: true };
  const { data: l } = await db.from('inv_links').select('*').eq('driver_id', String(me.id)).eq('chat_id', c.group_id).maybeSingle();
  if (l) return { link: l.link, city: c.name };
  const code = crypto.randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || String(Date.now() % 1e8);
  const r = await tg('createChatInviteLink', { chat_id: c.group_id, name: 'drv:' + code });
  if (!r || !r.ok || !r.result) return { error: 'link_failed', why: r && r.description };
  await db.from('inv_links').insert({ code, driver_id: String(me.id), chat_id: c.group_id, link: r.result.invite_link });
  return { link: r.result.invite_link, city: c.name };
}
async function invStats(driverId) {
  const rows = await ptAll(() => db.from('invitees').select('status,ride_pts').eq('inviter_id', String(driverId)).order('joined_at'), 5);
  const { data } = await db.from('points').select('delta').eq('driver_id', String(driverId)).in('reason', ['inv_join', 'inv_ride'])
    .gte('created_at', ptMonth0()).limit(1000);
  return {
    total: rows.filter(x => !['old'].includes(x.status)).length,
    stayed: rows.filter(x => x.status === 'ok').length,
    wait: rows.filter(x => x.status === 'wait').length,
    riding: rows.filter(x => x.ride_pts).length,
    month: (data || []).reduce((a, x) => a + (x.delta || 0), 0)
  };
}

// раз в 6 часов: настройки, новые водители, пауза за месяц без поездок, проверка приглашённых
async function ranksStart() {
  try {
    await rankCfgLoad();
    const { error } = await db.from('points').select('id').limit(1);
    if (error) { ranksReady = false; return false; }
    ranksReady = true;
    const drv = await ptAll(() => db.from('users').select('id').eq('driver_status', 'approved').order('id'), 10);
    for (const d of drv) {
      const { count: has } = await db.from('points').select('*', { count: 'exact', head: true })
        .eq('driver_id', String(d.id)).eq('uniq_key', 'start');
      let silent = false;
      if (!has) { await ptBackfill(d.id); silent = true; }   // первый раз — молча, без сообщений водителю
      await rankRecalc(d.id, { silent });
    }
    await invCheck();
    lbCache.clear();
    return true;
  } catch (e) { console.error('ranksStart', e.message); return ranksReady; }
}
let ranksBusy = false;
async function ranksRun() {
  if (ranksBusy) return ranksReady;
  ranksBusy = true;
  try { return await ranksStart(); } finally { ranksBusy = false; }
}
async function ranksLoop() {
  const ok = await ranksRun();
  setTimeout(ranksLoop, ok ? 6 * 3600e3 : 5 * 60e3);     // пока миграции нет — проверяем каждые 5 минут
}
setTimeout(ranksLoop, 40 * 1000);
setInterval(() => { invCheck().catch(() => {}); }, 3600e3);   // приглашённых проверяем раз в час

// доска почёта: водители города по баллам — за этот месяц или за всё время
const lbCache = new Map();
async function leaderboard(period, city) {
  const key = period + '|' + (city || '');
  const c = lbCache.get(key);
  if (c && Date.now() - c.t < 60000) return c.rows;
  const us = await ptAll(() => {
    let q = db.from('users').select('*').eq('driver_status', 'approved').or('is_banned.is.null,is_banned.eq.false');
    if (city) q = q.eq('city', city);
    return q.order('id');
  }, 5);
  const pts = {};
  if (period === 'month') {
    const rows = await ptAll(() => db.from('points').select('driver_id,delta').neq('reason', 'start').gte('created_at', ptMonth0()).order('id'), 100);
    rows.forEach(x => { pts[x.driver_id] = (pts[x.driver_id] || 0) + (x.delta || 0); });
  }
  const list = us.map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null, car: u.car || null,
    rating: u.rating, moto: u.vehicle_type === 'moto', rank: u.rank_code || null, paused: !!u.rank_paused,
    pts: period === 'month' ? (pts[String(u.id)] || 0) : (u.points_total || 0) }))
    .filter(x => x.pts > 0)
    .sort((a, b) => b.pts - a.pts || String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
  list.forEach((x, i) => { x.place = i + 1; });
  lbCache.set(key, { t: Date.now(), rows: list });
  return list;
}
// экран «Мой ранг»
async function rankInfo(me) {
  const st = await rankRecalc(me.id) || {};
  const mrows = await ptAll(() => db.from('points').select('delta').eq('driver_id', String(me.id)).neq('reason', 'start')
    .gte('created_at', ptMonth0()).order('id'), 10);
  const { data: hist } = await db.from('points').select('delta,reason,note,meta,created_at')
    .eq('driver_id', String(me.id)).order('id', { ascending: false }).limit(40);
  const board = await leaderboard('month', me.city);
  const pl = board.find(x => String(x.id) === String(me.id));
  return { ...st, month: mrows.reduce((a, x) => a + (x.delta || 0), 0), today: await ptToday(me.id),
    place: pl ? pl.place : null, of: board.length, hist: hist || [], ranks: ranksList(),
    pt: { ...RCFG.pts, ...RCFG.lim }, peak: RCFG.peak, feat: RCFG.feat,
    callBonus: callReady && CCFG.on ? CCFG.bonus : 0 };
}

/* ---------- панель «Ранги и баллы» (право ranks) ---------- */
const PT_GROUPS = {
  ride: ['ride', 'ride_auto', 'ride_short', 'ride_same', 'star', 'start', 'call'],
  cancel: ['cancel', 'cancel_wait', 'cancel_ok', 'cancel_free', 'cancel_noshow', 'cancel_early'],
  inv: ['inv_join', 'inv_ride', 'inv_spam', 'ref'],
  adm: ['adjust', 'void'],
  rank: ['rank_up', 'rank_down', 'rank_pause', 'rank_resume'],
  pen: ['cancel', 'complaint', 'inv_spam']
};
// что поменялось в правилах — коротко, для журнала действий
function rankCfgDiff(a, b) {
  const out = [];
  const lbl = { ride: 'поездка', peak: 'час пик', star: '5★', fast: 'быстрый ответ', ref: 'привёл водителя', invJoin: 'друг вступил',
    invRide: 'друг поехал', cancel: 'отказ', complaint: 'жалоба', invSpam: 'привёл спамера', dayCap: 'предел в день',
    perPassenger: 'поездок с одним пассажиром', minMinutes: 'мин. длительность', fastSec: 'быстрый ответ, сек', freeCant: 'бесплатных «не могу» в неделю',
    noshowMin: 'ждать пассажира, мин', earlyHours: 'отказ заранее, ч', pauseDays: 'пауза через, дней', unpauseRides: 'поездок до снятия паузы',
    invMonthCap: 'за друзей в месяц', invStayDays: 'друг должен пробыть, дней', invBurst: 'вступлений в час до заморозки',
    invites: 'баллы за друзей', minRides: 'минимум поездок', offerBadge: 'значок на цене', topList: 'Золото выше в списке' };
  for (const g of ['pts', 'lim', 'feat']) for (const k of Object.keys(b[g])) if (a[g][k] !== b[g][k]) out.push(`${lbl[k] || k}: ${a[g][k]} → ${b[g][k]}`);
  if (JSON.stringify(a.peak) !== JSON.stringify(b.peak)) out.push(`часы пик: ${b.peak.map(p => p.join('–')).join(', ') || 'нет'}`);
  for (const c of RANK_CODES) for (const k of ['pts', 'rides', 'rating', 'cancel', 'days']) {
    if (a.ranks[c][k] !== b.ranks[c][k]) out.push(`${RANK_NAMES[c]} ${({ pts: 'баллы', rides: 'поездки', rating: 'рейтинг', cancel: 'отказы %', days: 'стаж' })[k]}: ${a.ranks[c][k] ?? '—'} → ${b.ranks[c][k] ?? '—'}`);
  }
  return out.join('; ');
}
async function rankAdmin(me, act, body) {
  if (act === 'rank-cfg-get') return { ok: true, ready: ranksReady, cfg: RCFG, def: RANK_DEF, lim: RANK_LIM, names: RANK_NAMES };
  if (act === 'rank-cfg-set') {
    const next = rankCfgClean({ bizMin: RCFG.bizMin, ...(body.cfg || {}) });
    const diff = rankCfgDiff(RCFG, next);
    if (!diff) return { ok: true, cfg: RCFG, same: true };
    const { error } = await db.from('settings').update({ rank_cfg: next }).eq('id', 1);
    if (error) return { code: 500, ok: false, error: /rank_cfg/.test(error.message) ? 'no_column' : 'save_failed' };
    RCFG = next; lbCache.clear();
    await audit(me, 'rank-cfg', null, null, diff);
    ranksRun().catch(() => {});                          // пересчитать всех по новым правилам
    return { ok: true, cfg: RCFG, diff };
  }
  if (!ranksReady) return { ok: true, missing: true };
  if (act === 'ranks-recalc') {
    await audit(me, 'ranks-recalc', null, null, 'пересчёт всех водителей');
    ranksRun().catch(() => {});
    return { ok: true };
  }
  if (act === 'points-list') {
    const since = body.since ? new Date(body.since).toISOString() : null;
    const grp = body.group === 'pen' ? null : (PT_GROUPS[body.group] || null);   // «штрафы» — все минусы, и ручные тоже
    let ids = null;
    if (body.driver_id) ids = [String(body.driver_id)];
    else if (body.q) {
      const q = String(body.q).trim().slice(0, 40).replace(/[%,()]/g, '');
      const { data: us } = await db.from('users').select('id').ilike('name', `%${q}%`).limit(50);
      ids = (us || []).map(u => String(u.id));
      if (!ids.length) return { ok: true, rows: [], names: {}, sum: { plus: 0, minus: 0, n: 0 } };
    }
    const build = () => {
      let q = db.from('points').select('*');
      if (since) q = q.gte('created_at', since);
      if (grp) q = q.in('reason', grp);
      if (body.group === 'pen') q = q.lt('delta', 0);
      if (ids) q = q.in('driver_id', ids);
      return q;
    };
    const off = Math.max(0, Number(body.offset) || 0);
    const { data: rows } = await build().order('id', { ascending: false }).range(off, off + 59);
    // итоги по фильтру
    const all = await ptAll(() => { let q = db.from('points').select('delta'); if (since) q = q.gte('created_at', since); if (grp) q = q.in('reason', grp); if (body.group === 'pen') q = q.lt('delta', 0); if (ids) q = q.in('driver_id', ids); return q.order('id'); }, 30);
    const sum = { plus: 0, minus: 0, n: all.length };
    all.forEach(x => { if (x.delta > 0) sum.plus += x.delta; else sum.minus += x.delta; });
    const uids = [...new Set((rows || []).flatMap(x => [x.driver_id, x.peer_id, x.created_by]).filter(x => x && !String(x).startsWith('biz:')))];   // biz:… — точка, не человек
    const names = {};
    for (let i = 0; i < uids.length; i += 100) {
      const { data: us } = await db.from('users').select('id,name,telegram_id,rank_code,rank_paused').in('id', uids.slice(i, i + 100));
      (us || []).forEach(u => { names[u.id] = { name: u.name, tag: String(u.telegram_id || '').slice(-4), rank: u.rank_code, paused: u.rank_paused }; });
    }
    return { ok: true, rows: rows || [], names, sum, more: (rows || []).length === 60 };
  }
  if (act === 'points-drivers') {
    const us = await ptAll(() => {
      let q = db.from('users').select('*').eq('driver_status', 'approved');
      if (body.city && body.city !== 'all') q = q.eq('city', body.city);
      return q.order('id');
    }, 5);
    const mon = await ptAll(() => db.from('points').select('driver_id,delta').neq('reason', 'start').gte('created_at', ptMonth0()).order('id'), 100);
    const m = {}; mon.forEach(x => { m[x.driver_id] = (m[x.driver_id] || 0) + (x.delta || 0); });
    const rows = us.map(u => ({ id: u.id, name: u.name, tag: String(u.telegram_id || '').slice(-4), city: u.city, car: u.car,
      rank: u.rank_code || null, paused: !!u.rank_paused, total: u.points_total || 0, month: m[String(u.id)] || 0, banned: !!u.is_banned }))
      .sort((a, b) => b.total - a.total);
    return { ok: true, rows };
  }
  if (act === 'points-driver') {
    const id = String(body.driver_id || '');
    const { data: u } = await db.from('users').select('*').eq('id', id).maybeSingle();
    if (!u) return { code: 404, ok: false, error: 'no_user' };
    const info = await rankRecalc(id) || {};
    const { data: hist } = await db.from('points').select('*').eq('driver_id', id).order('id', { ascending: false }).limit(150);
    const mrows = await ptAll(() => db.from('points').select('delta').eq('driver_id', id).neq('reason', 'start').gte('created_at', ptMonth0()).order('id'), 10);
    const inv = await invStats(id);
    const staff = [...new Set((hist || []).map(x => x.created_by).filter(Boolean))];
    const names = {};
    if (staff.length) { const { data: s } = await db.from('users').select('id,name').in('id', staff); (s || []).forEach(x => { names[x.id] = x.name; }); }
    return { ok: true, user: { id: u.id, name: u.name, tag: String(u.telegram_id || '').slice(-4), city: u.city, car: u.car, rating: u.rating, created_at: u.created_at, driver_status: u.driver_status },
      info, hist: hist || [], month: mrows.reduce((a, x) => a + (x.delta || 0), 0), inv, names, ranks: ranksList(), feat: RCFG.feat };
  }
  if (act === 'points-adjust') {
    const id = String(body.driver_id || '');
    const delta = Math.round(Number(body.delta) || 0);
    const note = String(body.note || '').trim().slice(0, 140);
    if (!delta || Math.abs(delta) > 100000) return { code: 400, ok: false, error: 'bad_delta' };
    if (!note) return { code: 400, ok: false, error: 'need_note' };
    const { data: u } = await db.from('users').select('id,name,telegram_id').eq('id', id).maybeSingle();
    if (!u) return { code: 404, ok: false, error: 'no_user' };
    const ok = await ptAdd(id, delta, 'adjust', note, null, { created_by: String(me.id), meta: me.name || null });
    if (!ok) return { code: 500, ok: false, error: 'save_failed' };
    await audit(me, 'points-adjust', id, u.name, `${delta > 0 ? '+' : ''}${delta} баллов: ${note}`);
    const info = await rankRecalc(id);
    if (body.notify !== false && u.telegram_id) {
      send(u.telegram_id, `${delta > 0 ? '🎁' : '➖'} <b>${delta > 0 ? 'Вам начислено' : 'У вас списано'} ${Math.abs(delta)} ${plural(Math.abs(delta), ['балл', 'балла', 'баллов'])}</b>\nПричина: ${safeName(note)}`,
        { reply_markup: { inline_keyboard: [[wa('🏅 Мой ранг', 'rank', { id: u.telegram_id })]] } }).catch(() => {});
    }
    return { ok: true, info };
  }
  if (act === 'points-void') {
    const { data: row } = await db.from('points').select('*').eq('id', body.id).maybeSingle();
    if (!row) return { code: 404, ok: false, error: 'no_row' };
    if (row.reason === 'void') return { ok: true, already: true };
    if (/^rank_/.test(row.reason)) return { code: 400, ok: false, error: 'is_event' };
    await db.from('points').update({ reason: 'void', delta: 0, meta: `${row.reason}|${row.delta}|${String(me.name || '').slice(0, 40)}` }).eq('id', row.id);
    const { data: u } = await db.from('users').select('name').eq('id', row.driver_id).maybeSingle();
    await audit(me, 'points-void', row.driver_id, u && u.name, `отменена запись: ${row.reason} ${row.delta > 0 ? '+' : ''}${row.delta}${row.note ? ' · ' + row.note : ''}`);
    const info = await rankRecalc(row.driver_id);
    return { ok: true, info };
  }
  if (act === 'inv-list') {
    const { data: rows } = await db.from('invitees').select('*').order('joined_at', { ascending: false }).limit(200);
    const ids = [...new Set((rows || []).map(x => x.inviter_id))];
    const names = {};
    if (ids.length) { const { data: us } = await db.from('users').select('id,name,telegram_id').in('id', ids); (us || []).forEach(u => { names[u.id] = u.name; }); }
    return { ok: true, rows: rows || [], names };
  }
  return { code: 400, ok: false, error: 'unknown' };
}

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
    const out = { ok: true, версия: VERSION, шаги: [] };
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
    ok: true, service: 'bombily-backend', version: VERSION,
    notify_errors: Object.keys(notifyErrors).length ? notifyErrors : 'нет ошибок',
    group_log: groupLog.length ? groupLog : 'из групп сообщений не приходило'
  });

  const body = await readBody(req);

  // --- регистрация: создаём пользователя на сервере, а не с фронтенда ---
  if (req.url === '/api/me/register') {
    const tgUser = verifyInitData(body.initData);
    if (!tgUser) return json(res, 401, { error: 'bad_init' });

    const { data: exist } = await db.from('users')
      .select('*').eq('telegram_id', tgUser.id).maybeSingle();
    if (exist) return json(res, 200, { ok: true, me: exist });

    // кто пригласил — ищем по коду, если он был
    let refBy = null;
    if (body.ref_code) {
      const { data: inv } = await db.from('users')
        .select('id').eq('ref_code', String(body.ref_code).slice(0, 40)).maybeSingle();
      if (inv) refBy = inv.id;
    }

    const name = String(tgUser.first_name || '').trim().slice(0, 60)
      || ('Гость' + String(tgUser.id).slice(-3));

    const { data: created, error } = await db.from('users').insert({
      telegram_id: tgUser.id,
      name,
      tg_username: tgUser.username || null,
      ref_by: refBy,
      source: body.source ? String(body.source).slice(0, 40) : null
    }).select().single();

    if (error) return json(res, 500, { error: 'register_failed' });

    // временные метки приглашения больше не нужны
    db.from('pending_refs').delete().eq('tg_id', tgUser.id).then(() => {}, () => {});
    db.from('pending_src').delete().eq('tg', tgUser.id).then(() => {}, () => {});

    return json(res, 200, { ok: true, me: created });
  }

  const me = await userFromInit(body.initData || '');
  if (!me) return json(res, 401, { error: 'auth' });
  if (me.is_banned) return json(res, 403, { error: 'banned' });

  // защита от спама. лимит поднят: теперь через сервер идёт вся работа приложения,
  // а не только админские операции, поэтому запросов от обычного человека много больше
  const rlKey = String(me.id);
  const nowMs = Date.now();
  const bucket = rateMap.get(rlKey) || { n: 0, t: nowMs };
  if (nowMs - bucket.t > 60000) { bucket.n = 0; bucket.t = nowMs; }
  bucket.n++;
  rateMap.set(rlKey, bucket);
  if (bucket.n > 300) return json(res, 429, { error: 'too_many' });

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
    // точки: подключение, сотрудники, вызов курьера
    if (req.url === '/api/biz') {
      const r = await bizApi(me, body || {});
      const code = r.code || 200; delete r.code;
      return json(res, code, r);
    }

    if (req.url === '/api/ride-contact') {
      const { data: r } = await db.from('rides').select('*').eq('id', body.ride_id).maybeSingle();
      if (!r) return json(res, 404, { error: 'no_ride' });
      let iAmPassenger = r.passenger_id === me.id;
      const iAmDriver = r.driver_id === me.id;
      // сотрудник точки — как тот, кто вызвал курьера
      if (!iAmPassenger && !iAmDriver && r.biz_id) iAmPassenger = await bizIsStaff(me.id, r.biz_id);
      if (!iAmPassenger && !iAmDriver) return json(res, 403, { error: 'not_yours' });
      // контакты доступны только пока заказ в работе
      if (!['confirmed', 'in_progress'].includes(r.status)) return json(res, 400, { error: 'not_active' });
      const other = iAmPassenger ? r.driver_id : r.passenger_id;
      // доставка точки: курьеру — телефон точки и получатель (только ему)
      if (iAmDriver && r.biz_id) {
        const bc = await bizContact(r);
        if (bc) return json(res, 200, { ok: true, phone: (bc.biz && bc.biz.phone) || await phoneOf(other), biz: bc.biz, recipient: bc.recipient });
      }
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
        // без города и статуса непонятно, кто это: действующий водитель
        // добавил вторую машину или новичок ещё ждёт проверки
        const { data: who } = await db.from('users')
          .select('city,driver_status,telegram_id').eq('id', me.id).maybeSingle();
        const { data: ct } = await db.from('contacts')
          .select('phone').eq('user_id', me.id).maybeSingle();
        const { count: carsHave } = await db.from('cars')
          .select('id', { count: 'exact', head: true }).eq('user_id', me.id);
        const stTxt = who && who.driver_status === 'approved'
          ? `действующий водитель · машина ${carsHave || 1}-я`
          : who && who.driver_status === 'pending'
            ? 'заявка ещё на рассмотрении'
            : 'без допуска';
        await notifyStaff(
          `${kind === 'moto' ? '🏍' : '🚙'} <b>Новый транспорт на проверку</b>\n` +
          `${safeName(me.name)} <code>#${String((who && who.telegram_id) || '').slice(-4)}</code>\n` +
          `${who && who.city ? '📍 ' + safeName(who.city) + '\n' : ''}` +
          `${ct && ct.phone ? '📞 ' + safeName(ct.phone) + '\n' : ''}` +
          `${kind === 'moto' ? '🏍' : '🚗'} ${safeName(brand)} · ${safeName(plate)}\n` +
          `<i>${stTxt}</i>${kind === 'moto' ? '\n(мотоцикл — только доставка)' : ''}`,
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

    // --- заслуги водителей для списка: поездки и отзывы ---
    if (req.url === '/api/drivers-merit') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 60) : [];
      if (!ids.length) return json(res, 200, { ok: true, map: {} });
      const map = {};
      ids.forEach(id => { map[id] = { rides: 0, reviews: 0 }; });
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { data: rs } = await db.from('rides').select('driver_id')
          .in('driver_id', chunk).eq('status', 'completed').limit(5000);
        (rs || []).forEach(r => { if (map[r.driver_id]) map[r.driver_id].rides++; });
        const { data: rv } = await db.from('reviews').select('target_id')
          .in('target_id', chunk).eq('visible', true).limit(5000);
        (rv || []).forEach(r => { if (map[r.target_id]) map[r.target_id].reviews++; });
      }
      return json(res, 200, { ok: true, map });
    }

    // --- нужна ли подписка и подписан ли человек ---
    if (req.url === '/api/sub-check') {
      const { data: st } = await db.from('settings').select('require_sub').eq('id', 1).maybeSingle();
      const need = !!(st && st.require_sub);
      if (!need) return json(res, 200, { ok: true, need: false, member: true });

      const cityName = String(body.city || me.city || '').trim();
      if (!cityName) return json(res, 200, { ok: true, need: false, member: true });
      const { data: c } = await db.from('cities').select('*').eq('name', cityName).maybeSingle();
      if (!c || !c.group_id || !c.group_link) {
        return json(res, 200, { ok: true, need: false, member: true });  // группы нет — не мешаем
      }
      let member = true;
      try {
        const r = await tg('getChatMember', { chat_id: c.group_id, user_id: me.telegram_id });
        if (r && r.ok && r.result) member = !['left', 'kicked'].includes(r.result.status);
        else member = true;   // не смогли проверить — пропускаем, чтобы не запереть людей
      } catch (e) { member = true; }
      return json(res, 200, { ok: true, need: true, member, link: c.group_link, city: c.name });
    }

    // --- городское сообщество ---
    if (req.url === '/api/my-perms') {
      return json(res, 200, {
        ok: true, owner: isOwner(me), role: me.staff_role || null,
        perms: isOwner(me) ? Object.keys(PERM_GROUPS) : permsOf(me),
        groups: PERM_GROUPS
      });
    }

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
      // город, в котором водитель собирается работать — по нему потом
      // приходят заявки и строится фильтр в панели
      if (body.city) {
        const { data: ok } = await db.from('cities').select('name').eq('name', String(body.city).slice(0, 60)).maybeSingle();
        if (ok) updApply.city = ok.name;
      }
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
        await notifyStaff(`${vType === 'moto' ? '🏍' : '🚗'} <b>Новая заявка${vType === 'moto' ? ' (мотокурьер)' : ' в водители'}</b>\n${safeName(me.name)} <code>#${String(me.telegram_id || '').slice(-4)}</code>\n${updApply.city ? '📍 ' + safeName(updApply.city) + '\n' : ''}📞 ${safeName(phone)}\n${vType === 'moto' ? '🏍' : '🚗'} ${safeName(carDecl)} · ${safeName(plateDecl)}\n\nФИО и документы — в панели.`,
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
      if (ranksReady && body.kind !== 'passenger') {
        const { data: rr } = await db.from('rides').select('passenger_id,driver_id').eq('id', body.ride_id).maybeSingle();
        const fair = rr && String(rr.passenger_id) === String(me.id) && String(rr.driver_id) === String(target);
        if (fair && rating === 5) awardStar(body.ride_id, target).catch(() => {});
        else if (fair) rankRecalc(target).catch(() => {});
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

    // --- ранги: «Мой ранг» и «Доска почёта» ---
    if (req.url === '/api/rank') {
      if (!ranksReady) return json(res, 200, { ok: true, missing: true });
      if (me.driver_status !== 'approved') return json(res, 200, { ok: true, notDriver: true });
      return json(res, 200, { ok: true, ...(await rankInfo(me)) });
    }
    if (req.url === '/api/invite') {
      if (!ranksReady) return json(res, 200, { ok: true, missing: true });
      if (me.driver_status !== 'approved') return json(res, 200, { ok: true, notDriver: true });
      if (!RCFG.feat.invites) return json(res, 200, { ok: true, off: true });
      const l = await invLinkFor(me);
      const stats = await invStats(me.id);
      return json(res, 200, { ok: true, ...l, stats, cap: RCFG.lim.invMonthCap, join: RCFG.pts.invJoin, ride: RCFG.pts.invRide, stay: RCFG.lim.invStayDays });
    }
    if (req.url === '/api/leaderboard') {
      if (!ranksReady) return json(res, 200, { ok: true, missing: true });
      const period = body.period === 'all' ? 'all' : 'month';
      const city = String(body.city || me.city || '').slice(0, 40) || null;
      const all = await leaderboard(period, city);
      const mine = all.find(x => String(x.id) === String(me.id)) || null;
      return json(res, 200, { ok: true, period, city, rows: all.slice(0, 50), mine, me: me.id, total: all.length });
    }

    // --- обновление собственных данных (вместо прямой записи с фронтенда) ---
    // личность подтверждена подписью Telegram, подделать её без токена бота нельзя.
    // пишем ТОЛЬКО поля из белого списка и ТОЛЬКО в свою строку.
    if (req.url === '/api/me/update') {
      // люди вписывают телефон в имя и в «где стою», чтобы звонили мимо
      // сервиса — вырезаем. Номер показывается только тому, кто взял заказ.
      const stripPhone = s => String(s || '')
        .replace(/(?:\+?\d[\s\-()]*){10,}/g, ' ')                       // длинные последовательности цифр
        .replace(/(?:\+?7|8)?[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g, ' ')
        .replace(/@[a-zA-Z0-9_]{4,}/g, ' ')                             // и телеграм-ники
        .replace(/(?:t\.me|wa\.me|viber|whatsapp)\S*/gi, ' ')
        .replace(/\s{2,}/g, ' ').trim();

      const ALLOWED = {
        name:        v => stripPhone(String(v).trim()).slice(0, 60),
        theme:       v => ['green','orange','light','mono','blue'].includes(v) ? v : 'green',
        show_in_group: v => !!v,
        phone:       v => {
          const d = String(v || '').replace(/\D/g, '');
          return d.length === 11 ? d : null;
        },
        has_phone:   () => true,
        city:        v => v === null ? null : String(v).trim().slice(0, 60),
        spot:        v => v === null ? null : stripPhone(String(v).trim()).slice(0, 120),
        age:         v => v === null ? null : Math.max(0, Math.min(120, parseInt(v) || 0)) || null,
        status:      v => ['online', 'offline'].includes(v) ? v : 'offline',
        onboarded:   v => !!v,
        idle_warned: v => !!v,
        delivery:    v => !!v,
        intercity:   v => !!v,
        call_on:     v => !!v,
        call_night:  v => !!v,
        favs:        v => Array.isArray(v) ? v.slice(0, 100).map(String) : [],
        remind_before: v => Math.max(0, Math.min(1440, parseInt(v) || 0)),
        avatar:      v => v === null ? null : String(v).slice(0, 300),
        doc_license: v => v === null ? null : String(v).slice(0, 300),
        doc_pts:     v => v === null ? null : String(v).slice(0, 300),
        doc_car:     v => v === null ? null : String(v).slice(0, 300),
        last_active: () => new Date().toISOString(),
        cancel_as_passenger: () => null,
        cancel_as_driver:    () => null
      };

      const upd = {};
      // переключатели «звать на линию» — только когда миграция db-29 уже на месте
      if (body && ('call_on' in body || 'call_night' in body) && !callReady) await callCheck();
      Object.keys(body || {}).forEach(k => {
        if (!ALLOWED[k]) return;              // всё лишнее молча отбрасываем
        if (k === 'cancel_as_passenger' || k === 'cancel_as_driver') return;
        if ((k === 'call_on' || k === 'call_night') && !callReady) return;   // пока нет миграции db-29
        upd[k] = ALLOWED[k](body[k]);
      });

      // счётчики отмен наращиваем сами, чтобы их нельзя было выставить руками
      if (body.cancel_as_passenger === true) upd.cancel_as_passenger = (Number(me.cancel_as_passenger) || 0) + 1;
      if (body.cancel_as_driver === true)    upd.cancel_as_driver    = (Number(me.cancel_as_driver) || 0) + 1;

      if (!Object.keys(upd).length) return json(res, 200, { ok: true, me });

      const { data: fresh, error } = await db.from('users')
        .update(upd).eq('id', me.id).select().single();
      if (error) {
        // без подробностей такие сбои не поймать: у одного человека
        // не работает, у остальных всё хорошо
        console.error('me/update', me.id, me.telegram_id, JSON.stringify(upd), error.message, error.code);
        if (OWNER) send(OWNER,
          `⚠️ <b>Сбой сохранения профиля</b>\n` +
          `Человек: ${safeName(me.name)} <code>${me.telegram_id}</code>\n` +
          `Менял: ${safeName(Object.keys(upd).join(', '))}\n` +
          `Ошибка: <code>${safeName(error.code || '')} ${safeName(error.message || '')}</code>`
        ).catch(() => {});
        return json(res, 500, { error: 'update_failed', detail: error.message, code: error.code });
      }

      // встал на линию — покажем, что уже висит: обычные уведомления
      // уходят один раз, и офлайн-водитель их не видел
      if (upd.status === 'online' && me.status !== 'online') {
        sendOpenRides(fresh).catch(() => {});
        callCame(me.id).catch(() => {});
      }

      return json(res, 200, { ok: true, me: fresh });
    }

    // --- действия с заявками, откликами и сменами ---
    // фронтенд просит «сделай действие», а не «поменяй поле».
    // сервер сам проверяет, что человек участник этой заявки.
    if (req.url === '/api/action') {
      const act = String(body.action || '');
      const rideId = body.ride_id || null;
      const nowIso = new Date().toISOString();

      // достаём заявку и сразу проверяем, кто есть кто
      let ride = null;
      if (rideId) {
        const { data } = await db.from('rides').select('*').eq('id', rideId).maybeSingle();
        if (!data) return json(res, 404, { error: 'no_ride' });
        ride = data;
      }
      let iAmPassenger = ride && String(ride.passenger_id) === String(me.id);
      const iAmDriver    = ride && String(ride.driver_id)    === String(me.id);
      // сотрудники точки управляют её доставками наравне с тем, кто вызвал курьера
      if (ride && !iAmPassenger && !iAmDriver && ride.biz_id) iAmPassenger = await bizIsStaff(me.id, ride.biz_id);

      // ---------- пассажир ----------
      if (act === 'ride-create') {
        const str = (v, n) => v === null || v === undefined ? null : String(v).trim().slice(0, n) || null;
        const row = {
          passenger_id: me.id,
          passenger_name: me.name,
          from_address: str(body.from_address, 200),
          to_address:   str(body.to_address, 200),
          status: 'created',
          city: me.city,
          comment: str(body.comment, 300),
          passenger_price: body.passenger_price === null || body.passenger_price === undefined
            ? null : Math.max(0, Math.min(100000, parseInt(body.passenger_price) || 0)),
          kind: ['ride', 'delivery'].includes(body.kind) ? body.kind : 'ride',
          to_city: str(body.to_city, 40),
          scheduled_at: body.scheduled_at ? new Date(body.scheduled_at).toISOString() : null
        };
        if (body.target_driver_id) row.target_driver_id = String(body.target_driver_id);
        { const why = adSpam(row.from_address, row.to_address, row.comment, row.to_city);
          if (why) { adAlert(me, why, [row.from_address, row.to_address, row.comment].filter(Boolean).join(' | ')); return json(res, 400, { error: 'ad_text' }); } }
        { const w = await cancelCooldown(me); if (w > 0) return json(res, 400, { error: 'cooldown', minutes: w }); }
        // одна активная заявка на человека: иначе к нему едут двое (заказ на время — можно)
        if (!row.scheduled_at) {
          const { data: act } = await db.from('rides').select('*').eq('passenger_id', me.id).in('status', ['created', 'confirmed']);
          const busy = (act || []).find(x => !x.scheduled_at && !x.biz_id);
          if (busy) return json(res, 409, { error: 'has_active', ride_id: busy.id, status: busy.status });
        }
        const { data, error } = await db.from('rides').insert(row).select().single();
        if (error) return json(res, 500, { error: 'create_failed' });
        return json(res, 200, { ok: true, ride: data });
      }

      if (act === 'ride-pick-driver') {
        if (!iAmPassenger) return json(res, 403, { error: 'not_yours' });
        const price = body.price ? Math.max(0, Math.min(100000, parseInt(body.price) || 0)) : null;
        const upd = {
          driver_id: String(body.driver_id), status: 'confirmed',
          price, confirmed_at: nowIso
        };
        // для заказа «на время» сбрасываем флаги напоминаний
        if (body.reset_notify) {
          upd.driver_notified = false; upd.remind_sent = false; upd.early_sent = false;
        }
        await db.from('rides').update(upd).eq('id', ride.id);
        if (body.offer_id) {
          await db.from('offers').update({ status: body.offer_status || 'selected' }).eq('id', body.offer_id);
          // гасим кнопки согласия у остальных — иначе они висят в боте
          const { data: rest } = await db.from('offers')
            .select('id,price,driver_name,notify_msg_id,notify_chat')
            .eq('ride_id', ride.id).neq('id', body.offer_id);
          await db.from('offers').update({ status: 'declined' })
            .eq('ride_id', ride.id).neq('id', body.offer_id);
          for (const x of rest || []) {
            if (!x.notify_msg_id || !x.notify_chat) continue;
            tg('editMessageText', {
              chat_id: x.notify_chat, message_id: x.notify_msg_id,
              text: `<s>💰 ${safeName(x.driver_name) || 'Водитель'}: ${x.price} ₽</s>\n\n<i>Вы выбрали другого водителя.</i>`,
              parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
            }).catch(() => {});
          }
          // и у выбранного тоже — заказ уже подтверждён
          const { data: win } = await db.from('offers')
            .select('notify_msg_id,notify_chat,price,driver_name').eq('id', body.offer_id).maybeSingle();
          if (win && win.notify_msg_id && win.notify_chat) {
            tg('editMessageText', {
              chat_id: win.notify_chat, message_id: win.notify_msg_id,
              text: `✅ <b>${safeName(win.driver_name) || 'Водитель'} — ${win.price} ₽</b>\n<i>Вы выбрали этого водителя.</i>`,
              parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
            }).catch(() => {});
          }
        }
        return json(res, 200, { ok: true });
      }

      if (act === 'ride-cancel-passenger') {
        if (!iAmPassenger) return json(res, 403, { error: 'not_yours' });
        await db.from('rides').update({ status: 'cancelled_by_passenger_free' }).eq('id', ride.id);
        return json(res, 200, { ok: true });
      }

      if (act === 'ride-drop-driver') {
        if (!iAmPassenger) return json(res, 403, { error: 'not_yours' });
        await db.from('rides').update({
          driver_id: null, status: 'created', price: null, confirmed_at: null,
          cancelled_by: 'driver', cancel_notified: false
        }).eq('id', ride.id);
        return json(res, 200, { ok: true });
      }

      // ---------- общее ----------
      if (act === 'ride-complete') {
        if (!iAmPassenger && !iAmDriver) return json(res, 403, { error: 'not_yours' });
        const was = ride.status;
        const upd = { status: 'completed' };
        if (was !== 'completed') { upd.completed_at = nowIso; upd.auto_closed = false; }
        await db.from('rides').update(upd).eq('id', ride.id);
        if (was !== 'completed' && ride.driver_id) awardRide(ride.id).catch(() => {});
        return json(res, 200, { ok: true });
      }

      // ---------- водитель ----------
      if (act === 'offer-create') {
        if (!ride) return json(res, 400, { error: 'no_ride' });
        if (ride.biz_id && !bizRankOk(me)) return json(res, 403, { error: 'rank_low', need: RCFG.bizMin });
        const price = Math.max(0, Math.min(100000, parseInt(body.price) || 0));
        if (!price) return json(res, 400, { error: 'bad_price' });
        // уже предлагал по этой заявке — меняем цену, а не плодим одинаковые предложения
        const { data: was } = await db.from('offers').select('*').eq('ride_id', ride.id).eq('driver_id', me.id).eq('status', 'pending').order('created_at', { ascending: false });
        if (was && was.length) {
          const keep = was[0];
          if (was.length > 1) await db.from('offers').update({ status: 'declined' }).in('id', was.slice(1).map(x => x.id));
          if (Number(keep.price) === price) return json(res, 200, { ok: true, same: true });
          await db.from('offers').update({ price, notified: false, notify_msg_id: null, notify_chat: null }).eq('id', keep.id);
          if (keep.notify_msg_id && keep.notify_chat) tg('editMessageText', { chat_id: keep.notify_chat, message_id: keep.notify_msg_id,
            text: `<s>💰 ${safeName(me.name) || 'Водитель'} назвал цену: ${keep.price} ₽</s>\n\n<i>Цена изменена — смотрите сообщение ниже.</i>`,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => {});
          return json(res, 200, { ok: true, updated: true });
        }
        const { error } = await db.from('offers').insert({
          ride_id: ride.id, driver_id: me.id, driver_name: me.name,
          car: me.car, price, eta_minutes: 5
        });
        if (error) return json(res, 500, { error: 'offer_failed' });
        // отмечаем, что водитель на заявку откликнулся — по этому потом
        // считаем процент отклика и вычисляем мёртвые аккаунты
        db.from('ride_notify').update({ responded: true, responded_at: new Date().toISOString() })
          .eq('ride_id', ride.id).eq('driver_id', me.id).then(() => {}, () => {});
        return json(res, 200, { ok: true });
      }

      if (act === 'offer-decline') {
        const { data: of } = await db.from('offers').select('driver_id').eq('id', body.offer_id).maybeSingle();
        if (!of || String(of.driver_id) !== String(me.id)) return json(res, 403, { error: 'not_yours' });
        await db.from('offers').update({ status: 'declined' }).eq('id', body.offer_id);
        return json(res, 200, { ok: true });
      }

      if (act === 'ride-arrived') {
        if (!iAmDriver) return json(res, 403, { error: 'not_yours' });
        await db.from('rides').update({ arrived: true }).eq('id', ride.id);
        if (!ride.arrived_at) await db.from('rides').update({ arrived_at: nowIso }).eq('id', ride.id).then(() => {}, () => {});
        return json(res, 200, { ok: true });
      }

      // доставка точки: курьер забрал заказ
      if (act === 'ride-picked') {
        if (!iAmDriver) return json(res, 403, { error: 'not_yours' });
        const r = await bizPicked(me, ride);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }

      if (act === 'ride-cancel-driver') {
        if (!iAmDriver) return json(res, 403, { error: 'not_yours' });
        const why = ['agreed', 'cant', 'noshow', 'other'].includes(body.reason) ? body.reason : 'other';
        await db.from('rides').update({
          status: 'created', driver_id: null,
          cancelled_by: 'driver', cancel_notified: false
        }).eq('id', ride.id);
        await db.from('offers').update({ status: 'declined' })
          .eq('ride_id', ride.id).eq('driver_id', me.id);
        // причина — для статистики; «на месте» сбрасываем: следующий водитель ещё не приехал
        db.from('rides').update({ cancel_reason: why, arrived: false, arrived_at: null }).eq('id', ride.id).then(() => {}, () => {});
        const pts = await driverCancelPoints(me, ride, why);
        return json(res, 200, { ok: true, pts });
      }

      // ---------- смены ----------
      if (act === 'shift-open') {
        const { data, error } = await db.from('shifts').insert({
          driver_id: me.id, started_at: nowIso,
          planned_end: body.planned_end ? new Date(body.planned_end).toISOString() : null
        }).select().single();
        if (error) return json(res, 500, { error: 'shift_failed' });
        return json(res, 200, { ok: true, shift: data });
      }

      if (act === 'shift-close' || act === 'shift-extend') {
        const { data: sh } = await db.from('shifts').select('driver_id').eq('id', body.shift_id).maybeSingle();
        if (!sh || String(sh.driver_id) !== String(me.id)) return json(res, 403, { error: 'not_yours' });
        if (act === 'shift-extend') {
          await db.from('shifts').update({
            planned_end: new Date(body.planned_end).toISOString()
          }).eq('id', body.shift_id);
        } else {
          await db.from('shifts').update({
            ended_at: nowIso,
            minutes: Math.max(0, parseInt(body.minutes) || 0),
            auto_closed: !!body.auto_closed
          }).eq('id', body.shift_id);
        }
        return json(res, 200, { ok: true });
      }

      return json(res, 400, { error: 'unknown_action' });
    }

    // --- админские операции (только staff) ---
    if (req.url === '/api/admin') {
      if (!isStaff(me)) return json(res, 403, { error: 'forbidden' });
      const act = body.action;
      const tid = body.target_id;
      const iAmOwner = isOwner(me);

      // проверка прав по разделам: чего не выдано — того нельзя
      if (!canAct(me, act)) {
        await audit({
          actor_id: me.id, actor_name: me.name, actor_role: me.staff_role || 'staff',
          action: 'отказано: ' + act, target_name: null,
          details: 'нет права на раздел ' + (ACT_PERM[act] || 'владельца')
        });
        return json(res, 403, { error: 'no_perm', need: ACT_PERM[act] || 'owner' });
      }

      // ранги и баллы: правила, журнал баллов, ручные начисления
      // точки: проверка, данные, сотрудники
      if (/^biz-/.test(String(act || ''))) {
        const r = await bizAdmin(me, act, body);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }

      if (/^work-/.test(String(act || ''))) {
        const r = await workAdmin(me, act, body);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }
      if (/^guard-/.test(String(act || ''))) {
        const r = await guardAdmin(me, act, body);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }

      // зов на линию: правила и итоги
      if (/^call-/.test(String(act || ''))) {
        const r = await callAdmin(me, act, body);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }

      if (/^(rank-|points-|ranks-|inv-list$)/.test(String(act || ''))) {
        const r = await rankAdmin(me, act, body);
        const code = r.code || 200; delete r.code;
        return json(res, code, r);
      }

// выдать или снять права разделов (только владелец)
      if (act === 'perms-set') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        const list = Array.isArray(body.perms) ? body.perms.filter(x => PERM_GROUPS[x]) : [];
        const { data: u } = await db.from('users').select('id,name,staff_role,telegram_id').eq('id', tid).maybeSingle();
        if (!u) return json(res, 404, { error: 'no_user' });
        if (isOwner(u)) return json(res, 400, { error: 'owner_untouchable' });
        await db.from('users').update({ perms: list }).eq('id', u.id);
        await audit({
          actor_id: me.id, actor_name: me.name, actor_role: 'owner',
          action: 'изменил права', target_id: u.id, target_name: u.name,
          details: list.length ? list.map(k => PERM_GROUPS[k]).join(', ') : 'все права сняты'
        });
        return json(res, 200, { ok: true, perms: list });
      }

      // список разделов и текущие права человека
      if (act === 'perms-get') {
        if (!iAmOwner) return json(res, 403, { error: 'forbidden' });
        const { data: u } = await db.from('users').select('id,name,staff_role,perms,telegram_id').eq('id', tid).maybeSingle();
        if (!u) return json(res, 404, { error: 'no_user' });
        return json(res, 200, {
          ok: true, groups: PERM_GROUPS,
          perms: Array.isArray(u.perms) ? u.perms : [],
          owner: isOwner(u), name: u.name, role: u.staff_role
        });
      }

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
        'drivers-stats','days-stats','user-search','avatars','avatar-fetch','ride-notify-list','ride-card',
        'audit-list','audit-actors','activity','broadcast-count','broadcast-list','rides-stats','rides-list','src-list','rides-list',
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
        // заблокировали — из группы водителей вон; разблокировали — зовём обратно
        if (targetUser) {
          if (body.value) { kickFromDriverGroups(targetUser, 'ban').catch(() => {}); setDriverTag(targetUser, false).catch(() => {}); }
          else if (targetUser.driver_status === 'approved') { inviteToDriverGroups(targetUser).catch(() => {}); setDriverTag(targetUser, true).catch(() => {}); }
        }
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
          // и убираем из группы водителей
          if (targetUser) { kickFromDriverGroups(targetUser, 'revoke').catch(() => {}); setDriverTag(targetUser, false).catch(() => {}); }
        }

        await db.from('users').update(upd).eq('id', tid);

        // допуск открыли — зовём в группу водителей
        if (body.status === 'approved' && targetUser) {
          inviteToDriverGroups({ ...targetUser, ...upd }).catch(() => {}); setDriverTag({ ...targetUser, ...upd }, true).catch(() => {});
        }

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
        if ((body.ban || body.warn) && tid) await complaintPoints(tid, cid);
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
        let shops = 0;      // точки, ждущие проверки
        if (bizReady) { const { count } = await db.from('businesses').select('*', { count: 'exact', head: true }).eq('status', 'pending'); shops = count || 0; }
        return json(res, 200, { ok: true, apps: (apps || 0) + (cars || 0), complaints: cmps || 0, support: sup || 0, shops });
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
        let done = 0, errs = [];
        for (const c of cities) {
          try {
            // -1 = пересоздать немедленно, не глядя на срок
            await updatePin(c, -1);
            done++;
          } catch (e) { errs.push(c.name + ': ' + e.message); }
        }
        return json(res, 200, { ok: true, done, errs: errs.length ? errs : undefined });
      }

      // ---- активность людей ----
      if (act === 'activity') {
        // все заявки: кто создавал, чем кончилось
        // постранично: база отдаёт не больше 1000 строк за раз, а заявок больше
        let rides = [];
        try { rides = await ptAll(() => db.from('rides').select('passenger_id,driver_id,status,created_at').order('created_at'), 60); }
        catch (e) { const { data } = await db.from('rides').select('passenger_id,driver_id,status,created_at').limit(1000); rides = data || []; }
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
        // сколько всего людей и кто отсеялся — чтобы цифра не была загадкой
        const { count: total } = await db.from('users').select('*', { count: 'exact', head: true });
        const { count: noTg } = await db.from('users').select('*', { count: 'exact', head: true }).is('telegram_id', null);
        const { count: opted } = await db.from('users').select('*', { count: 'exact', head: true }).eq('no_broadcast', true);
        let inCity = null;
        if (body.city && body.city !== 'all') {
          const { count } = await db.from('users').select('*', { count: 'exact', head: true }).eq('city', body.city);
          inCity = count || 0;
        }
        return json(res, 200, { ok: true, count: list.length,
          total: total || 0, no_tg: noTg || 0, opted_out: opted || 0, in_city: inCity });
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

      // ---- метки источников ----
      if (act === 'src-list') {
        const { data: srcs } = await db.from('sources').select('*').order('created_at', { ascending: false });
        const { data: us } = await db.from('users').select('id,source,created_at').not('source', 'is', null).limit(5000);
        const { data: rides } = await db.from('rides').select('passenger_id,status').limit(20000);
        const made = {}, done = {};
        (rides || []).forEach(r => {
          if (!r.passenger_id) return;
          made[r.passenger_id] = true;
          if (r.status === 'completed') done[r.passenger_id] = true;
        });
        const agg = {};
        (us || []).forEach(u => {
          const k = u.source;
          agg[k] = agg[k] || { code: k, users: 0, ordered: 0, arrived: 0 };
          agg[k].users++;
          if (made[u.id]) agg[k].ordered++;
          if (done[u.id]) agg[k].arrived++;
        });
        const items = (srcs || []).map(s => ({ ...s, ...(agg[s.code] || { users: 0, ordered: 0, arrived: 0 }) }));
        // метки без описания, если кто-то пришёл по неизвестной ссылке
        Object.values(agg).forEach(a2 => {
          if (!items.find(i => i.code === a2.code)) items.push({ code: a2.code, title: null, ...a2 });
        });
        items.sort((a2, b2) => b2.users - a2.users);
        return json(res, 200, { ok: true, items });
      }
      if (act === 'src-save' && isAdminUp(me)) {
        const code = String(body.code || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
        if (!code) return json(res, 400, { error: 'bad_code' });
        await db.from('sources').upsert({ code, title: String(body.title || '').slice(0, 80), note: String(body.note || '').slice(0, 200) });
        return json(res, 200, { ok: true, code });
      }
      if (act === 'src-delete' && isAdminUp(me)) {
        await db.from('sources').delete().eq('code', body.code);
        return json(res, 200, { ok: true });
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
          driver_group_id: body.driver_group_id ? -Math.abs(Number(body.driver_group_id)) : null,
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
        const keepD = await docsKeepDays();
        const upd2 = {
          approved: true,
          docs_checked_at: new Date().toISOString(),
          docs_checked_by: me.name,
          docs_wipe_at: new Date(Date.now() + keepD * 86400000).toISOString()
        };
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
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus','idle_hours','community_enabled','group_moderate','group_clean_service','group_welcome','pin_enabled','pin_minutes','require_sub','pin_renew_hours','group_del_sec','group_welcome_sec','docs_keep_days','dpost_minutes','driver_feed_enabled'].forEach(k => {
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
      // вся история одной заявки: кто взял, кто предлагал цену, была ли переписка
      if (act === 'ride-card') {
        const rid = body.ride_id;
        if (!rid) return json(res, 400, { error: 'no_ride' });

        const { data: ride } = await db.from('rides').select('*').eq('id', rid).maybeSingle();
        if (!ride) return json(res, 404, { error: 'not_found' });

        const ids = [ride.passenger_id, ride.driver_id].filter(Boolean);
        const { data: offs } = await db.from('offers')
          .select('id,driver_id,driver_name,car,price,status,created_at')
          .eq('ride_id', rid).order('created_at', { ascending: true });
        (offs || []).forEach(o => { if (o.driver_id) ids.push(o.driver_id); });

        const { data: asks } = await db.from('ride_ask')
          .select('from_id,to_id,from_role,text,created_at')
          .eq('ride_id', rid).order('created_at', { ascending: true });
        (asks || []).forEach(a => { if (a.from_id) ids.push(a.from_id); });

        const { data: notif } = await db.from('ride_notify')
          .select('driver_id,delivered,responded').eq('ride_id', rid);

        // оценки за эту поездку: пассажир водителю и наоборот
        const { data: revs } = await db.from('reviews')
          .select('id,from_id,target_id,rating,comment,visible,created_at')
          .eq('ride_id', rid).order('created_at', { ascending: true });
        (revs || []).forEach(v => { if (v.from_id) ids.push(v.from_id); if (v.target_id) ids.push(v.target_id); });

        const uniq = [...new Set(ids.filter(Boolean).map(String))];
        const who = {};
        if (uniq.length) {
          const { data: us } = await db.from('users')
            .select('id,name,car,telegram_id,vehicle_type,rating').in('id', uniq);
          (us || []).forEach(u => {
            who[u.id] = { name: u.name, car: u.car, rating: u.rating,
              moto: u.vehicle_type === 'moto', tag: String(u.telegram_id || '').slice(-4) };
          });
        }

        return json(res, 200, {
          ok: true, ride,
          driver: ride.driver_id ? (who[ride.driver_id] || null) : null,
          passenger: ride.passenger_id ? (who[ride.passenger_id] || null) : null,
          offers: (offs || []).map(o => ({ ...o, who: who[o.driver_id] || null })),
          chat: (asks || []).map(a => ({ ...a, who: who[a.from_id] || null })),
          reviews: (revs || []).map(v => ({ ...v, who: who[v.from_id] || null, about: who[v.target_id] || null })),
          notify: { sent: (notif || []).length,
                    got: (notif || []).filter(x => x.delivered).length,
                    answered: (notif || []).filter(x => x.responded).length }
        });
      }

      // кому уходила заявка и кто на неё откликнулся
      if (act === 'ride-notify-list') {
        const rid = body.ride_id;
        if (!rid) return json(res, 400, { error: 'no_ride' });
        const { data: rows } = await db.from('ride_notify')
          .select('driver_id,sent_at,delivered,responded,responded_at')
          .eq('ride_id', rid).order('sent_at', { ascending: true });
        const ids = [...new Set((rows || []).map(x => x.driver_id))];
        let who = {};
        if (ids.length) {
          const { data: us } = await db.from('users')
            .select('id,name,car,telegram_id,status,vehicle_type').in('id', ids);
          (us || []).forEach(u => {
            who[u.id] = {
              name: u.name, car: u.car, online: u.status === 'online',
              moto: u.vehicle_type === 'moto', tag: String(u.telegram_id || '').slice(-4)
            };
          });
        }
        const items = (rows || []).map(x => ({
          ...x, ...(who[x.driver_id] || { name: 'водитель удалён', car: '', tag: '????' })
        }));
        return json(res, 200, {
          ok: true, items,
          sent: items.length,
          got: items.filter(x => x.delivered).length,
          answered: items.filter(x => x.responded).length
        });
      }

      if (act === 'drivers-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to = body.to ? new Date(body.to + 'T23:59:59').toISOString() : new Date().toISOString();
        const { data: rows } = await db.from('rides').select('driver_id,status,price,created_at,kind,to_city')
          .not('driver_id', 'is', null).gte('created_at', from).lte('created_at', to).limit(5000);
        let dq = db.from('users').select('id,name,car,city,telegram_id,status,driver_status,vehicle_type')
          .eq('driver_status', 'approved');
        if (body.vehicle === 'moto') dq = dq.eq('vehicle_type', 'moto');
        if (body.vehicle === 'car') dq = dq.or('vehicle_type.is.null,vehicle_type.eq.car');
        if (body.city && body.city !== 'all') dq = dq.eq('city', body.city);
        const { data: drv } = await dq;
        const agg = {};
        (drv || []).forEach(d => { agg[d.id] = { id: d.id, name: d.name, car: d.car, city: d.city, moto: d.vehicle_type === 'moto', tag: String(d.telegram_id || '').slice(-4), online: d.status === 'online', taken: 0, done: 0, cancelled: 0, money: 0, delivery: 0, intercity: 0 }; });
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

        // когда водитель последний раз брал заказ (шире периода — чтобы
        // понимать, молчит он неделю или вообще с весны)
        const { data: lastRows } = await db.from('rides')
          .select('driver_id,created_at').not('driver_id', 'is', null)
          .order('created_at', { ascending: false }).limit(4000);
        const lastBy = {};
        (lastRows || []).forEach(r => { if (!lastBy[r.driver_id]) lastBy[r.driver_id] = r.created_at; });
        list.forEach(d => { d.last = lastBy[d.id] || null; });

        // сколько уведомлений получил и на сколько ответил — так видно
        // мёртвые аккаунты: числится online, заявки приходят, откликов нет
        const { data: nt } = await db.from('ride_notify')
          .select('driver_id,responded,delivered').gte('sent_at', from).lte('sent_at', to).limit(20000);
        const ntBy = {};
        (nt || []).forEach(x => {
          const a3 = ntBy[x.driver_id] || (ntBy[x.driver_id] = { got: 0, ans: 0 });
          if (x.delivered) a3.got++;
          if (x.responded) a3.ans++;
        });
        list.forEach(d => {
          const a3 = ntBy[d.id] || { got: 0, ans: 0 };
          d.got = a3.got; d.ans = a3.ans;
          d.react = a3.got ? Math.round(a3.ans / a3.got * 100) : null;
        });

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

      // список заявок поимённо: кто заказал, кто взял, чем кончилось
      if (act === 'rides-list') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to   = body.to   ? new Date(body.to   + 'T23:59:59').toISOString() : new Date().toISOString();
        let q = db.from('rides').select('*').gte('created_at', from).lte('created_at', to)
          .order('created_at', { ascending: false }).limit(300);
        if (body.city && body.city !== 'all') q = q.eq('city', body.city);
        if (body.only === 'lost') q = q.or('status.eq.created,status.like.cancelled%');
        if (body.only === 'done') q = q.eq('status', 'completed');
        const { data: rides } = await q;
        const list = rides || [];

        const ids = [...new Set(list.flatMap(r => [r.passenger_id, r.driver_id]).filter(Boolean))];
        const who = {};
        if (ids.length) {
          const { data: us } = await db.from('users').select('id,name,telegram_id,car,plate').in('id', ids);
          (us || []).forEach(u => { who[u.id] = u; });
        }

        const rideIds = list.map(r => r.id);
        const offersBy = {};
        for (let i = 0; i < rideIds.length; i += 200) {
          const { data: offs } = await db.from('offers').select('ride_id').in('ride_id', rideIds.slice(i, i + 200));
          (offs || []).forEach(o => { offersBy[o.ride_id] = (offersBy[o.ride_id] || 0) + 1; });
        }

        const items = list.map(r => ({
          id: r.id, status: r.status, price: r.price, city: r.city, kind: r.kind,
          to_city: r.to_city, created_at: r.created_at, confirmed_at: r.confirmed_at,
          from_address: r.from_address, to_address: r.to_address,
          passenger_price: r.passenger_price, offers: offersBy[r.id] || 0,
          passenger: who[r.passenger_id] || null,
          driver: who[r.driver_id] || null
        }));
        return json(res, 200, { ok: true, items });
      }

      // судьба заявок: что стало с каждой
      // кто вступал в группы и приходил в бота
      if (act === 'tg-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 6 * 864e5).toISOString();
        const to   = body.to   ? new Date(body.to   + 'T23:59:59').toISOString() : new Date().toISOString();
        const { data: ev, error: evErr } = await db.from('tg_events').select('*').gte('created_at', from).lte('created_at', to)
          .order('created_at', { ascending: false }).limit(20000);
        if (evErr) return json(res, 200, { ok: true, missing: true });
        const city = body.city && body.city !== 'all' ? body.city : null;
        const list = (ev || []).filter(e => e.kind === 'start' || !city || e.city === city);
        const groups = {}, byDay = {}, newIds = new Set();
        let starts = 0, startsNew = 0;
        for (const e of list) {
          const day = new Date(new Date(e.created_at).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
          byDay[day] = byDay[day] || { join: 0, leave: 0, start: 0 };
          if (e.kind === 'join' || e.kind === 'leave') {
            const k = (e.city || '—') + '|' + (e.chat_type || 'city');
            groups[k] = groups[k] || { city: e.city || '—', type: e.chat_type || 'city', join: 0, leave: 0 };
            groups[k][e.kind]++; byDay[day][e.kind]++;
          } else if (e.kind === 'start') {
            starts++; byDay[day].start++;
            if (e.is_new) { startsNew++; if (e.tg_id) newIds.add(e.tg_id); }
          }
        }
        // кто из новых потом открыл приложение и сделал заявку
        let opened = 0, ordered = 0;
        const ids = [...newIds];
        for (let i = 0; i < ids.length; i += 200) {
          const { data: us } = await db.from('users').select('id').in('telegram_id', ids.slice(i, i + 200));
          const uids = (us || []).map(u => u.id);
          opened += uids.length;
          if (uids.length) {
            const { data: rr } = await db.from('rides').select('passenger_id').in('passenger_id', uids).limit(5000);
            ordered += new Set((rr || []).map(r => r.passenger_id)).size;
          }
        }
        const { data: first } = await db.from('tg_events').select('created_at').order('created_at', { ascending: true }).limit(1);
        const recent = list.slice(0, 40).map(e => ({ kind: e.kind, name: e.name, username: e.username, city: e.city, type: e.chat_type,
          source: e.source, is_new: e.is_new, created_at: e.created_at, tag: String(e.tg_id || '').slice(-4) }));
        return json(res, 200, { ok: true, groups: Object.values(groups), byDay, starts, startsNew, opened, ordered, recent,
          since: first && first[0] ? first[0].created_at : null });
      }

      if (act === 'rides-stats') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to   = body.to   ? new Date(body.to   + 'T23:59:59').toISOString() : new Date().toISOString();

        let q = db.from('rides').select('id,status,price,city,kind,to_city,created_at,confirmed_at,driver_id,passenger_id,passenger_price,auto_closed')
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
          autoClosed: 0,       // из них закрыл бот по времени, а не человек
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
            if (r.auto_closed) res2.autoClosed++;
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

      // список заявок с именами — кто заказал, кто повёз
      if (act === 'rides-list') {
        const from = body.from ? new Date(body.from + 'T00:00:00').toISOString() : new Date(Date.now() - 29 * 864e5).toISOString();
        const to   = body.to   ? new Date(body.to   + 'T23:59:59').toISOString() : new Date().toISOString();
        let q = db.from('rides').select('*').gte('created_at', from).lte('created_at', to)
          .order('created_at', { ascending: false }).limit(300);
        if (body.city && body.city !== 'all') q = q.eq('city', body.city);
        const { data: rides } = await q;
        let list = rides || [];

        // предложения по каждой заявке
        const ids = list.map(r => r.id);
        const offersBy = {};
        for (let i = 0; i < ids.length; i += 200) {
          const { data: offs } = await db.from('offers').select('ride_id').in('ride_id', ids.slice(i, i + 200));
          (offs || []).forEach(o => { offersBy[o.ride_id] = (offersBy[o.ride_id] || 0) + 1; });
        }

        // имена участников
        const uids = [...new Set(list.flatMap(r => [r.passenger_id, r.driver_id]).filter(Boolean))];
        const names = {};
        if (uids.length) {
          const { data: us } = await db.from('users').select('id,name,telegram_id,car').in('id', uids);
          (us || []).forEach(u => { names[u.id] = u; });
        }

        // определяем исход так же, как в сводке
        const now = Date.now(), HANG = 30 * 60 * 1000;
        const out = list.map(r => {
          const st = String(r.status || '');
          const offs = offersBy[r.id] || 0;
          let fate = 'other';
          if (st === 'completed') fate = 'done';
          else if (st === 'confirmed' || st === 'in_progress') fate = 'going';
          else if (st === 'created') {
            if (now - new Date(r.created_at).getTime() < HANG) fate = 'waiting';
            else fate = offs === 0 ? 'no_offers' : 'not_picked';
          } else if (st.includes('cancelled')) {
            fate = st.includes('driver') ? 'cancel_driver' : 'cancel_passenger';
          }
          const p = names[r.passenger_id], d = names[r.driver_id];
          return {
            id: r.id, fate, offers: offs, price: r.price, passenger_price: r.passenger_price,
            from_address: r.from_address, to_address: r.to_address, to_city: r.to_city,
            kind: r.kind, city: r.city, created_at: r.created_at, confirmed_at: r.confirmed_at,
            passenger: p ? { id: p.id, name: p.name, tag: String(p.telegram_id || '').slice(-4) } : null,
            driver: d ? { id: d.id, name: d.name, car: d.car, tag: String(d.telegram_id || '').slice(-4) } : null
          };
        });
        const filtered = body.fate && body.fate !== 'all' ? out.filter(r => r.fate === body.fate) : out;
        return json(res, 200, { ok: true, items: filtered.slice(0, 100), shown: filtered.length });
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
               cancToday, cancYest, cancWeek, cancMonth,
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
          cnt('rides', q => q.like('status', 'cancelled%').gte('created_at', yest).lt('created_at', today)),
          cnt('rides', q => q.like('status', 'cancelled%').gte('created_at', week)),
          cnt('rides', q => q.like('status', 'cancelled%').gte('created_at', month)),
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
          cancelled: { today: cancToday, yest: cancYest, week: cancWeek, month: cancMonth },
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
        ['paid_mode','price_1','price_3','price_7','price_30','ref_enabled','ref_bonus','idle_hours','community_enabled','group_moderate','group_clean_service','group_welcome','pin_enabled','pin_minutes','require_sub','pin_renew_hours','group_del_sec','group_welcome_sec','docs_keep_days','dpost_minutes','driver_feed_enabled','winback_users_on','winback_first_days','winback_next_days','antispam_on','antispam_ban','captcha_on','captcha_minutes','group_order_mode','group_no_ads','group_orders_on','report_daily_on','report_weekly_on'].forEach(k => { if (f[k] !== undefined) allowed[k] = f[k]; });
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
schedLoop();
