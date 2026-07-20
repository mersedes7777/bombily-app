const BASE = import.meta.env.VITE_BACKEND_URL;

let authToken = null;
export function setAuthToken(token) {
  authToken = token;
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

export const api = {
  verify: (initData) => request("/auth/verify", { method: "POST", body: JSON.stringify({ initData }) }),
  me: () => request("/users/me"),
  setStatus: (status) => request("/users/status", { method: "POST", body: JSON.stringify({ status }) }),
  heartbeat: () => request("/users/heartbeat", { method: "POST" }),
  updateProfile: (patch) => request("/users/me", { method: "PATCH", body: JSON.stringify(patch) }),

  createRide: (payload) => request("/rides", { method: "POST", body: JSON.stringify(payload) }),
  feed: () => request("/rides/feed"),
  makeOffer: (rideId, payload) => request(`/rides/${rideId}/offers`, { method: "POST", body: JSON.stringify(payload) }),
  selectOffer: (rideId, offerId) => request(`/rides/${rideId}/select`, { method: "POST", body: JSON.stringify({ offer_id: offerId }) }),
  depart: (rideId) => request(`/rides/${rideId}/depart`, { method: "POST" }),
  complete: (rideId, role, rating) => request(`/rides/${rideId}/complete`, { method: "POST", body: JSON.stringify({ role, rating }) }),
  cancel: (rideId) => request(`/rides/${rideId}/cancel`, { method: "POST" }),

  report: (payload) => request("/reports", { method: "POST", body: JSON.stringify(payload) }),
};
