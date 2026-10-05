// Letzte Reihe Casino – Admin-Schnittstelle.
// Jede Anfrage braucht das Admin-Passwort (ADMIN_KEY in Netlify, sonst das fest eingestellte).
import { getStore as rawStore } from "@netlify/blobs";
function getStore(name) {
  const ev = rawStore(name);
  let st = null;
  try { st = rawStore({ name, consistency: "strong" }); } catch {}
  if (!st) return ev;
  // Lesen stark konsistent; falls das in dieser Umgebung nicht geht, normal lesen
  return {
    get: async (k, o) => { try { return await st.get(k, o); } catch { return ev.get(k, o); } },
    list: async (o) => { try { return await st.list(o); } catch { return ev.list(o); } },
    setJSON: (k, v, o) => ev.setJSON(k, v, o),
    delete: (k) => ev.delete(k),
  };
}
import { createHash } from "node:crypto";

const CAP = 10_000_000;
const GAMES = ["chicken", "mines", "tower", "plinko", "poker", "rennen", "stapel", "slot"];
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
    sent: num(rec && rec.sentTotal),
    recv: num(rec && rec.recvTotal),
  };
}

// ================= Wetten =================
// Gleiches Format wie in spielstand.mjs: e/<id> = Frage, b/<id>/<antwort>_<cent>_<zeit>_<name> = Tipp, v/<name>/<id> = Vorschlag.
// Bei der Auflösung werden Topf (P) und Summe der richtigen Tipps (W) festgeschrieben; die Geräte rechnen damit ab.
const W_ID = /^[a-z0-9]{6,24}$/;
const wClean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
function wSanitize(q, opts) {
  q = wClean(q, 140);
  if (q.length < 5) return { err: "Die Frage braucht mindestens 5 Zeichen." };
  if (!Array.isArray(opts)) return { err: "Antworten fehlen." };
  const out = [], seen = new Set();
  for (const o of opts.slice(0, 12)) { const t = wClean(o, 40); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); } }
  if (out.length < 2 || out.length > 6) return { err: "Es braucht 2 bis 6 verschiedene Antworten." };
  return { q, opts: out };
}
const wStatus = (e, now) => (e.status === "open" && e.closeAt && now >= e.closeAt ? "closed" : e.status);
function wParse(key) {
  const m = /^b\/([^/]+)\/(\d+)_(\d+)_(\d+)_(.+)$/.exec(key);
  return m ? { id: m[1], o: +m[2], c: +m[3], t: +m[4], n: decodeURIComponent(m[5]), key } : null;
}
const wClose = (v, now) => { const t = Math.round(num(v)); return t > now ? t : 0; };
async function wBets(store, id) {
  const { blobs } = await store.list({ prefix: id ? `b/${id}/` : "b/" });
  return blobs.map((b) => wParse(b.key)).filter(Boolean);
}
const NAME_RE = /^[a-z0-9äöüß._ -]{3,20}$/;
// Offene Tipps eines Spielers löschen (alle offenen Fragen oder nur eine). Das Gerät des Spielers sieht den Tipp
// dann nicht mehr beim Server und gibt den Einsatz zurück. Erledigte Fragen bleiben unangetastet.
async function wDropBets(store, n, onlyId, now) {
  const bets = (await wBets(store, onlyId)).filter((b) => b.n === n);
  let removed = 0;
  for (const b of bets) {
    const e = await store.get(`e/${b.id}`, { type: "json" });
    if (!e) continue;
    const st = wStatus(e, now);
    if (st === "resolved" || st === "cancelled") continue;
    try { await store.delete(b.key); removed++; } catch {}
  }
  return removed;
}
async function wetten(action, body, now) {
  const store = getStore("wetten");
  const id = String(body.id || "");
  const getE = async () => (W_ID.test(id) ? await store.get(`e/${id}`, { type: "json" }) : null);
  const newId = () => now.toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, "0");

  if (action === "wList") {
    const [{ blobs: eb }, { blobs: vb }, bets] = await Promise.all([store.list({ prefix: "e/" }), store.list({ prefix: "v/" }), wBets(store)]);
    const events = (await Promise.all(eb.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter((e) => e && e.id);
    const sugg = (await Promise.all(vb.map((b) => store.get(b.key, { type: "json" }).then((v) => (v ? { ...v, key: b.key } : null)).catch(() => null)))).filter(Boolean);
    const out = events.map((e) => {
      const list = bets.filter((b) => b.id === e.id), k = e.opts.length, c = new Array(k).fill(0), s = new Array(k).fill(0);
      for (const b of list) if (b.o >= 0 && b.o < k) { c[b.o]++; s[b.o] += b.c; }
      return { ...e, st: wStatus(e, now), c, s: s.map((v) => v / 100), P: num(e.P) / 100, W: num(e.W) / 100 };
    }).sort((a, b) => num(b.t) - num(a.t));
    const bans = (await store.get("bans", { type: "json" })) || {};
    return json({ now, events: out, sugg: sugg.sort((a, b) => a.t - b.t), bans: Object.keys(bans).sort() });
  }

  if (action === "wCreate" || action === "wActivate") {
    let v = null;
    if (action === "wActivate") {
      const sk = String(body.sugg || "");
      if (!/^v\/[^/]+\/[a-z0-9]{6,24}$/.test(sk)) return json({ error: "Vorschlag ungültig." }, 400);
      v = await store.get(sk, { type: "json" });
      if (!v) return json({ error: "Den Vorschlag gibt es nicht mehr." }, 404);
      v.key = sk;
    }
    const s = wSanitize(body.q ?? (v && v.q), body.opts ?? (v && v.opts));
    if (s.err) return json({ error: s.err }, 400);
    const e = { id: newId(), q: s.q, opts: s.opts, status: "open", closeAt: wClose(body.closeAt, now), t: now, by: v ? v.by : null };
    await store.setJSON(`e/${e.id}`, e);
    if (v) await store.delete(v.key);
    return json({ ok: true, event: e });
  }

  // Spieler ganz von Wetten ausschließen (oder wieder zulassen): offene Tipps und Vorschläge werden entfernt
  if (action === "wBan") {
    const n = String(body.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!NAME_RE.test(n)) return json({ error: "Ungültiger Name." }, 400);
    const bans = (await store.get("bans", { type: "json" })) || {};
    if (body.on) {
      if (!(await getStore("spielstaende").get(encodeURIComponent(n), { type: "json" }))) return json({ error: "Diesen Spieler gibt es nicht." }, 404);
      bans[n] = now;
      const removed = await wDropBets(store, n, null, now);
      const { blobs } = await store.list({ prefix: `v/${encodeURIComponent(n)}/` });
      for (const b of blobs) { try { await store.delete(b.key); } catch {} }
      await store.setJSON("bans", bans);
      return json({ ok: true, bans: Object.keys(bans), removed });
    }
    delete bans[n];
    await store.setJSON("bans", bans);
    return json({ ok: true, bans: Object.keys(bans) });
  }

  if (action === "wReject") {
    const sk = String(body.sugg || "");
    if (!/^v\/[^/]+\/[a-z0-9]{6,24}$/.test(sk)) return json({ error: "Vorschlag ungültig." }, 400);
    await store.delete(sk);
    return json({ ok: true });
  }

  const e = await getE();
  if (!e) return json({ error: "Die Frage gibt es nicht (mehr)." }, 404);
  const st = wStatus(e, now);
  const done = st === "resolved" || st === "cancelled";

  if (action === "wExclude") {          // Spieler nur von dieser Frage ausschließen (oder wieder zulassen)
    if (done) return json({ error: "Die Frage ist schon erledigt." }, 409);
    const n = String(body.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!NAME_RE.test(n)) return json({ error: "Ungültiger Name." }, 400);
    const ex = new Set(Array.isArray(e.ex) ? e.ex : []);
    let removed = 0;
    if (body.on) {
      if (!(await getStore("spielstaende").get(encodeURIComponent(n), { type: "json" }))) return json({ error: "Diesen Spieler gibt es nicht." }, 404);
      ex.add(n); removed = await wDropBets(store, n, e.id, now);
    } else ex.delete(n);
    e.ex = [...ex];
    await store.setJSON(`e/${e.id}`, e);
    return json({ ok: true, event: e, removed });
  }

  if (action === "wStop") {             // Wettschluss sofort
    if (done) return json({ error: "Die Frage ist schon erledigt." }, 409);
    e.status = "closed"; e.closeAt = 0;
  } else if (action === "wDeadline") {  // neuer Wettschluss (0 = offen ohne Frist), öffnet wieder
    if (done) return json({ error: "Die Frage ist schon erledigt." }, 409);
    e.status = "open"; e.closeAt = wClose(body.closeAt, now);
  } else if (action === "wResolve") {   // richtige Antwort festlegen: endgültig
    if (done) return json({ error: "Die Frage ist schon aufgelöst." }, 409);
    const win = Number(body.win);
    if (!Number.isInteger(win) || win < 0 || win >= e.opts.length) return json({ error: "Antwort ungültig." }, 400);
    const list = await wBets(store, e.id);
    e.status = "resolved"; e.win = win; e.doneAt = now; e.closeAt = Math.min(num(e.closeAt) || now, now);
    e.P = list.reduce((t, b) => t + b.c, 0);
    e.W = list.filter((b) => b.o === win).reduce((t, b) => t + b.c, 0);
    e.n = list.length; e.nw = list.filter((b) => b.o === win).length;
  } else if (action === "wCancel") {    // abbrechen: alle bekommen ihren Einsatz zurück
    if (done) return json({ error: "Die Frage ist schon erledigt." }, 409);
    e.status = "cancelled"; e.doneAt = now;
  } else if (action === "wDelete") {    // nur erledigte Fragen entfernen (Geräte haben 14 Tage zum Abrechnen)
    if (!done) return json({ error: "Nur aufgelöste oder abgebrochene Fragen kann man entfernen." }, 409);
    for (const b of await wBets(store, e.id)) { try { await store.delete(b.key); } catch {} }
    await store.delete(`e/${e.id}`);
    return json({ ok: true });
  } else return json({ error: "unbekannte_aktion" }, 400);

  await store.setJSON(`e/${e.id}`, e);
  return json({ ok: true, event: e });
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

  if (String(action || "").startsWith("w")) return wetten(action, body, now);

  if (!key) return json({ error: "kein_name" }, 400);
  const rec = await store.get(key, { type: "json" });
  if (!rec) return json({ error: "unbekannt" }, 404);

  if (action === "get") {
    const bans = (await getStore("wetten").get("bans", { type: "json" })) || {};
    return json({ account: { ...summary(key, rec), wBanned: !!bans[decodeURIComponent(key)] }, state: rec.state });
  }

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
    rec.state = { v: 1, bal: 1000, stars: 0, restarts: 0, owned: { games: {}, items: {} }, spent: 0, created: t, updated: t, set: st.set || {}, sent: 0, recv: 0, playMs: num(st.playMs), playSeed: 1 };
    rec.sentTotal = 0; rec.recvTotal = 0;
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
