import express from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { requireAuth } from "./middleware.js";

const router = express.Router();

const REASONS = ["price_after_agreement", "no_show", "rudeness", "payment_outside_app"];

// POST /reports  { ride_id, target_id, reason }
router.post("/", requireAuth, async (req, res) => {
  const { ride_id, target_id, reason } = req.body;
  if (!REASONS.includes(reason)) return res.status(400).json({ error: "invalid reason" });

  const { data, error } = await supabaseAdmin
    .from("reports")
    .insert({ ride_id, reporter_id: req.userId, target_id, reason })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // если на target_id накопилось 3+ жалобы с разных заявителей за 30 дней — пометить warnings_count
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: recentReports } = await supabaseAdmin
    .from("reports")
    .select("reporter_id")
    .eq("target_id", target_id)
    .gte("created_at", since);

  const distinctReporters = new Set((recentReports || []).map((r) => r.reporter_id));
  if (distinctReporters.size >= 3) {
    const { data: user } = await supabaseAdmin.from("users").select("warnings_count").eq("id", target_id).single();
    await supabaseAdmin
      .from("users")
      .update({ warnings_count: (user?.warnings_count || 0) + 1 })
      .eq("id", target_id);
    // TODO: при warnings_count >= 3 — is_banned = true, плюс уведомление модератору
  }

  res.json(data);
});

export default router;
