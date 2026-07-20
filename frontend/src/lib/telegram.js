// Обёртка над Telegram Web App SDK
export function getTelegram() {
  return window.Telegram?.WebApp || null;
}

export function initTelegram() {
  const tg = getTelegram();
  if (!tg) return null;
  tg.ready();
  tg.expand();
  return tg;
}

export function getInitData() {
  return getTelegram()?.initData || "";
}

export function getStartParam() {
  return getTelegram()?.initDataUnsafe?.start_param || null;
}
