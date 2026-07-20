import express from "express";
import jwt from "jsonwebtoken";
import { verifyInitData } from "../lib/telegramAuth.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";

const router = express.Router();

// POST /auth/verify  { initData }
// Проверяет подпись Telegram, создаёт/находит пользователя, выдаёт сессионный JWT
router.post("/verify", async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ error: "initData required" });

  const { valid, user } = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!valid || !user) return res.status(401).json({ error: "invalid initData" });

  // найти или создать пользователя
  let { data: existing } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("telegram_id", user.id)
    .maybeSingle();

  if (!existing) {
    const { data: created, error } = await supabaseAdmin
      .from("users")
      .insert({
        telegram_id: user.id,
        name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Пользователь",
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    existing = created;
  }

  const token = jwt.sign({ userId: existing.id, telegramId: existing.telegram_id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });

  res.json({ token, user: existing });
});

export default router;
