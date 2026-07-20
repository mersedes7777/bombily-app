import crypto from "crypto";

/**
 * Проверка подлинности initData, присланного Telegram Mini App.
 * Алгоритм строго по документации Telegram:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false };

  params.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const valid = computedHash === hash;
  if (!valid) return { valid: false };

  const userRaw = params.get("user");
  const user = userRaw ? JSON.parse(userRaw) : null;

  return { valid: true, user };
}
