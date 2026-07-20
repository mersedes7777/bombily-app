import express from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { requireAuth } from "./middleware.js";
import { sendTelegramNotification } from "../lib/bot.js";

const router = express.Router();

/**
 * POST /rides — пассажир создаёт заявку
 * body: { from_address, to_address, comment }
 */
router.post("/", requireAuth, async (req, res) => {
  const { from_address, to_address, comment } = req.body;
  if (!from_address || !to_address) return res.status(400).json({ error: "from/to required" });

  const { data: ride, error } = await supabaseAdmin
    .from("rides")
    .insert({ passenger_id: req.userId, from_address, to_address, comment })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // уведомить всех водителей online (упрощённо — в проде разумно ограничить по гео/району)
  const { data: onlineDrivers } = await supabaseAdmin
    .from("users")
    .select("telegram_id")
    .eq("status", "online")
    .in("role", ["driver", "both"]);

  for (const d of onlineDrivers || []) {
    sendTelegramNotification(d.telegram_id, `Новая заявка: ${from_address} → ${to_address}`, `ride_${ride.id}`);
  }

  res.json(ride);
});

/**
 * GET /rides/feed — открытые заявки (лента для водителей)
 */
router.get("/feed", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("rides")
    .select("*")
    .eq("status", "created")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /rides/:id/offers — водитель откликается с ценой
 * body: { price, eta_minutes }
 */
router.post("/:id/offers", requireAuth, async (req, res) => {
  const { price, eta_minutes } = req.body;
  const { data: offer, error } = await supabaseAdmin
    .from("offers")
    .insert({ ride_id: req.params.id, driver_id: req.userId, price, eta_minutes })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const { data: ride } = await supabaseAdmin.from("rides").select("passenger_id").eq("id", req.params.id).single();
  const { data: passenger } = await supabaseAdmin.from("users").select("telegram_id").eq("id", ride.passenger_id).single();
  sendTelegramNotification(passenger.telegram_id, `Новое предложение: ${price} ₽, ${eta_minutes} мин`, `ride_${req.params.id}`);

  res.json(offer);
});

/**
 * POST /rides/:id/select — пассажир выбирает предложение
 * body: { offer_id }
 */
router.post("/:id/select", requireAuth, async (req, res) => {
  const { offer_id } = req.body;
  const rideId = req.params.id;

  const { data: offer } = await supabaseAdmin.from("offers").select("*").eq("id", offer_id).single();
  if (!offer) return res.status(404).json({ error: "offer not found" });

  await supabaseAdmin
    .from("rides")
    .update({
      driver_id: offer.driver_id,
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      hold_amount: 30, // этап 2; для чистого MVP можно не использовать
      hold_status: "held",
    })
    .eq("id", rideId);

  await supabaseAdmin.from("offers").update({ status: "selected" }).eq("id", offer_id);
  await supabaseAdmin.from("offers").update({ status: "declined" }).eq("ride_id", rideId).neq("id", offer_id);

  const { data: driver } = await supabaseAdmin.from("users").select("telegram_id").eq("id", offer.driver_id).single();
  sendTelegramNotification(driver.telegram_id, "Вас выбрали! Откройте заказ для деталей.", `ride_${rideId}`);

  res.json({ ok: true });
});

/**
 * POST /rides/:id/depart — водитель отмечает "выехал"
 */
router.post("/:id/depart", requireAuth, async (req, res) => {
  await supabaseAdmin
    .from("rides")
    .update({ status: "in_progress", driver_departed_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: true });
});

/**
 * POST /rides/:id/complete — двойное подтверждение завершения
 * body: { role: 'passenger' | 'driver', rating? }
 */
router.post("/:id/complete", requireAuth, async (req, res) => {
  const { role, rating } = req.body;
  const rideId = req.params.id;

  const field = role === "passenger" ? { passenger_confirmed: true } : { driver_confirmed: true };
  if (role === "passenger" && rating) field.passenger_rating = rating;

  const { data: ride } = await supabaseAdmin.from("rides").update(field).eq("id", rideId).select().single();

  if (ride.passenger_confirmed && ride.driver_confirmed) {
    await supabaseAdmin
      .from("rides")
      .update({ status: "completed", completed_at: new Date().toISOString(), hold_status: "released_to_platform" })
      .eq("id", rideId);

    // обновить статистику водителя
    const { data: full } = await supabaseAdmin.from("rides").select("driver_id, passenger_rating").eq("id", rideId).single();
    const { data: driver } = await supabaseAdmin.from("users").select("completed_rides, rating").eq("id", full.driver_id).single();
    const newRating = full.passenger_rating
      ? (driver.rating * driver.completed_rides + full.passenger_rating) / (driver.completed_rides + 1)
      : driver.rating;
    await supabaseAdmin
      .from("users")
      .update({ completed_rides: driver.completed_rides + 1, rating: newRating })
      .eq("id", full.driver_id);
  }

  res.json({ ok: true });
});

/**
 * POST /rides/:id/cancel — отмена пассажиром
 * Бесплатно в первые 2 минуты после confirmed_at, иначе холд не возвращается
 */
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const { data: ride } = await supabaseAdmin.from("rides").select("*").eq("id", req.params.id).single();
  if (!ride) return res.status(404).json({ error: "not found" });

  const minutesSinceConfirm = ride.confirmed_at
    ? (Date.now() - new Date(ride.confirmed_at).getTime()) / 60000
    : 0;

  const freeWindow = ride.status === "confirmed" && minutesSinceConfirm <= 2;

  const status = freeWindow ? "cancelled_by_passenger_free" : "cancelled_by_passenger_charged";

  await supabaseAdmin
    .from("rides")
    .update({ status, hold_status: freeWindow ? "none" : "released_to_driver" })
    .eq("id", req.params.id);

  if (!freeWindow) {
    await supabaseAdmin
      .from("users")
      .update({ cancel_count: (ride.cancel_count || 0) + 1 })
      .eq("id", ride.passenger_id);
  }

  if (ride.driver_id) {
    const { data: driver } = await supabaseAdmin.from("users").select("telegram_id").eq("id", ride.driver_id).single();
    sendTelegramNotification(driver.telegram_id, "Пассажир отменил заказ", `ride_${req.params.id}`);
  }

  res.json({ ok: true, status });
});

export default router;
