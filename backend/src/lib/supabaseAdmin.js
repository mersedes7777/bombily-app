import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// service_role key — обходит RLS, использовать ТОЛЬКО на backend, никогда во фронте
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
