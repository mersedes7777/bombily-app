import { createClient } from "@supabase/supabase-js";

// anon key — безопасен во фронте, доступ ограничен политиками RLS (см. supabase/schema.sql)
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
