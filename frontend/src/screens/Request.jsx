import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { supabase } from "../lib/supabaseClient.js";

const REASONS = [
  ["price_after_agreement", "Завысил цену после согласования"],
  ["no_show", "Не приехал / не отвечает"],
  ["rudeness", "Грубость, оскорбления"],
  ["payment_outside_app", "Просит оплату мимо приложения"],
];

export default function Request({ me }) {
  const [stage, setStage] = useState("form"); // form | waiting | confirmed
  const [from, setFrom] = useState("Моя геолокация");
  const [to, setTo] = useState("");
  const [ride, setRide] = useState(null);
  const [offers, setOffers] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  async function findCar() {
    if (!to.trim()) return;
    const created = await api.createRide({ from_address: from, to_address: to });
    setRide(created);
    setOffers([]);
    setStage("waiting");
  }

  // подписка на отклики водителей в реальном времени
  useEffect(() => {
    if (!ride) return;
    const channel = supabase
      .channel(`offers_${ride.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "offers", filter: `ride_id=eq.${ride.id}` },
        (payload) => setOffers((prev) => [payload.new, ...prev])
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [ride]);

  async function choose(offer) {
    await api.selectOffer(ride.id, offer.id);
    setChosen(offer);
    setStage("confirmed");
  }

  function reset() {
    setStage("form");
    setTo("");
    setRide(null);
    setOffers([]);
    setChosen(null);
  }

  if (stage === "form") {
    return (
      <div className="tabview">
        <div className="form-wrap">
          <div className="field">
            <label>Откуда</label>
            <div className="input-row"><input value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          </div>
          <div className="field">
            <label>Куда</label>
            <div className="input-row"><input placeholder="Адрес назначения" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          <button className="cta" onClick={findCar}>Найти машину</button>
        </div>
      </div>
    );
  }

  if (stage === "waiting") {
    return (
      <div className="tabview">
        <div style={{ textAlign: "center", padding: "20px 16px" }}>
          <div style={{ fontFamily: "Oswald", fontWeight: 600 }}>Ищем свободные машины</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>{from} → {to}</div>
        </div>
        {offers.length === 0 && <div className="empty-state">Ждём первых предложений от водителей...</div>}
        {offers.map((o) => (
          <div className="offer" key={o.id}>
            <div className="avatar">{o.driver_id?.toString()[0] || "?"}</div>
            <div className="offer-body">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Водитель</span>
                <span className="price">{o.price} ₽</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>через {o.eta_minutes} мин</div>
              <button className="select-btn" onClick={() => choose(o)}>Выбрать</button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // confirmed
  return (
    <div className="tabview">
      <div style={{ padding: 24, textAlign: "center" }}>
        <div style={{ fontFamily: "Oswald", fontWeight: 600, fontSize: 17 }}>Водитель едет к вам</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>{chosen?.price} ₽ · через {chosen?.eta_minutes} мин</div>

        {!chatOpen ? (
          <>
            <button className="cta" style={{ marginTop: 20 }} onClick={() => setChatOpen(true)}>Написать водителю</button>
            <button className="secondary-btn" onClick={() => setReportOpen(true)}>Пожаловаться</button>
            <button className="secondary-btn" onClick={reset}>Новая заявка</button>
          </>
        ) : (
          <ChatPanel rideId={ride.id} me={me} onClose={() => setChatOpen(false)} />
        )}

        {reportOpen && (
          <ReportSheet
            onCancel={() => setReportOpen(false)}
            onSubmit={async (reason) => {
              await api.report({ ride_id: ride.id, target_id: chosen.driver_id, reason });
              setReportOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ChatPanel({ rideId, me, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    supabase
      .from("messages")
      .select("*")
      .eq("ride_id", rideId)
      .order("created_at", { ascending: true })
      .then(({ data }) => setMessages(data || []));

    const channel = supabase
      .channel(`messages_${rideId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `ride_id=eq.${rideId}` },
        (payload) => setMessages((prev) => [...prev, payload.new])
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [rideId]);

  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [messages]);

  async function send() {
    if (!text.trim()) return;
    await supabase.from("messages").insert({ ride_id: rideId, sender_id: me.id, text: text.trim() });
    setText("");
  }

  return (
    <div style={{ textAlign: "left", marginTop: 16 }}>
      <button className="secondary-btn" onClick={onClose}>← Закрыть чат</button>
      <div className="chat-messages" ref={boxRef} style={{ maxHeight: 260 }}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.sender_id === me.id ? "me" : "them"}`}>{m.text}</div>
        ))}
      </div>
      <div className="chat-input-row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Написать сообщение..." onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="chat-send" onClick={send}>➤</button>
      </div>
    </div>
  );
}

function ReportSheet({ onCancel, onSubmit }) {
  const [reason, setReason] = useState(null);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(4,6,5,.6)", display: "flex", alignItems: "flex-end", maxWidth: 430, margin: "0 auto" }}>
      <div style={{ width: "100%", background: "var(--surface)", borderRadius: "20px 20px 0 0", padding: 18 }}>
        <div style={{ fontFamily: "Oswald", fontWeight: 600, fontSize: 16, marginBottom: 12 }}>Пожаловаться</div>
        {REASONS.map(([id, label]) => (
          <div
            key={id}
            onClick={() => setReason(id)}
            style={{ padding: "12px 4px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", cursor: "pointer" }}
          >
            <span>{label}</span>
            <span style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid var(--line)", background: reason === id ? "var(--red)" : "transparent" }} />
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="secondary-btn" style={{ marginTop: 0 }} onClick={onCancel}>Отмена</button>
          <button className="cta" style={{ background: "var(--red)" }} onClick={() => reason && onSubmit(reason)}>Отправить</button>
        </div>
      </div>
    </div>
  );
}
