import express from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { sendTelegramNotification } from "../lib/bot.js";

const router = express.Router();

/**
 * Приёмник Supabase Database Webhooks.
 * Настроить в Supabase: Database → Webhooks → INSERT на таблице messages
 * URL: https://ваш-backend.up.railway.app/notify/message
 */
router.post("/message", async (req, res) => {
  const msg = req.body.record;
  if (!msg) return res.sendStatus(200);

  const { data: ride } = await supabaseAdmin
    .from("rides")
    .select("passenger_id, driver_id")
    .eq("id", msg.ride_id)
    .single();
  if (!ride) return res.sendStatus(200);

  const recipientId = msg.sender_id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
  if (!recipientId) return res.sendStatus(200);

  const { data: recipient } = await supabaseAdmin.from("users").select("telegram_id").eq("id", recipientId).single();
  const { data: sender } = await supabaseAdmin.from("users").select("name").eq("id", msg.sender_id).single();

  if (recipient) {
    sendTelegramNotification(recipient.telegram_id, `Новое сообщение от ${sender?.name || "пользователя"}`, `ride_${msg.ride_id}`);
  }

  res.sendStatus(200);
});

export default router;
