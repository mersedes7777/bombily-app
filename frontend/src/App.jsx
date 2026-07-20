import { useEffect, useState } from "react";
import { initTelegram, getInitData } from "./lib/telegram.js";
import { api, setAuthToken } from "./lib/api.js";
import BottomNav from "./components/BottomNav.jsx";
import Feed from "./screens/Feed.jsx";
import Request from "./screens/Request.jsx";
import Trips from "./screens/Trips.jsx";
import Profile from "./screens/Profile.jsx";

export default function App() {
  const [tab, setTab] = useState("feed");
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initTelegram();

    async function login() {
      try {
        const initData = getInitData();
        // локальная разработка без Telegram: initData будет пустым — используем заглушку
        if (!initData) {
          console.warn("Нет initData — запущено вне Telegram, часть функций будет недоступна");
          setLoading(false);
          return;
        }
        const { token, user } = await api.verify(initData);
        setAuthToken(token);
        setMe(user);
        await api.setStatus(user.role === "driver" || user.role === "both" ? "online" : "offline");
      } catch (e) {
        console.error("Auth failed", e);
      } finally {
        setLoading(false);
      }
    }
    login();

    // heartbeat, пока приложение открыто — поддерживает статус "online" у водителей
    const hb = setInterval(() => {
      api.heartbeat().catch(() => {});
    }, 60000);
    return () => clearInterval(hb);
  }, []);

  if (loading) {
    return (
      <div className="device" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="wordmark">ПУЛЬ<span>С</span></div>
      </div>
    );
  }

  return (
    <div className="device">
      <div className="topbar">
        <div className="wordmark">ПУЛЬ<span>С</span></div>
        <div className="topbar-status"><span className="status-dot"></span>на линии</div>
      </div>

      {tab === "feed" && <Feed />}
      {tab === "request" && <Request me={me} />}
      {tab === "trips" && <Trips />}
      {tab === "profile" && <Profile me={me} />}

      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}
