// Speichert und lädt Spielstände pro Login-Name (Netlify Blobs).
import { getStore } from "@netlify/blobs";

const NAME_RE = /^[a-z0-9äöüß._-]{3,20}$/;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") || "").trim().toLowerCase();
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const store = getStore("spielstaende");
  const key = encodeURIComponent(name);

  if (req.method === "GET") {
    const data = await store.get(key, { type: "json" });
    return json({ exists: !!data, state: data ? data.state : null });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
    const state = body && body.state;
    if (!state || typeof state !== "object" || typeof state.bal !== "number") return json({ error: "kein_spielstand" }, 400);
    const raw = JSON.stringify(state);
    if (raw.length > 400000) return json({ error: "zu_gross" }, 413);
    if (body.create) {
      const existing = await store.get(key);
      if (existing) return json({ error: "vergeben" }, 409);
    }
    await store.setJSON(key, { state, updated: Date.now() });
    return json({ ok: true });
  }

  return json({ error: "methode" }, 405);
};

export const config = { path: "/api/spielstand" };
