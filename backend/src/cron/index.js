import cron from "node-cron";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { sendTelegramNotification } from "../lib/bot.js";

/**
 * Запускать раз в 1-2 минуты. Три задачи протухания из ТЗ раздел 6.
 */
export function startCronJobs() {
  cron.schedule("*/2 * * * *", expireOldRides);
  cron.schedule("*/2 * * * *", autoCancelNoContact);
  cron.schedule("*/2 * * * *", offlineInactiveDrivers);
  console.log("Cron jobs started");
}

// Заявка без выбранного водителя, старше 15 минут → expired
async function expireOldRides() {
  const { data: expired } = await supabaseAdmin
    .from("rides")
    .update({ status: "expired" })
    .eq("status", "created")
    .lt("expires_at", new Date().toISOString())
    .select("id, passenger_id");

  for (const ride of expired || []) {
    const { data: passenger } = await supabaseAdmin.from("users").select("telegram_id").eq("id", ride.passenger_id).single();
    if (passenger) sendTelegramNotification(passenger.telegram_id, "Никто не откликнулся, заявка закрыта", `ride_${ride.id}`);
  }
}

// Подтверждённый заказ: водитель выехал >7 минут назад, а статус так и не in_progress→completed → авто-отмена
async function autoCancelNoContact() {
  const cutoff = new Date(Date.now() - 7 * 60 * 1000).toISOString();

  const { data: stuckRides } = await supabaseAdmin
    .from("rides")
    .select("id, driver_id")
    .eq("status", "in_progress")
    .lt("driver_departed_at", cutoff)
    .eq("passenger_confirmed", false);

  for (const ride of stuckRides || []) {
    await supabaseAdmin
      .from("rides")
      .update({ status: "auto_cancelled_no_contact", hold_status: "released_to_driver" })
      .eq("id", ride.id);

    const { data: driver } = await supabaseAdmin.from("users").select("telegram_id").eq("id", ride.driver_id).single();
    if (driver) sendTelegramNotification(driver.telegram_id, "Заказ отменён — пассажир не вышел на связь, холд возвращён", `ride_${ride.id}`);
  }
}

// Водитель online, но неактивен >30 минут → offline
async function offlineInactiveDrivers() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from("users")
    .update({ status: "offline" })
    .eq("status", "online")
    .lt("last_active", cutoff);
}
