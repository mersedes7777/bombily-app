import express from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { requireAuth } from "./middleware.js";

const router = express.Router();

// GET /users/me — текущий профиль
router.get("/me", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from("users").select("*").eq("id", req.userId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /users/status  { status: 'online' | 'offline' }
// Также используется как heartbeat — вызывать при каждом открытии мини-аппа водителем
router.post("/status", requireAuth, async (req, res) => {
  const { status } = req.body;
  const { error } = await supabaseAdmin
    .from("users")
    .update({ status, last_active: new Date().toISOString() })
    .eq("id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /users/heartbeat — просто обновляет last_active, вызывать периодически пока апп открыт
router.post("/heartbeat", requireAuth, async (req, res) => {
  await supabaseAdmin.from("users").update({ last_active: new Date().toISOString() }).eq("id", req.userId);
  res.json({ ok: true });
});

// PATCH /users/me  { phone?, role? }
router.patch("/me", requireAuth, async (req, res) => {
  const { phone, role } = req.body;
  const patch = {};
  if (phone !== undefined) patch.phone = phone;
  if (role !== undefined) patch.role = role;
  const { data, error } = await supabaseAdmin.from("users").update(patch).eq("id", req.userId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
