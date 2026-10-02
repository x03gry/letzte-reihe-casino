// Letzte Reihe Casino – Admin-Schnittstelle.
// Jede Anfrage braucht das Admin-Passwort (ADMIN_KEY in Netlify, sonst das fest eingestellte).
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const CAP = 10_000_000;
const GAMES = ["chicken", "mines", "tower", "plinko"];
const ITEMS = ["kette", "uhr", "auto", "villa", "yacht", "jet", "insel"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const r2 = (v) => Math.round(v * 100) / 100;

// Admin-Passwort: Netlify-Variable ADMIN_KEY, sonst das fest eingestellte Passwort (nur als Prüfsumme gespeichert)
const FALLBACK_HASH = "49d180ecf56132819571bf39d9b7b342522a2ac6d23c1418d3338251bfe469c8";
const sha = (v) => createHash("sha256").update(String(v || "")).digest("hex");
function adminKey() {
  try { if (globalThis.Netlify && Netlify.env && Netlify.env.get) return Netlify.env.get("ADMIN_KEY") || ""; } catch {}
  return process.env.ADMIN_KEY || "";
}
function sameKey(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function summary(key, rec) {
  const st = (rec && rec.state) || {};
  const games = st.games || {};
  let rounds = 0, net = 0;
  const perGame = {};
  for (const [k, g] of Object.entries(games)) {
    rounds += num(g && g.n); net += num(g && g.p) - num(g && g.w);
    perGame[k] = num(g && g.n);
  }
  const fav = Object.entries(perGame).filter(([k]) => k !== "double").sort((a, b) => b[1] - a[1])[0];
  const owned = st.owned || {};
  return {
    name: decodeURIComponent(key),
    bal: r2(num(st.bal)),
    stars: num(st.stars),
    rounds,
    net: r2(net),
    bonus: r2(Object.values(st.bonus || {}).reduce((s, v) => s + num(v), 0)),
    spent: r2(num(st.spent)),
    restarts: num(st.restarts),
    lastRestart: num(st.lastRestart),
    games: Object.keys(owned.games || {}),
    items: Object.keys(owned.items || {}),
    fav: fav && fav[1] > 0 ? fav[0] : null,
    savedAt: num(rec && rec.savedAt),
    banned: !!(rec && rec.banned),
    rev: num(rec && rec.rev),
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "methode" }, 405);
  const KEY = adminKey();
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }

  // Schutz gegen Durchprobieren: nach 8 falschen Versuchen in 15 Minuten ist 15 Minuten Pause
  const admin = getStore("admin");
  const now = Date.now();
  const fails = ((await admin.get("fails", { type: "json" })) || []).filter((t) => now - t < 15 * 60_000);
  if (fails.length >= 8) return json({ error: "Zu viele falsche Versuche. Warte 15 Minuten." }, 429);

  const ok = KEY ? sameKey(body.key, KEY) : sameKey(sha(body.key), FALLBACK_HASH);
  if (!ok) {
    fails.push(now);
    await admin.setJSON("fails", fails);
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: "falsches_passwort" }, 401);
  }

  const store = getStore("spielstaende");
  const action = body.action;
  const key = body.name ? encodeURIComponent(String(body.name).trim().toLowerCase().replace(/\s+/g, " ")) : null;

  if (action === "login") return json({ ok: true });

  if (action === "list") {
    const { blobs } = await store.list();
    const out = [];
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: "json" });
      if (rec) out.push(summary(b.key, rec));
    }
    return json({ accounts: out });
  }

  if (action === "rejects") return json({ rejects: (await admin.get("rejects", { type: "json" })) || [] });
  if (action === "clearRejects") { await admin.setJSON("rejects", []); return json({ ok: true }); }

  if (action === "getMessage") return json({ message: (await admin.get("message", { type: "json" })) || null });
  if (action === "setMessage") {
    const text = String(body.text || "").trim().slice(0, 200);
    if (!text) { await admin.delete("message"); return json({ ok: true, message: null }); }
    const m = { text, id: Date.now() };
    await admin.setJSON("message", m);
    return json({ ok: true, message: m });
  }

  if (!key) return json({ error: "kein_name" }, 400);
  const rec = await store.get(key, { type: "json" });
  if (!rec) return json({ error: "unbekannt" }, 404);

  if (action === "get") return json({ account: summary(key, rec), state: rec.state });

  if (action === "delete") { await store.delete(key); return json({ ok: true }); }

  // Alle folgenden Aktionen ändern den Spielstand. Die Versionsnummer steigt,
  // damit offene Geräte den neuen Stand automatisch übernehmen.
  const st = rec.state || {};
  st.owned = st.owned || { games: {}, items: {} };
  st.owned.games = st.owned.games || {};
  st.owned.items = st.owned.items || {};

  if (action === "update") {
    const s = body.set || {};
    if (typeof s.bal === "number" && isFinite(s.bal)) st.bal = r2(Math.max(0, Math.min(CAP, s.bal)));
    if (typeof s.addBal === "number" && isFinite(s.addBal)) st.bal = r2(Math.max(0, Math.min(CAP, num(st.bal) + s.addBal)));
    if (typeof s.stars === "number" && isFinite(s.stars)) st.stars = Math.max(0, Math.round(s.stars));
    if (s.games && typeof s.games === "object") {
      for (const g of GAMES) if (g in s.games) { if (s.games[g]) st.owned.games[g] = st.owned.games[g] || Date.now(); else delete st.owned.games[g]; }
    }
    if (s.items && typeof s.items === "object") {
      for (const it of ITEMS) if (it in s.items) { if (s.items[it]) st.owned.items[it] = st.owned.items[it] || Date.now(); else delete st.owned.items[it]; }
    }
    if (s.clearCooldown) st.lastRestart = 0;
    if (typeof s.banned === "boolean") rec.banned = s.banned;
  } else if (action === "reset") {
    const t = Date.now();
    rec.state = { v: 1, bal: 1000, stars: 0, restarts: 0, owned: { games: {}, items: {} }, spent: 0, created: t, updated: t, set: st.set || {} };
  } else {
    return json({ error: "unbekannte_aktion" }, 400);
  }

  if (action !== "reset") { st.updated = Date.now(); rec.state = st; }
  rec.rev = num(rec.rev) + 1;
  rec.dev = "admin"; // Geräte müssen die Admin-Änderung übernehmen
  rec.savedAt = Date.now();
  await store.setJSON(key, rec);
  return json({ ok: true, account: summary(key, rec) });
};

export const config = { path: "/api/admin" };
