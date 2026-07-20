import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function Feed() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    // начальная загрузка агрегированной ленты (feed_live) + подписка в реальном времени
    supabase
      .from("feed_live")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30)
      .then(({ data }) => setEntries(data || []));

    const channel = supabase
      .channel("feed_live_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "feed_live" }, (payload) => {
        setEntries((prev) => [payload.new, ...prev].slice(0, 30));
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  const filtered = entries.filter((e) => filter === "all" || e.kind === filter);

  return (
    <div className="tabview">
      <div className="chips">
        {[
          ["all", "Все"],
          ["free", "Свободен"],
          ["need", "Нужна машина"],
        ].map(([id, label]) => (
          <div key={id} className={`chip ${filter === id ? "active" : ""}`} onClick={() => setFilter(id)}>
            {label}
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="empty-state">
          <b>Пока тихо</b>
          Как только появятся заявки — они покажутся здесь мгновенно.
        </div>
      )}

      {filtered.map((e) => (
        <div className="row" key={e.id}>
          <div className={`stripe ${e.kind}`}></div>
          <div>
            <div style={{ fontSize: 12.5, color: e.kind === "free" ? "var(--green)" : "var(--amber)", fontWeight: 600 }}>
              {e.kind === "free" ? "Свободен" : "Нужна машина"}
            </div>
            <div className="route">{e.text_raw}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
