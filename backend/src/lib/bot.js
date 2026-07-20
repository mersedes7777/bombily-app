import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;

/**
 * Отправляет push-уведомление пользователю через обычное сообщение бота.
 * Работает даже если Mini App закрыт или Telegram не запущен — это
 * стандартный системный push, а не realtime внутри веб-вью.
 *
 * @param {number} telegramId
 * @param {string} text
 * @param {string} [deepLinkParam] - например "ride_123", попадёт в start_param
 */
export async function sendTelegramNotification(telegramId, text, deepLinkParam) {
  const body = {
    chat_id: telegramId,
    text,
  };

  if (deepLinkParam) {
    body.reply_markup = {
      inline_keyboard: [[
        { text: "Открыть", url: `${MINI_APP_URL}?startapp=${deepLinkParam}` }
      ]]
    };
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram sendMessage failed:", err);
  }
}
