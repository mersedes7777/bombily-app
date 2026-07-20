import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export default function Profile({ me }) {
  const [phone, setPhone] = useState(me?.phone || "");

  async function savePhone() {
    await api.updateProfile({ phone });
  }

  return (
    <div className="tabview">
      <div style={{ padding: "26px 20px 18px", textAlign: "center", borderBottom: "1px solid var(--line)" }}>
        <div className="avatar" style={{ width: 64, height: 64, fontSize: 22, margin: "0 auto 10px" }}>
          {me?.name?.[0] || "?"}
        </div>
        <div style={{ fontFamily: "Oswald", fontWeight: 600, fontSize: 16 }}>{me?.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>Рейтинг {me?.rating?.toFixed(1)} · {me?.completed_rides} поездок</div>
      </div>

      <div className="form-wrap">
        <div className="field">
          <label>Телефон (виден только после подтверждения заказа)</label>
          <div className="input-row">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 000-00-00" />
          </div>
        </div>
        <button className="cta" onClick={savePhone}>Сохранить</button>
      </div>
    </div>
  );
}
