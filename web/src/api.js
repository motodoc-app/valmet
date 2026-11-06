// Thin API client. Every call goes to the FastAPI backend (vite proxies /api in dev).
const j = async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);

export const api = {
  scene: () => fetch("/api/scene").then(j),
  assets: () => fetch("/api/assets").then(j),
  grid: () => fetch("/api/nav/grid").then(j),
  plan: (body) => post("/api/nav/plan", body),
  diagnose: (id) => fetch(`/api/diagnose/${id}`).then(j),
  telemetry: (id) => fetch(`/api/assets/${id}/telemetry`).then(j),
  command: (text, selected) => post("/api/copilot/command", { text, selected_asset_id: selected }),
  query: (question, asset_id, component) => post("/api/copilot/query", { question, asset_id, component }),
  search: (q) => fetch(`/api/knowledge/search?q=${encodeURIComponent(q)}`).then(j),
  doc: (id) => fetch(`/api/knowledge/doc/${encodeURIComponent(id)}`).then(j),
  xrayModel: () => fetch("/api/xray/model").then(j),
  draftWO: (asset_id) => post("/api/work-orders/draft", { asset_id }),
};
