export default function BottomNav({ active, onChange }) {
  const items = [
    { id: "feed", label: "Лента" },
    { id: "request", label: "Заказать" },
    { id: "trips", label: "Поездки" },
    { id: "profile", label: "Профиль" },
  ];
  return (
    <nav>
      {items.map((it) => (
        <button
          key={it.id}
          className={`nav-item ${active === it.id ? "active" : ""}`}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}
