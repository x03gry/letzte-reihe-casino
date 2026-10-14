// Letzte Reihe Casino – speichert und lädt Spielstände pro Login-Name (Netlify Blobs).
// Jeder Spielstand hat eine Versionsnummer (rev). Wer mit einer alten Version speichern will,
// bekommt den aktuellen Stand zurück (z. B. wenn auf einem anderen Gerät weitergespielt wurde).
// Außerdem prüft der Server jede Änderung auf unmögliche Sprünge (einfacher Schummelschutz).
import { getStore as rawStore } from "@netlify/blobs";
import { createHmac, createHash, randomBytes, scrypt as scryptCb } from "node:crypto";

// Starke Konsistenz: Lesen liefert immer den zuletzt gespeicherten Stand.
// (Standard bei Netlify ist "eventual": kurz nach dem Speichern konnte der Server noch den alten
// oder gar keinen Spielstand sehen -> "Account nicht gefunden" -> Logout, oder Guthaben zurückgesetzt.)
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

// Login-Name: 1 bis 30 Zeichen, alles erlaubt (auch Leerzeichen), nur keine Steuerzeichen. Groß/klein egal (wird klein gespeichert).
const NAME_RE = { test: (n) => typeof n === "string" && n.length >= 1 && n.length <= 30 && n === n.trim() && !/[\u0000-\u001f\u007f]/.test(n) };
const normName = (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");

// ---- Passwörter und Login-Schlüssel
// Passwort: scrypt mit Salz (nie im Klartext). Nach dem Einloggen bekommt das Gerät einen zufälligen Login-Schlüssel;
// gespeichert wird nur dessen Prüfsumme (bis zu 10 Geräte). Jede Änderung am Spielstand braucht diesen Schlüssel.
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
const scrypt = (pw, salt) => new Promise((ok, no) => scryptCb(String(pw), salt, 32, (e, k) => (e ? no(e) : ok(k.toString("hex")))));
const bearer = (req) => { const h = req.headers.get("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };
function authed(req, rec) {
  const t = bearer(req);
  if (!t || !rec || !Array.isArray(rec.tokens)) return false;
  const h = sha(t);
  return rec.tokens.some((x) => x && x.h === h);
}

// ---- Einmaliger Neuanfang: beim ersten Aufruf mit Passwort-Accounts werden alle alten Accounts und Spielerdaten gelöscht
const AUTH_EPOCH = 2;
let epochOk = false;
async function wipeStore(name, keep) {
  const st = getStore(name);
  const { blobs } = await st.list();
  for (const b of blobs) { if (keep && keep(b.key)) continue; try { await st.delete(b.key); } catch {} }
}
async function purgeAll() {
  for (const n of ["spielstaende", "posteingang", "stapel", "rennen", "lotto", "crash", "wirtschaft", "immo", "aktien"]) await wipeStore(n);
  await wipeStore("wetten", (k) => k.startsWith("e/"));   // Fragen bleiben, Tipps/Vorschläge/Ausschlüsse weg
  const admin = getStore("admin");
  for (const k of ["board", "rejects", "stapelPot"]) { try { await admin.delete(k); } catch {} }
}
async function ensureEpoch() {
  if (epochOk) return;
  const admin = getStore("admin");
  const e = await admin.get("authEpoch", { type: "json" });
  if (!(e && e.v >= AUTH_EPOCH)) { await purgeAll(); await admin.setJSON("authEpoch", { v: AUTH_EPOCH, t: Date.now() }); }
  epochOk = true;
}
const CAP = 10_000_000;          // Vermögensgrenze
const RESTART_CD = 3_600_000;    // Neustart nur alle 60 Minuten
const BONUS_PER_SAVE = 15_000;   // Boni, die zwischen zwei Speicherungen höchstens dazukommen können
const TX_MIN = 10;              // Mindestbetrag pro Überweisung
const TX_PER_HOUR = 20;         // höchstens 20 Überweisungen pro Stunde
const TX_MIN_ROUNDS = 20;       // erst nach 20 gespielten Runden (gegen Zweit-Accounts)
const ITEM_PRICE = { kette: 5000, uhr: 25000, auto: 250000, villa: 1000000, yacht: 2500000, jet: 5000000, insel: 10000000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const sumObj = (o, skip) => Object.entries(o || {}).reduce((s, [k, v]) => (k === skip ? s : s + num(v)), 0);
const rounds = (st) => Object.values(st.games || {}).reduce((s, g) => s + num(g && g.n), 0);
const gameNet = (st) => Object.values(st.games || {}).reduce((s, g) => s + num(g && g.p) - num(g && g.w), 0);
const looksFresh = (st) => rounds(st) === 0 && num(st.bal) <= 1000 && num(st.stars) === 0;
const r2 = (v) => Math.round(v * 100) / 100;

function basicCheck(st) {
  if (!st || typeof st !== "object") return "kein_spielstand";
  if (typeof st.bal !== "number" || !isFinite(st.bal) || st.bal < 0 || st.bal > CAP + 0.01) return "guthaben";
  if (JSON.stringify(st).length > 400_000) return "zu_gross";
  return null;
}

// Prüft, ob der neue Stand aus dem alten durch normales Spielen entstanden sein kann.
function plausible(oldS, newS, elapsedMs) {
  const err = basicCheck(newS);
  if (err) return err;

  // "Alles zurücksetzen": erlaubt, aber nicht öfter als ein Neustart
  if (looksFresh(newS)) {
    if (num(oldS.bal) < 1000 && num(newS.lastRestart) - num(oldS.lastRestart) < RESTART_CD - 60_000) return "neustart_zu_frueh";
    return null;
  }

  const dRounds = rounds(newS) - rounds(oldS);
  // weniger Runden/Sterne/Boni als vorher = Speicherstand aus einem älteren Tab -> erlaubt (letzte Speicherung gilt)
  if (dRounds > 40 + (elapsedMs / 1000) * 10) return "zu_viele_runden";

  const dStars = num(newS.stars) - num(oldS.stars);
  if (dStars > 1) return "sterne";
  if (dStars === 1 && num(oldS.bal) < CAP * 0.99) return "stern_ohne_10mio";

  if (num(newS.restarts) > num(oldS.restarts)) {
    if (num(newS.restarts) - num(oldS.restarts) > 1) return "neustarts";
    if (num(newS.lastRestart) - num(oldS.lastRestart) < RESTART_CD - 60_000) return "neustart_zu_frueh";
  }

  const dNet = gameNet(newS) - gameNet(oldS);

  const oldBonus = oldS.bonus || {}, newBonus = newS.bonus || {};
  // Gutschriften aus der Wirtschaft prüft der Server über seine eigene Kasse (wirt.out), nicht über das Bonus-Limit
  const nonWirt = (o) => Object.entries(o).reduce((t, [k, v]) => (k === "sell" || WIRT_KEYS.has(k) ? t : t + num(v)), 0);
  const dBonus = nonWirt(newBonus) - nonWirt(oldBonus);
  const dWirt = num(newS.wirt && newS.wirt.out) - num(oldS.wirt && oldS.wirt.out);
  if (dBonus > BONUS_PER_SAVE + Math.min(200_000, (elapsedMs / 1000) * 50)) return "bonus";

  // Verkäufe nur so viel, wie verkaufte Gegenstände wert waren
  const dSell = num(newBonus.sell) - num(oldBonus.sell);
  const oldItems = (oldS.owned && oldS.owned.items) || {}, newItems = (newS.owned && newS.owned.items) || {};
  let sold = 0;
  for (const k of Object.keys(oldItems)) if (!newItems[k]) sold += (ITEM_PRICE[k] || 0) / 2;
  if (dSell > sold + 1) return "verkauf";

  const dSpent = num(newS.spent) - num(oldS.spent);

  // Guthaben darf nicht stärker steigen, als Spiele, Boni und Verkäufe erklären
  if (dStars <= 0) {
    // inPlay = Einsätze laufender Runden (schon abgezogen, noch nicht ausgewertet)
    const dRecv = num(newS.recv) - num(oldS.recv), dSent = num(newS.sent) - num(oldS.sent);
    const expected = num(oldS.bal) + num(oldS.inPlay) + dNet + dBonus + dSell - dSpent + dRecv - dSent + Math.max(0, dWirt);
    if (num(newS.inPlay) < 0) return "einsatz";
    if (num(newS.bal) + num(newS.inPlay) > expected + 1) return "guthaben_unerklaerlich";
  }
  return null;
}

// ---- Überweisungen: jede Überweisung ist ein eigener Eintrag im Posteingang des Empfängers.
// So schreibt nie jemand anderes in den Spielstand des Empfängers (keine verlorenen Updates).
async function inbox(key) {
  const box = getStore("posteingang");
  const { blobs } = await box.list({ prefix: key + "/" });
  const items = [];
  const got = await Promise.all(blobs.slice(0, 200).map((b) => box.get(b.key, { type: "json" }).then((it) => (it ? { id: b.key, ...it } : null)).catch(() => null)));
  for (const it of got) if (it) items.push(it);
  return items;
}
// Bringt einen vom Gerät geschickten Stand auf die Server-Wahrheit bei Überweisungen:
// gesendet = sentTotal, empfangen = recvTotal (+ neue Eingänge). Gibt die Korrektur des Guthabens zurück.
function normalize(state, sentTotal, recvTotal) {
  const before = num(state.bal);
  if (num(state.sent) > sentTotal + 0.01) return { err: "gesendet" };
  if (num(state.recv) > recvTotal + 0.01) return { err: "empfangen" };
  let bal = r2(before - (sentTotal - num(state.sent)) + (recvTotal - num(state.recv)));
  if (bal < -0.01) return { err: "zu_wenig_guthaben" }; // mehr überwiesen als vorhanden
  bal = Math.min(CAP, Math.max(0, bal));
  state.bal = bal; state.sent = r2(sentTotal); state.recv = r2(recvTotal);
  return { adj: r2(bal - before) };
}

// Abgelehnte Speicherungen für die Admin-Ansicht mitschreiben (letzte 300)
async function logReject(name, reason, oldS, newS) {
  try {
    const admin = getStore("admin");
    const log = (await admin.get("rejects", { type: "json" })) || [];
    log.unshift({ t: Date.now(), name, reason, oldBal: num(oldS && oldS.bal), newBal: num(newS && newS.bal) });
    await admin.setJSON("rejects", log.slice(0, 300));
  } catch {}
}

// ================= Pferderennen (/api/spielstand?rennen=1) =================
// Jede volle Stunde startet ein Rennen. Das Starterfeld (Pferde, Werte, Quoten) ist öffentlich und
// für alle gleich. Den Ausgang bestimmt ein geheimer Seed, den nur der Server kennt
// (HMAC aus einem Geheimnis + Rennnummer). Er wird erst beim Start herausgegeben,
// vorher kann also niemand den Sieger ausrechnen. Die Wetten aller Spieler liegen im Store "rennen" (echter Pot).
const INTERVAL = 3_600_000;   // ein Rennen pro Stunde (muss zur Seite passen)
const CLOSE_MS = 30_000;      // Wettschluss 30 s vor dem Start
const FIELD = 8;              // Pferde pro Rennen
const MAX_STAKE = 2_500_000;  // 25 % von 10 Mio.


// Geheimnis: Netlify-Variable RACE_SECRET, sonst einmalig zufällig erzeugt und gespeichert
let secretCache = null;
async function secret() {
  if (secretCache) return secretCache;
  let s = "";
  try { if (globalThis.Netlify && Netlify.env && Netlify.env.get) s = Netlify.env.get("RACE_SECRET") || ""; } catch {}
  if (!s) s = process.env.RACE_SECRET || "";
  if (!s) {
    const admin = getStore("admin");
    const rec = await admin.get("raceSecret", { type: "json" });
    if (rec && rec.s) s = rec.s;
    else {
      await admin.setJSON("raceSecret", { s: randomBytes(32).toString("hex"), t: Date.now() });
      const again = await admin.get("raceSecret", { type: "json" }); // falls zwei Aufrufe gleichzeitig erzeugt haben: der gespeicherte gilt
      s = again.s;
    }
  }
  return (secretCache = s);
}
const seedOf = async (id) => createHmac("sha256", await secret()).update("rennen|" + id).digest("hex").slice(0, 32);

// Wetten liegen als leere Einträge mit sprechendem Schlüssel: "<rennen>/<pferd>_<cent>_<name>"
// So reicht ein einziges list(), um den Pot zu berechnen.
async function betsOf(id) {
  const { blobs } = await getStore("rennen").list({ prefix: id + "/" });
  const out = [];
  for (const b of blobs) {
    const m = /^\d+\/(\d+)_(\d+)_(.+)$/.exec(b.key);
    if (m) out.push({ h: +m[1], a: +m[2] / 100, n: decodeURIComponent(m[3]), key: b.key });
  }
  return out;
}
function potOf(bets) {
  const c = new Array(FIELD).fill(0), s = new Array(FIELD).fill(0);
  for (const b of bets) if (b.h >= 0 && b.h < FIELD) { c[b.h]++; s[b.h] = Math.round((s[b.h] + b.a) * 100) / 100; }
  return { c, s };
}

async function rennen(req, url) {
  const now = Date.now();

  if (req.method === "GET") {
    const out = { now };
    // Seeds: nur für Rennen, die schon gestartet sind
    const ids = String(url.searchParams.get("ids") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30);
    if (ids.length) {
      out.seeds = {};
      for (const id of ids) if (now >= id * INTERVAL) out.seeds[id] = await seedOf(id);
    }
    // Pot eines Rennens (+ die eigene Wette, falls ein Name mitkommt)
    const pid = Number(url.searchParams.get("pot"));
    if (Number.isInteger(pid) && pid > 0) {
      const bets = await betsOf(pid);
      out.pot = potOf(bets);
      const me = String(url.searchParams.get("name") || "").trim().toLowerCase();
      const mine = me && bets.find((b) => b.n === me);
      if (mine) out.mine = { h: mine.h, a: mine.a };
    }
    return json(out);
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const id = Number(body.id), h = Number(body.horse), a = Math.round(Number(body.stake) * 100) / 100;
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  if (!Number.isInteger(id) || !Number.isInteger(h) || h < 0 || h >= FIELD) return json({ error: "ungueltig" }, 400);
  if (!(a > 0) || a > MAX_STAKE) return json({ error: "einsatz" }, 400);
  if (now >= id * INTERVAL - CLOSE_MS) return json({ error: "wettschluss", now }, 409);
  if (id * INTERVAL - now > INTERVAL + 60_000) return json({ error: "zu_frueh", now }, 409); // nur aufs nächste Rennen

  const acc = await getStore("spielstaende").get(encodeURIComponent(name), { type: "json" });
  if (!acc) return json({ error: "unbekannt" }, 404);
  if (acc.banned) return json({ error: "gesperrt" }, 403);
  if (!authed(req, acc)) return json({ error: "login" }, 401);

  const bets = await betsOf(id);
  if (bets.some((b) => b.n === name)) return json({ error: "schon_gesetzt" }, 409);
  const store = getStore("rennen");
  await store.setJSON(`${id}/${h}_${Math.round(a * 100)}_${encodeURIComponent(name)}`, { t: now });

  // Aufräumen: Wetten von vor zwei Tagen löschen
  try { for (const b of await betsOf(id - 48)) await store.delete(b.key); } catch {}

  bets.push({ h, a, n: name });
  return json({ ok: true, now, pot: potOf(bets) });
}

// ================= Wetten (/api/spielstand?wetten=1) =================
// Der Admin stellt Fragen zu Ereignissen mit mehreren Antworten (oder aktiviert Vorschläge von Spielern).
// Alle Tipps einer Frage landen in einem Topf. Nach der Auflösung teilen sich alle, die richtig getippt haben,
// den ganzen Topf im Verhältnis ihrer Einsätze. Hat niemand richtig getippt oder wird die Frage abgebrochen,
// gibt es die Einsätze zurück. Abgerechnet wird auf dem Gerät mit dem Betrag, den der Server ausrechnet.
// Store "wetten":  e/<id> = Frage · b/<id>/<antwort>_<cent>_<zeit>_<name> = Tipp (leer, alles im Schlüssel)
//                  v/<name>/<id> = Vorschlag eines Spielers · bans = vom Admin ausgeschlossene Spieler {name: zeit}
// Ausgeschlossene (ganz oder nur für eine Frage, e.ex) können nicht tippen; ihre offenen Tipps löscht der Admin-Server, das Gerät gibt den Einsatz zurück.
const W_ID = /^[a-z0-9]{6,24}$/;
const W_SUGG_PER_USER = 3, W_SUGG_MAX = 100, W_SHOW_DONE = 14 * 86_400_000;
const wClean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
// Frage + Antworten prüfen und säubern (gleiche Regeln wie im Admin)
function wSanitize(q, opts) {
  q = wClean(q, 140);
  if (q.length < 5) return { err: "frage" };
  if (!Array.isArray(opts)) return { err: "antworten" };
  const out = [], seen = new Set();
  for (const o of opts.slice(0, 12)) { const t = wClean(o, 40); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); } }
  if (out.length < 2 || out.length > 6) return { err: "antworten" };
  return { q, opts: out };
}
const wStatus = (e, now) => (e.status === "open" && e.closeAt && now >= e.closeAt ? "closed" : e.status);
function wParse(key) {
  const m = /^b\/([^/]+)\/(\d+)_(\d+)_(\d+)_(.+)$/.exec(key);
  return m ? { id: m[1], o: +m[2], c: +m[3], t: +m[4], n: decodeURIComponent(m[5]), key } : null;
}
// Auszahlung eines Tipps in Cent (null = noch offen)
function wPay(e, b) {
  if (e.status === "cancelled") return b.c;
  if (e.status !== "resolved") return null;
  if (b.t > num(e.doneAt) || !(num(e.W) > 0)) return b.c;      // nach der Auflösung gesetzt / niemand lag richtig: zurück
  if (b.o !== e.win) return 0;
  return Number((BigInt(Math.round(e.P)) * BigInt(b.c)) / BigInt(Math.round(e.W))); // abgerundet auf den Cent
}
function wPublic(e, list, now, me) {
  const ex = me && Array.isArray(e.ex) && e.ex.includes(me);
  const k = e.opts.length, c = new Array(k).fill(0), s = new Array(k).fill(0);
  for (const b of list) if (b.o >= 0 && b.o < k) { c[b.o]++; s[b.o] += b.c; }
  const st = wStatus(e, now);
  const out = { id: e.id, q: e.q, opts: e.opts, st, closeAt: num(e.closeAt), t: num(e.t), by: e.by || null, c, s: s.map((v) => v / 100) };
  if (st === "resolved") { out.win = e.win; out.doneAt = num(e.doneAt); }
  if (st === "cancelled") out.doneAt = num(e.doneAt);
  if (ex) out.ex = true;
  if (me) {
    const mb = list.find((b) => b.n === me);
    if (mb) { out.mine = { o: mb.o, a: mb.c / 100, t: mb.t }; const p = wPay(e, mb); if (p != null) out.mine.pay = p / 100; }
  }
  return out;
}
async function wLoad(store) {
  const [{ blobs: eb }, { blobs: bb }] = await Promise.all([store.list({ prefix: "e/" }), store.list({ prefix: "b/" })]);
  const events = (await Promise.all(eb.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter((e) => e && e.id);
  const bets = {};
  for (const b of bb) { const p = wParse(b.key); if (p) (bets[p.id] ||= []).push(p); }
  return { events, bets };
}

async function wetten(req, url) {
  const now = Date.now(), store = getStore("wetten");

  if (req.method === "GET") {
    const raw = String(url.searchParams.get("name") || "").trim().toLowerCase().replace(/\s+/g, " ");
    const me = NAME_RE.test(raw) ? raw : "";
    const { events, bets } = await wLoad(store);
    const rank = { open: 0, closed: 1, resolved: 2, cancelled: 2 };
    const shown = events.filter((e) => {
      const st = wStatus(e, now);
      if (st === "open" || st === "closed") return true;
      // erledigte Fragen 14 Tage zeigen, eigene Tipps immer (damit das Gerät noch abrechnen kann)
      return now - num(e.doneAt) < W_SHOW_DONE || (me && (bets[e.id] || []).some((b) => b.n === me));
    }).sort((a, b) => {
      const sa = rank[wStatus(a, now)], sb = rank[wStatus(b, now)];
      if (sa !== sb) return sa - sb;
      if (sa === 2) return num(b.doneAt) - num(a.doneAt);
      return (num(a.closeAt) || 9e15) - (num(b.closeAt) || 9e15) || num(b.t) - num(a.t);
    }).filter((e, i) => i < 60 || (me && (bets[e.id] || []).some((b) => b.n === me))); // eigene Tipps nie abschneiden
    const out = { now, events: shown.map((e) => wPublic(e, bets[e.id] || [], now, me)) };
    if (me) {
      const bans = (await store.get("bans", { type: "json" })) || {};
      if (bans[me]) out.banned = true;
      const { blobs } = await store.list({ prefix: `v/${encodeURIComponent(me)}/` });
      out.sugg = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean)
        .map((v) => ({ id: v.id, q: v.q, opts: v.opts, t: v.t })).sort((a, b) => b.t - a.t);
    }
    return json(out);
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const key = encodeURIComponent(name);
  const acc = await getStore("spielstaende").get(key, { type: "json" });
  if (!acc) return json({ error: "unbekannt" }, 404);
  if (acc.banned) return json({ error: "gesperrt" }, 403);
  if (!authed(req, acc)) return json({ error: "login" }, 401);
  const st = acc.state || {};
  if (body.action === "bet" || body.action === "suggest") {
    const bans = (await store.get("bans", { type: "json" })) || {};
    if (bans[name]) return json({ error: "ausgeschlossen" }, 403);
  }

  if (body.action === "bet") {
    const id = String(body.id || ""), o = Number(body.opt), c = Math.round(num(body.a) * 100);
    if (!W_ID.test(id)) return json({ error: "ungueltig" }, 400);
    const e = await store.get(`e/${id}`, { type: "json" });
    if (!e) return json({ error: "weg" }, 404);
    if (wStatus(e, now) !== "open") return json({ error: "wettschluss" }, 409);
    if (Array.isArray(e.ex) && e.ex.includes(name)) return json({ error: "ausgeschlossen_frage" }, 403);
    if (!Number.isInteger(o) || o < 0 || o >= e.opts.length) return json({ error: "ungueltig" }, 400);
    // großzügig, weil der gespeicherte Stand ein paar Sekunden alt sein kann (25 % prüft die Seite)
    if (!(c >= 1) || c > 250_000_000 || c / 100 > (num(st.bal) + num(st.inPlay)) * 0.5 + 10) return json({ error: "einsatz" }, 400);
    const { blobs } = await store.list({ prefix: `b/${id}/` });
    const list = blobs.map((b) => wParse(b.key)).filter(Boolean);
    if (list.some((b) => b.n === name)) return json({ error: "schon_gesetzt" }, 409);
    const b = { id, o, c, t: now, n: name, key: `b/${id}/${o}_${c}_${now}_${key}` };
    await store.setJSON(b.key, {});
    list.push(b);
    return json({ ok: true, now, ev: wPublic(e, list, now, name) });
  }

  if (body.action === "suggest") {
    const s = wSanitize(body.q, body.opts);
    if (s.err) return json({ error: s.err }, 400);
    const mine = await store.list({ prefix: `v/${key}/` });
    if (mine.blobs.length >= W_SUGG_PER_USER) return json({ error: "zu_viele_vorschlaege" }, 429);
    const all = await store.list({ prefix: "v/" });
    if (all.blobs.length >= W_SUGG_MAX) return json({ error: "voll" }, 429);
    const id = now.toString(36) + randomBytes(3).toString("hex");
    const v = { id, q: s.q, opts: s.opts, by: name, t: now };
    await store.setJSON(`v/${key}/${id}`, v);
    return json({ ok: true, sugg: { id, q: v.q, opts: v.opts, t: now } });
  }

  if (body.action === "unsuggest") {
    const id = String(body.id || "");
    if (!W_ID.test(id)) return json({ error: "ungueltig" }, 400);
    await store.delete(`v/${key}/${id}`);
    return json({ ok: true });
  }

  return json({ error: "unbekannte_aktion" }, 400);
}

// ================= Jackpot-Ziehung (/api/spielstand?lotto=1) =================
// Jeder verlorene Einsatz fließt komplett in einen gemeinsamen Topf (Gewinne werden nicht gegengerechnet).
// Jeden zweiten Tag (ab Montag, 12.10.2026) wird gezogen, Mo–Fr um 9:35 Uhr, Sa + So um 12:00 Uhr (deutsche Zeit): 1. Platz 50 %, 2. Platz 25 %, 3. Platz 10 %,
// die übrigen 15 % bleiben als Startgeld für die nächste Ziehung im Topf. Drei verschiedene Gewinner.
// Lose: 250 Coins, höchstens 20 gekaufte pro Ziehung. Dazu Gratis-Lose fürs Spielen: je 30 Minuten aktiv gespielt
// (6 Fünf-Minuten-Abschnitte mit mindestens einer Runde) ein Gratis-Los, höchstens 4 pro Ziehung.
// Store "lotto": a/<ziehung>/<name> = {c: Verluste in den Topf, s: aktive Abschnitte} · b/<ziehung>/<name> = {n: gekaufte Lose}
//                r/<ziehung> = Ergebnis · state = {last: zuletzt ausgeführte Ziehung} · cache = Topf (kurz zwischengespeichert)
// Gezogen wird beim ersten Aufruf nach der Ziehungszeit. Der Zufall kommt aus dem Server-Geheimnis + Ziehungszeit:
// derselbe Aufruf zweimal gleichzeitig ergibt exakt dieselben Gewinner und dieselben Posteingangs-Einträge (keine Doppelzahlung).
const LT_PRICE = 250, LT_MAX = 20, LT_FREE_MAX = 4, LT_SLOT = 300_000, LT_SLOTS_PER_FREE = 6;
const LT_SHARES = [0.5, 0.25, 0.1];
const LT_SKIP = new Set(["lotto", "wetten"]);   // Lose zählen direkt, Wetten sind Spieler gegen Spieler
// Verloren = je Runde Einsatz minus Auszahlung, wenn weniger zurückkam (Spielstand-Feld g.l, zählt nur nach oben)
const ltSum = (st, f) => Object.entries((st && st.games) || {}).reduce((s, [k, g]) => (LT_SKIP.has(k) ? s : s + Math.max(0, num(g && g[f]))), 0);
const ltGross = (st) => ltSum(st, "l");
const ltRounds = (st) => Object.entries((st && st.games) || {}).reduce((s, [k, g]) => (k === "lotto" ? s : s + num(g && g.n)), 0);
const ltFree = (slots) => Math.min(LT_FREE_MAX, Math.floor(num(slots) / LT_SLOTS_PER_FREE));

// ---- Ziehungstermine: jeden zweiten Tag ab Mo 12.10.2026, Mo–Fr 9:35 Uhr, Sa + So 12:00 Uhr in Berlin (Sommer- und Winterzeit)
const LT_ANCHOR = Date.UTC(2026, 9, 12) / 86_400_000, LT_SCHED = "2tage-0935-1200";
const ltIsDay = (y, m, d) => (((Math.round(Date.UTC(y, m, d) / 86_400_000) - LT_ANCHOR) % 2) + 2) % 2 === 0;
const BERLIN = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
function berlinParts(ts) {
  const p = {}; for (const x of BERLIN.formatToParts(new Date(ts))) p[x.type] = +x.value || 0;
  return p;
}
function berlinOffset(ts) { const p = berlinParts(ts); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; }
function drawAt(y, m, d) { const wd = new Date(Date.UTC(y, m, d)).getUTCDay(), we = wd === 0 || wd === 6; const guess = Date.UTC(y, m, d, we ? 12 : 9, we ? 0 : 35); return guess - berlinOffset(guess - 7_200_000); }
function ltDays(ts, from, to) {   // Ziehungen von Tag "from" bis "to" (relativ zum Berliner Datum von ts)
  const p = berlinParts(ts), out = [];
  for (let i = from; i <= to; i++) {
    if (ltIsDay(p.year, p.month - 1, p.day + i)) out.push(drawAt(p.year, p.month - 1, p.day + i));
  }
  return out;
}
const nextDraw = (ts) => ltDays(ts, -1, 8).find((t) => t > ts);
const prevDraw = (ts) => ltDays(ts, -8, 1).filter((t) => t <= ts).pop();

let ltSecret = null;
const ltRand = async (D, i) => {
  if (!ltSecret) ltSecret = await secret();
  return BigInt("0x" + createHmac("sha256", ltSecret).update(`lotto|${D}|${i}`).digest("hex").slice(0, 15));
};

// Alle Einträge einer Ziehung: Verluste, Aktivität, gekaufte Lose
async function ltEntries(D) {
  const s = getStore("lotto");
  const [{ blobs: ab }, { blobs: bb }] = await Promise.all([s.list({ prefix: `a/${D}/` }), s.list({ prefix: `b/${D}/` })]);
  const get = (k) => s.get(k, { type: "json" }).catch(() => null);
  const [A, B] = await Promise.all([Promise.all(ab.map((b) => get(b.key))), Promise.all(bb.map((b) => get(b.key)))]);
  const P = new Map(), of = (k) => { if (!P.has(k)) P.set(k, { k, c: 0, s: 0, n: 0 }); return P.get(k); };
  ab.forEach((b, i) => { const v = A[i]; if (!v) return; const p = of(b.key.slice(`a/${D}/`.length)); p.c = r2(p.c + num(v.c)); p.s = Array.isArray(v.s) ? v.s.length : 0; });
  bb.forEach((b, i) => { const v = B[i]; if (!v) return; of(b.key.slice(`b/${D}/`.length)).n = Math.min(LT_MAX, Math.max(0, Math.round(num(v.n)))); });
  const list = [...P.values()].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const players = list.filter((p) => !p.k.startsWith("~")).map((p) => ({ ...p, f: ltFree(p.s), t: p.n + ltFree(p.s) }));
  return { list, players };
}
// Rest aus der letzten ausgeführten Ziehung vor D (auch über eine Umstellung der Uhrzeit hinweg)
async function ltCarryIn(D) {
  const s = getStore("lotto"), { blobs } = await s.list({ prefix: "r/" });
  const last = blobs.map((b) => +b.key.slice(2)).filter((n) => n > 0 && n < D).sort((a, b) => b - a)[0];
  const r = last ? await s.get(`r/${last}`, { type: "json" }).catch(() => null) : null;
  return r ? num(r.carry) : 0;
}
async function ltPot(D) {
  const { list, players } = await ltEntries(D);
  const pot = r2((await ltCarryIn(D)) + list.reduce((t, p) => t + p.c, 0) + LT_PRICE * players.reduce((t, p) => t + p.n, 0));
  return { pot, players, tickets: players.reduce((t, p) => t + p.t, 0) };
}

// Eine Ziehung ausführen (idempotent)
async function ltDraw(D) {
  const s = getStore("lotto");
  if (await s.get(`r/${D}`, { type: "json" }).catch(() => null)) return;
  const { pot, players, tickets } = await ltPot(D);
  const accs = getStore("spielstaende"), box = getStore("posteingang"), now = Date.now();
  let pool = players.filter((p) => p.t > 0), paid = 0, i = 0;
  const win = [];
  for (let rank = 1; rank <= LT_SHARES.length && pool.length; rank++) {
    while (pool.length) {
      const total = pool.reduce((t, p) => t + p.t, 0);
      let r = Number((await ltRand(D, i++)) % BigInt(total)), pick = pool[0];
      for (const p of pool) { if (r < p.t) { pick = p; break; } r -= p.t; }
      pool = pool.filter((p) => p !== pick);
      const acc = await accs.get(pick.k, { type: "json" }).catch(() => null);
      if (!acc || acc.banned) continue;   // gelöscht / gesperrt: nächstes Los ziehen
      // nicht über 10 Mio.: Rest bleibt im Topf
      const pend = (await inbox(pick.k)).filter((it) => !(acc.seen || []).includes(it.id) && !String(it.id).includes(`/lotto-${D}-`)).reduce((t, it) => t + num(it.a), 0);
      const a = r2(Math.max(0, Math.min(Math.floor(pot * LT_SHARES[rank - 1] * 100) / 100, CAP - num(acc.state && acc.state.bal) - pend)));
      if (a > 0) await box.setJSON(`${pick.k}/lotto-${D}-${rank}`, { f: `Jackpot · ${rank}. Platz`, a, t: now });
      paid = r2(paid + a);
      win.push({ r: rank, n: decodeURIComponent(pick.k), a, t: pick.t });
      break;
    }
  }
  await s.setJSON(`r/${D}`, { d: D, pot, carry: r2(pot - paid), players: players.filter((p) => p.t > 0).length, tickets, win, t: now });
  // Aufräumen: Einträge der Ziehung davor werden nicht mehr gebraucht
  try {
    const old = prevDraw(D - 1);
    for (const pre of [`a/${old}/`, `b/${old}/`]) { const { blobs } = await s.list({ prefix: pre }); for (const b of blobs) await s.delete(b.key); }
  } catch {}
}
// Uhrzeit der Ziehung umgestellt: offene Lose und Einzahlungen auf die neue Ziehung am selben Tag umziehen (einmalig)
async function ltMigrate(s, st) {
  // Offene Einträge auf den neuen Plan legen: liegt ihr Termin nicht mehr im Plan, zählen sie für die nächste neue Ziehung
  const isNew = (D) => { const p = berlinParts(D); return ltIsDay(p.year, p.month - 1, p.day) && drawAt(p.year, p.month - 1, p.day) === D; };
  const next = nextDraw(Math.max(num(st.last), Date.now()));
  const sameDay = (D) => (isNew(D) ? D : next);
  for (const pre of ["a/", "b/"]) {
    const { blobs } = await s.list({ prefix: pre });
    for (const b of blobs) {
      const rest = b.key.slice(2), i = rest.indexOf("/"), D = +rest.slice(0, i), who = rest.slice(i + 1);
      if (!(D > 0) || !who || D <= num(st.last)) continue;          // schon gezogen: so lassen
      const N = sameDay(D); if (N === D) continue;
      const v = await s.get(b.key, { type: "json" }).catch(() => null);
      if (v) {
        const nk = `${pre}${N}/${who}`, o = (await s.get(nk, { type: "json" }).catch(() => null)) || null;
        if (pre === "b/") await s.setJSON(nk, { n: Math.min(LT_MAX, Math.round(num(v.n) + num(o && o.n))), t: Math.max(num(v.t), num(o && o.t)), mig: 1 });
        else await s.setJSON(nk, { ...v, c: r2(num(v.c) + num(o && o.c)), s: [...new Set([...(Array.isArray(v.s) ? v.s : []), ...(o && Array.isArray(o.s) ? o.s : [])])].slice(-400) });
      }
      await s.delete(b.key);
    }
  }
  try { await s.delete("cache"); } catch {}
}
// Fällige Ziehungen nachholen (beim ersten Aufruf nach der Ziehungszeit)
async function ltTick(now) {
  const s = getStore("lotto");
  let st = await s.get("state", { type: "json" }).catch(() => null);
  if (!st || !st.last) { st = { last: prevDraw(now), sched: LT_SCHED }; await s.setJSON("state", st); return; }
  if (st.sched !== LT_SCHED) { await ltMigrate(s, st); st = { ...st, sched: LT_SCHED }; await s.setJSON("state", st); }
  for (let k = 0; k < 60; k++) {
    const D = nextDraw(st.last);
    if (!D || D > now) break;
    await ltDraw(D);
    st = { ...st, last: D }; await s.setJSON("state", st);
    try { await s.delete("cache"); } catch {}
  }
}
// Beim Speichern: neue Verluste in den Topf, aktive Abschnitte für Gratis-Lose merken. Gibt die neue Verlust-Marke zurück.
// JEDER verlorene Einsatz zählt voll, Gewinne werden nicht gegengerechnet (das Casino legt sie drauf).
// Marke = höchster bisher gezählter Verlust-Zähler: ein älterer Tab kann nichts doppelt einzahlen.
async function ltOnSave(key, oldS, state, stored, fresh, now) {
  let mark = fresh ? 0 : stored.lossMark;
  if (typeof mark !== "number") mark = ltGross(oldS);
  const older = ltRounds(state) < ltRounds(oldS);         // Stand aus einem älteren Tab: nichts zählen
  const loss = ltGross(state);
  let add = 0;
  if (!older && loss > mark + 0.004) { add = r2(Math.min(loss - mark, Math.max(0, ltSum(state, "w") - ltSum(oldS, "w")))); mark = loss; }
  const slot = !older && ltRounds(state) > ltRounds(oldS) ? Math.floor(now / LT_SLOT) : null;
  if (add > 0 || slot != null) {
    try {
      const s = getStore("lotto"), k = `a/${nextDraw(now)}/${key}`;
      const a = (await s.get(k, { type: "json" })) || { c: 0, s: [] };
      if (!Array.isArray(a.s)) a.s = [];
      const newSlot = slot != null && !a.s.includes(slot);
      if (add > 0 || newSlot) {
        a.c = r2(num(a.c) + add);
        if (newSlot) { a.s.push(slot); if (a.s.length > 400) a.s = a.s.slice(-400); }
        await s.setJSON(k, a);
        // Topf-Anzeige sofort mitziehen (statt erst nach Ablauf des 15-Sekunden-Zwischenspeichers)
        if (add > 0) {
          try { const c = await s.get("cache", { type: "json" }); if (c && c.d === nextDraw(now)) { c.pot = r2(num(c.pot) + add); await s.setJSON("cache", c); } } catch {}
        }
      }
    } catch { return typeof stored.lossMark === "number" ? stored.lossMark : mark - add; }
  }
  return r2(mark);
}

async function lotto(req, url) {
  const now = Date.now(), s = getStore("lotto");
  await ltTick(now);
  const D = nextDraw(now);

  if (req.method === "GET") {
    let c = await s.get("cache", { type: "json" }).catch(() => null);
    if (!c || c.d !== D || now - c.at > 15_000) {
      const p = await ltPot(D);
      c = { d: D, at: now, pot: p.pot, players: p.players.filter((x) => x.t > 0).length, tickets: p.tickets };
      await s.setJSON("cache", c);
    }
    const { blobs } = await s.list({ prefix: "r/" });
    const ids = blobs.map((b) => +b.key.slice(2)).filter((n) => n > 0).sort((a, b) => b - a).slice(0, 6);
    const hist = (await Promise.all(ids.map((id) => s.get(`r/${id}`, { type: "json" }).catch(() => null)))).filter(Boolean);
    const out = { now, d: D, price: LT_PRICE, max: LT_MAX, freeMax: LT_FREE_MAX, slotMs: LT_SLOT, perFree: LT_SLOTS_PER_FREE,
      pot: c.pot, players: c.players, tickets: c.tickets, hist };
    const me = normName(url.searchParams.get("name"));
    if (NAME_RE.test(me)) {
      const k = encodeURIComponent(me);
      const [a, b] = await Promise.all([s.get(`a/${D}/${k}`, { type: "json" }).catch(() => null), s.get(`b/${D}/${k}`, { type: "json" }).catch(() => null)]);
      const slots = a && Array.isArray(a.s) ? a.s.length : 0;
      out.mine = { n: b ? Math.round(num(b.n)) : 0, t: b ? num(b.t) : 0, m: b && b.mig ? 1 : 0, f: ltFree(slots), s: slots, c: a ? num(a.c) : 0 };
      // Lose der letzten Ziehung (für „Deine Lose“ im Ergebnis)
      const P = prevDraw(now);
      if (P && hist[0] && hist[0].d === P) {
        const [pa, pb] = await Promise.all([s.get(`a/${P}/${k}`, { type: "json" }).catch(() => null), s.get(`b/${P}/${k}`, { type: "json" }).catch(() => null)]);
        out.mineLast = (pb ? Math.round(num(pb.n)) : 0) + ltFree(pa && Array.isArray(pa.s) ? pa.s.length : 0);
      }
    }
    return json(out);
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const name = normName(body.name);
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const key = encodeURIComponent(name);
  const acc = await getStore("spielstaende").get(key, { type: "json" });
  if (!acc) return json({ error: "unbekannt" }, 404);
  if (acc.banned) return json({ error: "gesperrt" }, 403);
  if (!authed(req, acc)) return json({ error: "login" }, 401);

  if (body.action === "buy") {
    const n = Number(body.n), d = Number(body.d);
    if (!Number.isInteger(n) || n < 1 || n > LT_MAX) return json({ error: "anzahl" }, 400);
    if (d && d !== D) return json({ error: "gezogen", d: D, now }, 409);   // inzwischen wurde gezogen
    const k = `b/${D}/${key}`, b = (await s.get(k, { type: "json" })) || { n: 0 };
    if (num(b.n) + n > LT_MAX) return json({ error: "max", n: num(b.n), d: D }, 409);
    // großzügig, weil der gespeicherte Stand ein paar Sekunden alt sein kann
    if (n * LT_PRICE > num((acc.state || {}).bal) + num((acc.state || {}).inPlay) + 10) return json({ error: "guthaben" }, 400);
    const total = Math.round(num(b.n) + n);
    await s.setJSON(k, { n: total, t: now });
    try { await s.delete("cache"); } catch {}
    return json({ ok: true, d: D, n: total, now });
  }
  return json({ error: "aktion" }, 400);
}

// ================= Wirtschaft (/api/spielstand?wirt=1) =================
// Passives Einkommen. Alles, was Geld bewegt, läuft über den Server: Er führt pro Spieler eine eigene Kasse
// (Store "wirtschaft", Schlüssel = Account) mit "in" (alles, was in die Wirtschaft geflossen ist) und "out" (alles, was ausgezahlt wurde).
// Der Spielstand trägt dieselben Zähler (state.wirt.in/out). Beim Speichern bringt der Server das Guthaben auf seinen Stand
// (wie bei Überweisungen): fehlt eine Ein-/Auszahlung im Stand, wird sie nachgebucht; mehr als der Server kennt geht nicht.
// Wirtschafts-Gutschriften zählen deshalb nicht gegen das Bonus-Limit pro Speicherung.
const WIRT_KEYS = new Set(["tresor", "shops", "immo", "immoSell", "aktien", "divi", "firma"]);
const TR_RATES = { 4: 0.03, 12: 0.10, 24: 0.25 }, TR_MIN = 1000;   // keine Obergrenze
// Geschäfte: feste Einnahmen pro Stunde, Lager hält 8 Stunden. Nächstes Geschäft erst, wenn das vorige gekauft ist.
const SHOPS = [
  { id: "kaugummi", price: 2000, base: 40 }, { id: "getraenke", price: 10000, base: 180 }, { id: "kiosk", price: 40000, base: 650 },
  { id: "wasch", price: 150000, base: 2200 }, { id: "spielhalle", price: 500000, base: 6500 }, { id: "passage", price: 1500000, base: 17000 }];
const SHOP_MAX = 10, SHOP_STORE_H = 8;
const shopCost = (sh, lvl) => Math.round(sh.price * Math.pow(1.6, lvl - 1));        // Kosten für Stufe lvl (1 = Kauf)
const shopRate = (sh, lvl) => (lvl > 0 ? sh.base * Math.pow(1.4, lvl - 1) : 0);     // Einnahmen pro Stunde
const shopStored = (sh, s, now) => r2(shopRate(sh, s.level) * Math.min(SHOP_STORE_H, Math.max(0, now - num(s.lastCollect)) / 3_600_000));
const wirtFresh = () => ({ in: 0, out: 0, tresor: [], shops: {}, immo: { houses: [], log: [] }, depot: {}, divK: 0 });
async function wirtGet(key) {
  const w = await getStore("wirtschaft").get(key, { type: "json" });
  const f = wirtFresh();
  if (!w) return f;
  const im = w.immo && typeof w.immo === "object" ? w.immo : {};
  return { ...f, ...w, in: r2(num(w.in)), out: r2(num(w.out)), tresor: Array.isArray(w.tresor) ? w.tresor : [], shops: w.shops && typeof w.shops === "object" ? w.shops : {},
    immo: { houses: Array.isArray(im.houses) ? im.houses : [], log: Array.isArray(im.log) ? im.log : [] }, depot: w.depot && typeof w.depot === "object" ? w.depot : {} };
}
function wirtNormalize(state, W) {
  const sw = state.wirt && typeof state.wirt === "object" ? state.wirt : {};
  if (num(sw.in) > W.in + 0.01 || num(sw.out) > W.out + 0.01) return { err: "wirtschaft" };
  const adj = r2((W.out - num(sw.out)) - (W.in - num(sw.in)));
  state.bal = Math.min(CAP, Math.max(0, r2(num(state.bal) + adj)));
  state.wirt = { ...sw, in: W.in, out: W.out };
  return { adj };
}
// Was der Spieler gerade wirklich hat: gespeicherter Stand + noch nicht verbuchte Wirtschafts-Bewegungen
function wirtBal(st, W) {
  const sw = (st && st.wirt) || {};
  return num(st && st.bal) - Math.max(0, W.in - num(sw.in)) + Math.max(0, W.out - num(sw.out));
}
const wirtView = (W) => ({ in: W.in, out: W.out, tresor: W.tresor, shops: W.shops });
async function wirtRoute(req, url) {
  const now = Date.now();
  let name, body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); } name = normName(body.name); }
  else name = normName(url.searchParams.get("name"));
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name", now }, 400);
  const key = encodeURIComponent(name);
  const acc = await getStore("spielstaende").get(key, { type: "json" });
  if (!acc) return json({ error: "unbekannt", now }, 404);
  if (acc.banned) return json({ error: "gesperrt", now }, 403);
  if (!authed(req, acc)) return json({ error: "login", now }, 401);
  const ws = getStore("wirtschaft");
  const W = await wirtGet(key);
  if (req.method === "GET") return json({ ok: true, now, wirt: wirtView(W) });
  if (req.method !== "POST") return json({ error: "methode", now }, 405);
  const st = acc.state || {};
  const fail = (e, extra) => json({ error: e, now, wirt: wirtView(W), ...(extra || {}) }, 400);
  const done = async (extra) => { await ws.setJSON(key, W); return json({ ok: true, now, wirt: wirtView(W), ...extra }); };

  // ---- Tresor
  if (body.action === "tresorLock") {
    const a = Math.floor(num(body.betrag)), h = Number(body.std), satz = TR_RATES[h];
    if (!satz) return fail("laufzeit");
    if (!(a >= TR_MIN)) return fail("zu_wenig");
    if (W.tresor.length) return fail("schon_belegt");
    if (a > wirtBal(st, W) + 10) return fail("guthaben");
    const e = { id: "t" + now.toString(36), betrag: a, start: now, ende: now + h * 3_600_000, satz, std: h };
    W.tresor = [e]; W.in = r2(W.in + a);
    return done({ einlage: e });
  }
  if (body.action === "tresorCollect" || body.action === "tresorEarly") {
    const e = W.tresor.find((x) => x.id === body.id);
    if (!e) return fail("weg");
    const early = body.action === "tresorEarly";
    if (!early && now < e.ende) return fail("noch_nicht");
    if (early && now >= e.ende) return fail("schon_fertig");
    const zinsen = early ? 0 : Math.floor(e.betrag * e.satz);
    const pay = r2(e.betrag + zinsen);
    W.tresor = W.tresor.filter((x) => x.id !== e.id); W.out = r2(W.out + pay);
    W.earned = r2(num(W.earned) + zinsen);
    return done({ betrag: e.betrag, zinsen, pay });
  }
  // ---- Geschäfte
  if (body.action === "shopBuy" || body.action === "shopUp") {
    const i = SHOPS.findIndex((x) => x.id === body.id), sh = SHOPS[i];
    if (!sh) return fail("aktion");
    const cur = W.shops[sh.id] && num(W.shops[sh.id].level) > 0 ? W.shops[sh.id] : null;
    if (body.action === "shopBuy") {
      if (cur) return fail("schon_gekauft");
      if (i > 0 && !(W.shops[SHOPS[i - 1].id] && num(W.shops[SHOPS[i - 1].id].level) > 0)) return fail("gesperrt_shop");
    } else {
      if (!cur) return fail("aktion");
      if (num(cur.level) >= SHOP_MAX) return fail("max_stufe");
    }
    const lvl = cur ? num(cur.level) + 1 : 1, cost = shopCost(sh, lvl);
    // Beim Ausbauen wird das Lager dieses Geschäfts vorher geleert (zum alten Satz)
    const pay = cur ? shopStored(sh, cur, now) : 0;
    if (cost > wirtBal(st, W) + pay + 10) return fail("guthaben");
    W.shops[sh.id] = { level: lvl, lastCollect: now };
    W.in = r2(W.in + cost); W.out = r2(W.out + pay); W.shopEarned = r2(num(W.shopEarned) + pay);
    return done({ cost, pay, level: lvl });
  }
  if (body.action === "shopCollect") {
    let pay = 0;
    for (const sh of SHOPS) { const x = W.shops[sh.id]; if (!x || !(num(x.level) > 0)) continue; pay = r2(pay + shopStored(sh, x, now)); x.lastCollect = now; }
    if (!(pay > 0)) return fail("leer");
    W.out = r2(W.out + pay); W.shopEarned = r2(num(W.shopEarned) + pay);
    return done({ pay });
  }
  return fail("aktion");
}

// ================= Immobilien (/api/spielstand?immo=1) =================
// Vier Stadtteile mit eigenem Kursindex (Start 100, 60–160), für alle gleich, aus dem Server-Geheimnis berechnet:
// zwei langsame Sinuswellen (Perioden von Tagen) + geglättetes Rauschen + Stadtteil-Events. Der Client sieht nur Gegenwart und Vergangenheit.
// Jede volle Stunde 3 Angebote (+ 1× am Tag eine Stadtvilla). Jedes Angebot gibt es nur einmal: der erste Käufer bekommt es.
// Häuser liegen beim Server (Store "wirtschaft"), Leerstand und Haus-Events pro Haus und Stunde aus HMAC(Geheimnis, Haus-ID, Stunde).
const HOUR = 3_600_000;
const IM_DIST = {
  eppendorf: { name: "Eppendorf", a1: 0.07, p1: 130, a2: 0.03, p2: 47, nz: 0.016, note: "Luxusvillen – sehr teuer, sehr sicher" },
  altstadt: { name: "Altstadt", a1: 0.08, p1: 98, a2: 0.04, p2: 35, nz: 0.016, note: "Teuer, stabil" },
  szene: { name: "Szeneviertel", a1: 0.2, p1: 71, a2: 0.11, p2: 26, nz: 0.038, note: "Im Hype – kann kippen" },
  platte: { name: "Plattenbau", a1: 0.04, p1: 160, a2: 0.035, p2: 41, nz: 0.018, note: "Billig, hohe Miete im Verhältnis" },
};
const IM_TYPES = {
  platte: { d: "platte", name: "Plattenbau", min: 60000, max: 95000, rate: 0.0105, reno: 4, w: 35 },
  alt: { d: "altstadt", name: "Altbau", min: 120000, max: 220000, rate: 0.005, reno: 2, w: 35 },
  loft: { d: "szene", name: "Loft", min: 200000, max: 450000, rate: 0.005, reno: 3, w: 30 },
  villa: { d: "eppendorf", name: "Stadtvilla", min: 900000, max: 1600000, rate: 0.0036, reno: 6, w: 0 },
};
const IM_EXTRAS = { garten: { c: 0.04, w: 0.05, m: 0.05 }, garage: { c: 0.07, w: 0.06, m: 0.05 }, pool: { c: 0.14, w: 0.12, m: 0.15 }, solar: { c: 0.06, w: 0.06, m: 0.08 } };
const IM_TIERS = [{ f: 0.8, v: 0 }, { f: 1, v: 0.1 }, { f: 1.35, v: 0.35 }];
const IM_MAX = 8, IM_CAP = 8 * HOUR, IM_DECAY = 3.5 * HOUR;
const IM_STREETS = ["Mühlenstraße", "Lindenallee", "Hafenweg", "Kastanienplatz", "Am Stadtpark", "Bergstraße", "Rosenweg", "Brunnengasse", "Schillerstraße", "Goethering", "Elbchaussee", "Kirchgasse", "Marktplatz", "Schulweg", "Bahnhofstraße", "Ahornweg", "Feldstraße", "Domplatz", "Uferstraße", "Sonnenhang"];
const IM_EVENTS = {
  altstadt: [["Neue U-Bahn-Station", 0.15], ["Altstadtfest lockt Touristen", 0.06], ["Großbaustelle vor der Tür", -0.08], ["Denkmalschutz-Streit", -0.05]],
  szene: [["Neuer Club eröffnet", 0.14], ["Hype-Artikel im Stadtmagazin", 0.10], ["Influencer zieht weg", -0.12], ["Mieten-Debatte im Viertel", -0.09]],
  platte: [["Neuer Park", 0.08], ["Sanierungsprogramm der Stadt", 0.06], ["Fabrik schließt", -0.07]],
  eppendorf: [["Promi kauft Villa", 0.06], ["Neuer Golfplatz", 0.04], ["Gerücht über Villensteuer", -0.04]],
};
let imSec = null;
const imR = (...p) => parseInt(createHmac("sha256", imSec).update("immo|" + p.join("|")).digest("hex").slice(0, 13), 16) / 2 ** 52;
const imMemo = new Map();
function imEvents(day) {   // Events, die an Tag "day" (UTC) beginnen
  const out = [], keys = Object.keys(IM_DIST), n = 1 + (imR("evn", day) < 0.5 ? 1 : 0);
  for (let j = 0; j < n; j++) {
    const d = keys[Math.floor(imR("evd", day, j) * keys.length)], list = IM_EVENTS[d], t = list[Math.floor(imR("evt", day, j) * list.length)];
    out.push({ id: day + "-" + j, d, text: t[0], pct: t[1], start: day * 24 + Math.floor(imR("evs", day, j) * 24), dur: 6 + Math.floor(imR("evl", day, j) * 43) });
  }
  return out;
}
function imEvEffect(d, h) {
  let s = 0;
  for (let day = Math.floor(h / 24) - 2; day <= Math.floor(h / 24); day++) for (const e of imEvents(day)) {
    if (e.d !== d) continue; const r = h - e.start; if (r < 0 || r >= e.dur) continue;
    const ramp = Math.min(1, (r + 1) / 3) * (r > e.dur * 0.7 ? Math.max(0, (e.dur - r) / (e.dur * 0.3)) : 1);
    s += Math.log(1 + e.pct) * ramp;
  }
  return s;
}
function imIdx(d, h) {
  const k = d + "|" + h; if (imMemo.has(k)) return imMemo.get(k);
  const P = IM_DIST[d], kn = Math.floor(h / 4), f = (h % 4) / 4, sm = f * f * (3 - 2 * f);
  const v = (x) => (imR("nz", d, x) * 2 - 1) * P.nz * 2;
  const lg = P.a1 * Math.sin((2 * Math.PI * h) / P.p1 + imR("ph1", d) * 6.283) + P.a2 * Math.sin((2 * Math.PI * h) / P.p2 + imR("ph2", d) * 6.283)
    + v(kn) + (v(kn + 1) - v(kn)) * sm + imEvEffect(d, h);
  const x = Math.round(Math.min(160, Math.max(60, 100 * Math.exp(lg))) * 100) / 100;
  if (imMemo.size > 20000) imMemo.clear();
  imMemo.set(k, x); return x;
}
function imOffers(H, epoch) {
  const out = [], types = ["platte", "alt", "loft"];
  const mk = (i, type) => {
    const T = IM_TYPES[type], base = Math.round((T.min + imR("ob", epoch, H, i) * (T.max - T.min)) / 500) * 500;
    const street = IM_STREETS[Math.floor(imR("os", epoch, H, i) * IM_STREETS.length)] + " " + (1 + Math.floor(imR("on", epoch, H, i) * 60));
    return { id: H + "-" + i, i, type, d: T.d, name: T.name + " " + street, base, price: Math.round(base * imIdx(T.d, H) / 100 * 1.05), rent: Math.round(base * T.rate), lux: type === "villa" };
  };
  for (let i = 0; i < 3; i++) { const r = imR("ot", epoch, H, i) * 100; out.push(mk(i, r < 35 ? "platte" : r < 70 ? "alt" : "loft")); }
  const day = Math.floor(H / 24);
  if (H === day * 24 + 6 + Math.floor(imR("vh", epoch, day) * 14)) out.push(mk(3, "villa"));   // 1× am Tag, tagsüber
  return out;
}
const imCond = (h, t) => (t < num(h.renoAt) ? 100 : Math.max(0, 100 - Math.floor((t - num(h.renoAt)) / IM_DECAY)));
const imBm = (c) => (c >= 70 ? 1 : c >= 50 ? 0.5 : 0);
const imCondF = (c) => (c >= 70 ? 1 : c >= 50 ? 0.85 : 0.6);
const imSum = (h, f) => Object.keys(h.extras || {}).reduce((s, k) => s + (h.extras[k] && IM_EXTRAS[k] ? IM_EXTRAS[k][f] : 0), 0);
const imReno = (h, t) => num(h.renoUntil) > t && t >= num(h.renoStart);
function imRentAt(h, t, H) {   // Miete pro Stunde in Stunde H (0 bei Leerstand/Renovierung)
  if (imReno(h, t)) return { r: 0, vac: false };
  const tier = IM_TIERS[h.tier] || IM_TIERS[1], vac = imR("vac", h.id, H) < tier.v, c = imCond(h, t);
  return { r: vac ? 0 : h.base * IM_TYPES[h.type].rate * tier.f * imCondF(c) * (1 + imBm(c) * imSum(h, "m")), vac };
}
function imAccrue(h, from, to) {
  let rent = 0, cost = 0; const ev = [];
  for (let t = from; t < to;) {
    const H = Math.floor(t / HOUR), end = Math.min(to, (H + 1) * HOUR), x = imRentAt(h, t, H);
    let r = x.r * (end - t) / HOUR;
    if (end === (H + 1) * HOUR && !imReno(h, t)) {          // Haus-Events nur für volle, abgelaufene Stunden
      const u = imR("hev", h.id, H);
      if (u < 0.004) { const c = Math.round(h.base * 0.05); cost += c; ev.push({ t: end, k: "wasser", a: -c }); }
      else if (u < 0.007 && x.r > 0) { ev.push({ t: end, k: "zahlt", a: -Math.round(r) }); r = 0; }
      else if (u < 0.010 && x.r > 0) { r += x.r; ev.push({ t: end, k: "treu", a: Math.round(x.r) }); }
    }
    rent += r; t = end;
  }
  return { rent, cost, ev };
}
function imSettle(h, t) {
  const end = Math.min(t, num(h.lastCol) + IM_CAP);
  if (end > num(h.rentFrom)) { const a = imAccrue(h, num(h.rentFrom), end); h.kasse = r2(num(h.kasse) + a.rent); h.cost = r2(num(h.cost) + a.cost); h.ev = (h.ev || []).concat(a.ev).slice(-10); h.rentFrom = end; }
}
const imValue = (h, t) => { const c = imCond(h, t); return Math.round(h.base * imIdx(h.d, Math.floor(t / HOUR)) / 100 * (0.7 + 0.3 * c / 100) * (1 + imBm(c) * imSum(h, "w"))); };
const imRenoCost = (h, t) => Math.max(1000, Math.round(h.base * 0.08 * (100 - imCond(h, t)) / 100 * (1 + 0.125 * Object.keys(h.extras || {}).length)));
function imHouseView(h, t) {
  const H = Math.floor(t / HOUR), c = imCond(h, t), cur = imRentAt(h, t, H), copy = JSON.parse(JSON.stringify(h));
  imSettle(copy, t);
  return { ...h, cond: c, value: imValue(h, t), rentH: Math.round(cur.r * 100) / 100, vacant: cur.vac, reno: imReno(h, t),
    renoCost: imRenoCost(h, t), kasse: r2(Math.max(0, num(copy.kasse) - num(copy.cost))), ev: copy.ev || [], capEnd: num(h.lastCol) + IM_CAP,
    trend: Math.round((imIdx(h.d, H) / imIdx(h.d, H - 24) - 1) * 10000) / 100 };
}
async function immoRoute(req, url) {
  const now = Date.now(), H = Math.floor(now / HOUR);
  if (!imSec) imSec = await secret();
  const s = getStore("immo"), cfg = (await s.get("cfg", { type: "json" }).catch(() => null)) || { epoch: 0 }, epoch = num(cfg.epoch);
  let name = "", body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return json({ error: "kaputt", now }, 400); } name = normName(body.name); }
  else name = normName(url.searchParams.get("name") || "");
  // Markt und Stadtteile (für alle gleich)
  async function market() {
    const offers = imOffers(H, epoch);
    const sold = await Promise.all(offers.map((o) => s.get(`s/${H}/${o.i}`, { type: "json" }).catch(() => null)));
    offers.forEach((o, k) => { o.by = sold[k] ? sold[k].by : null; });
    const index = {}, history24 = {};
    for (const d of Object.keys(IM_DIST)) { index[d] = imIdx(d, H); history24[d] = Array.from({ length: 25 }, (_, k) => imIdx(d, H - 24 + k)); }
    const events = [];
    for (let day = Math.floor(H / 24) - 2; day <= Math.floor(H / 24); day++) for (const e of imEvents(day)) if (e.start <= H && H < e.start + e.dur) events.push({ id: e.id, d: e.d, text: e.text, pct: e.pct, start: e.start * HOUR, end: (e.start + e.dur) * HOUR });
    return { now, hour: H, next: (H + 1) * HOUR, offers, index, history24, events };
  }
  let acc = null, key = "", W = null;
  if (name) {
    if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name", now }, 400);
    key = encodeURIComponent(name);
    acc = await getStore("spielstaende").get(key, { type: "json" });
    if (!acc) return json({ error: "unbekannt", now }, 404);
    if (acc.banned) return json({ error: "gesperrt", now }, 403);
    if (!authed(req, acc)) return json({ error: "login", now }, 401);
    W = await wirtGet(key);
  }
  const mine = () => ({ houses: W.immo.houses.map((h) => imHouseView(h, now)), log: W.immo.log.slice(0, 12), in: W.in, out: W.out });
  if (req.method === "GET") return json({ ok: true, ...(await market()), ...(W ? { mine: mine() } : {}) });
  if (req.method !== "POST") return json({ error: "methode", now }, 405);
  if (!W) return json({ error: "login", now }, 401);
  const st = acc.state || {}, ws = getStore("wirtschaft");
  const fail = async (e, extra) => json({ error: e, ...(await market()), mine: mine(), ...(extra || {}) }, 400);
  const done = async (extra) => { await ws.setJSON(key, W); return json({ ok: true, ...(await market()), mine: mine(), ...extra }); };
  const hs = W.immo.houses, h = body.id ? hs.find((x) => x.id === body.id) : null;

  if (body.action === "buy") {
    const [hh, ii] = String(body.offerId || "").split("-").map(Number);
    if (hh !== H) return fail("angebot_weg");
    const o = imOffers(H, epoch).find((x) => x.i === ii);
    if (!o) return fail("angebot_weg");
    if (hs.length >= IM_MAX) return fail("max_haeuser");
    if (o.price > wirtBal(st, W) + 10) return fail("guthaben");
    const sk = `s/${H}/${o.i}`, prev = await s.get(sk, { type: "json" }).catch(() => null);
    if (prev) return fail("verkauft", { by: prev.by });
    // Gleichzeitige Käufer: jeder legt einen Anspruch ab, nach kurzer Wartezeit gewinnt der früheste
    await s.setJSON(`c/${H}/${o.i}/${key}`, { t: now, n: name });
    await new Promise((z) => setTimeout(z, 350));
    const { blobs } = await s.list({ prefix: `c/${H}/${o.i}/` });
    const claims = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
    const again = await s.get(sk, { type: "json" }).catch(() => null);
    if (again && again.by !== name) return fail("verkauft", { by: again.by });
    if (claims.length && claims[0].n !== name) return fail("verkauft", { by: claims[0].n });
    await s.setJSON(sk, { by: name, t: now });
    hs.push({ id: "h" + now.toString(36) + Math.floor(Math.random() * 1296).toString(36), type: o.type, d: o.d, name: o.name, base: o.base, paid: o.price, boughtAt: now,
      tier: 1, extras: {}, renoAt: now, renoStart: 0, renoUntil: 0, rentFrom: now, lastCol: now, kasse: 0, cost: 0, ev: [] });
    W.in = r2(W.in + o.price);
    return done({ cost: o.price, house: hs[hs.length - 1].id });
  }
  if (body.action === "collect") {
    let pay = 0; const log = [];
    for (const x of hs) {
      imSettle(x, now); const p = r2(Math.max(0, num(x.kasse) - num(x.cost))); pay = r2(pay + p);
      for (const e of x.ev || []) log.push({ ...e, n: x.name });
      x.kasse = 0; x.cost = 0; x.ev = []; x.lastCol = now; x.rentFrom = now;
    }
    W.immo.log = log.sort((a, b) => b.t - a.t).concat(W.immo.log).slice(0, 12);
    if (!(pay > 0)) { await ws.setJSON(key, W); return fail("leer"); }
    W.out = r2(W.out + pay); W.immoRent = r2(num(W.immoRent) + pay);
    return done({ pay });
  }
  if (!h) return fail("haus_weg");
  if (body.action === "tier") {
    const t = Number(body.tier); if (!(t === 0 || t === 1 || t === 2)) return fail("aktion");
    imSettle(h, now); h.tier = t; return done({});
  }
  if (body.action === "extra") {
    const k = String(body.key), E = IM_EXTRAS[k];
    if (!E) return fail("aktion");
    if (imReno(h, now)) return fail("renoviert");
    if (h.extras[k]) return fail("schon_gebaut");
    const c = Math.round(h.base * E.c);
    if (c > wirtBal(st, W) + 10) return fail("guthaben");
    imSettle(h, now); h.extras[k] = true; W.in = r2(W.in + c);
    return done({ cost: c });
  }
  if (body.action === "reno") {
    if (imReno(h, now)) return fail("renoviert");
    if (imCond(h, now) >= 95) return fail("top");
    const c = imRenoCost(h, now), dur = (IM_TYPES[h.type].reno + Object.keys(h.extras).length) * HOUR;
    if (c > wirtBal(st, W) + 10) return fail("guthaben");
    imSettle(h, now); h.renoStart = now; h.renoUntil = now + dur; h.renoAt = now + dur; W.in = r2(W.in + c);
    return done({ cost: c, until: h.renoUntil });
  }
  if (body.action === "sell") {
    if (imReno(h, now)) return fail("renoviert");
    imSettle(h, now);
    const v = imValue(h, now), sale = Math.round(now - h.boughtAt < 24 * HOUR ? v * 0.9 : v), rent = r2(Math.max(0, num(h.kasse) - num(h.cost)));
    W.immo.houses = hs.filter((x) => x !== h);
    W.immo.log = (h.ev || []).map((e) => ({ ...e, n: h.name })).concat(W.immo.log).slice(0, 12);
    W.out = r2(W.out + sale + rent); W.immoRent = r2(num(W.immoRent) + rent); W.immoSales = r2(num(W.immoSales) + sale);
    return done({ sale, rent });
  }
  return fail("aktion");
}

// ================= Aktien (/api/spielstand?aktien=1) =================
// 8 Fake-Firmen. Alle 3 Minuten ein neuer Kurs (Tick), für alle gleich: Zufallsbewegung + langsamer Trend + seltene News-Sprünge,
// jeder Schritt aus HMAC(Geheimnis, Firma, Tick). Der Server rechnet beim Abruf die verpassten Ticks nach und speichert
// Kurse + Verlauf (24 Std. fein, 7 Tage alle 30 Min.) im Store "aktien". Depot und Dividenden liegen in der Wirtschafts-Kasse.
const AK_TICK = 180_000, AK_FEE = 0.01, AK_H24 = 480, AK_H7 = 336, AK_DIV_CAP = 24 * HOUR;
const AK = {
  BRZ: { name: "Brezn AG", start: 120, sig: 0.00055, ts: 0.00002, phi: 0.998, kap: 0.0002, jp: 1 / 2600, jm: [0.03, 0.08], div: 0.003, col: "#c98500",
    up: ["eröffnet 50 neue Filialen", "gewinnt Oktoberfest-Auftrag", "Rekord beim Brezel-Absatz"], dn: ["Mehlpreise steigen", "Bäcker streiken", "Salz-Skandal in der Backstube"] },
  TWE: { name: "Tafelwisch Energie", start: 85, sig: 0.0007, ts: 0.00003, phi: 0.998, kap: 0.0002, jp: 1 / 2600, jm: [0.03, 0.09], div: 0.0025, col: "#199e70",
    up: ["neues Windrad-Feld genehmigt", "Strompreise steigen", "Großauftrag von der Schule"], dn: ["Kraftwerk muss gewartet werden", "Stromausfall im Netz", "Kunden wechseln zur Konkurrenz"] },
  MMG: { name: "Mensa-Mampf GmbH", start: 40, sig: 0.0014, ts: 0.00005, phi: 0.998, kap: 0.0002, jp: 1 / 2000, jm: [0.04, 0.12], div: 0.0015, col: "#d95926",
    up: ["neues Pizza-Menü ein Hit", "bekommt fünf neue Schulen", "Testsieger beim Schnitzel"], dn: ["Lebensmittelkontrolle findet Mängel", "Schüler boykottieren Spinat-Tag", "Lieferant pleite"] },
  SBL: { name: "Schulbus Logistik", start: 60, sig: 0.0013, ts: 0.00012, phi: 0.999, kap: 0.00015, jp: 1 / 2200, jm: [0.04, 0.12], div: 0, col: "#ffb020",
    up: ["neue Buslinien bestellt", "Spritpreise fallen", "Rekord bei Pünktlichkeit"], dn: ["Busse bleiben im Stau", "Streik der Fahrer", "Dieselpreis explodiert"] },
  PHH: { name: "Pausenhof Holdings", start: 200, sig: 0.0015, ts: 0.00015, phi: 0.9993, kap: 0.00012, jp: 1 / 2200, jm: [0.05, 0.13], div: 0, col: "#3987e5",
    up: ["kauft Kiosk-Kette", "Pausenhof wird Trend-Spot", "Fusion mit Schulhof AG"], dn: ["Pause wird gekürzt", "Regenwoche leert den Hof", "Chef tritt zurück"] },
  KSC: { name: "Kreidestaub Corp", start: 15, sig: 0.0032, ts: 0.0001, phi: 0.998, kap: 0.0002, jp: 1 / 1500, jm: [0.08, 0.22], div: 0, col: "#a78bfa",
    up: ["Tafeln feiern Comeback", "Bunte Kreide ausverkauft", "Großauftrag aus Bayern"], dn: ["Schulen kaufen Whiteboards", "Kreide-Allergie in den Schlagzeilen", "Lager abgebrannt"] },
  HAI: { name: "Hausaufgaben.io", start: 300, sig: 0.004, ts: 0.00012, phi: 0.998, kap: 0.0002, jp: 1 / 1400, jm: [0.08, 0.25], div: 0, col: "#38bdf8",
    up: ["neue KI-Version gestartet", "1 Mio. neue Nutzer", "Lehrer lieben die App"], dn: ["Server down", "Schulen sperren die App", "Datenleck entdeckt"] },
  PXG: { name: "Pixelpause Games", start: 25, sig: 0.0032, ts: 0.0001, phi: 0.998, kap: 0.0002, jp: 1 / 2800, jm: [0.25, 0.6], div: 0, col: "#ec4899",
    up: ["Spiel geht viral", "Riesen-Update begeistert Fans", "Preis für bestes Indie-Spiel"], dn: ["Spiel voller Bugs", "Release verschoben", "Spieler hauen ab"] },
};
const AK_IDS = Object.keys(AK);
let akSec = null;
function akRand(epoch, id, T) {   // 4 Zufallszahlen pro Firma und Tick
  const h = createHmac("sha256", akSec).update(`ak|${epoch}|${id}|${T}`).digest("hex");
  return [0, 13, 26, 39].map((o) => parseInt(h.slice(o, o + 13), 16) / 2 ** 52);
}
function akFresh(T, epoch) {
  const st = { v: 1, epoch, T, p: {}, tr: {}, h24: {}, h7: {}, news: [] };
  for (const id of AK_IDS) { st.p[id] = AK[id].start; st.tr[id] = 0; st.h24[id] = [AK[id].start]; st.h7[id] = [AK[id].start]; }
  return st;
}
function akStep(st, T) {
  for (const id of AK_IDS) {
    const P = AK[id], [u1, u2, u3, u4] = akRand(st.epoch, id, T);
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
    // Trend: AR(1) mit Standardabweichung P.ts pro Tick (gleichverteilter Anstoß, passend skaliert)
    st.tr[id] = num(st.tr[id]) * P.phi + (u3 * 2 - 1) * P.ts * Math.sqrt(3 * (1 - P.phi * P.phi));
    let lp = Math.log(st.p[id]);
    lp += st.tr[id] + P.sig * z - P.kap * (lp - Math.log(P.start));
    if (u4 < P.jp) {
      const up = u3 < 0.5, m = P.jm[0] + (u4 / P.jp) * (P.jm[1] - P.jm[0]), list = up ? P.up : P.dn;
      lp += Math.log(up ? 1 + m : 1 - m);
      st.news.unshift({ t: T * AK_TICK, id, text: `${P.name}: ${list[Math.floor(u1 * list.length)]}`, pct: Math.round((up ? m : -m) * 1000) / 10 });
      st.news = st.news.slice(0, 20);
    }
    st.p[id] = Math.max(1, Math.round(Math.exp(lp) * 100) / 100);
    st.h24[id].push(st.p[id]); if (st.h24[id].length > AK_H24 + 1) st.h24[id] = st.h24[id].slice(-AK_H24 - 1);
    if (T % 10 === 0) { st.h7[id].push(st.p[id]); if (st.h7[id].length > AK_H7 + 1) st.h7[id] = st.h7[id].slice(-AK_H7 - 1); }
  }
  st.T = T;
}
async function akState(now) {
  if (!akSec) akSec = await secret();
  const s = getStore("aktien"), T = Math.floor(now / AK_TICK);
  const cfg = (await s.get("cfg", { type: "json" }).catch(() => null)) || { epoch: 0 };
  let st = await s.get("state", { type: "json" }).catch(() => null);
  if (!st || st.epoch !== num(cfg.epoch)) st = akFresh(T - 1, num(cfg.epoch));
  if (st.T < T) {
    // Mehr als 10 Tage verpasst: nur die letzten 10 Tage nachrechnen (Kurs läuft einfach von dort weiter)
    let from = Math.max(st.T + 1, T - 4800);
    for (let t = from; t <= T; t++) akStep(st, t);
    try { await s.setJSON("state", st); } catch {}
  }
  return st;
}
const akDivRate = (id) => (AK[id] ? AK[id].div : 0);
function akDivAccrue(W, st, now) {   // offene Dividende (gedeckelt auf 24 Std. je Position)
  let sum = num(W.divK);
  for (const [id, x] of Object.entries(W.depot || {})) {
    if (!x || !(x.n > 0) || !akDivRate(id)) continue;
    sum += x.n * st.p[id] * akDivRate(id) * Math.min(AK_DIV_CAP, Math.max(0, now - num(x.divFrom))) / AK_DIV_CAP;
  }
  return r2(sum);
}
function akDivSettle(W, st, now, id) {   // Dividende einer Position festhalten, bevor sich die Stückzahl ändert
  const x = W.depot[id]; if (!x || !(x.n > 0) || !akDivRate(id)) { if (x) x.divFrom = now; return; }
  W.divK = r2(num(W.divK) + x.n * st.p[id] * akDivRate(id) * Math.min(AK_DIV_CAP, Math.max(0, now - num(x.divFrom))) / AK_DIV_CAP);
  x.divFrom = now;
}
async function aktienRoute(req, url) {
  const now = Date.now();
  let name = "", body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return json({ error: "kaputt", now }, 400); } name = normName(body.name); }
  else name = normName(url.searchParams.get("name") || "");
  const st = await akState(now);
  const view = (W) => {
    const out = { now, tick: st.T, next: (st.T + 1) * AK_TICK, prices: st.p, h24: st.h24, h7: st.h7, news: st.news.slice(0, 8),
      info: Object.fromEntries(AK_IDS.map((id) => [id, { name: AK[id].name, col: AK[id].col, div: AK[id].div }])) };
    if (W) out.mine = { depot: W.depot, div: akDivAccrue(W, st, now), divEarned: num(W.divEarned) };
    return out;
  };
  let acc = null, key = "", W = null;
  if (name) {
    if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name", now }, 400);
    key = encodeURIComponent(name);
    acc = await getStore("spielstaende").get(key, { type: "json" });
    if (!acc) return json({ error: "unbekannt", now }, 404);
    if (acc.banned) return json({ error: "gesperrt", now }, 403);
    if (!authed(req, acc)) return json({ error: "login", now }, 401);
    W = await wirtGet(key);
  }
  if (req.method === "GET") return json({ ok: true, ...view(W) });
  if (req.method !== "POST") return json({ error: "methode", now }, 405);
  if (!W) return json({ error: "login", now }, 401);
  const ws = getStore("wirtschaft"), fail = (e) => json({ error: e, ...view(W) }, 400);
  const done = async (extra) => { await ws.setJSON(key, W); return json({ ok: true, ...view(W), ...extra }); };
  if (body.action === "trade") {
    const id = String(body.id), n = Math.floor(num(body.n)), side = body.side;
    if (!AK[id]) return fail("aktion");
    if (!(n >= 1) || n > 1_000_000) return fail("anzahl");
    const price = st.p[id], x = W.depot[id] || { n: 0, avg: 0, divFrom: now };
    if (side === "buy") {
      const cost = r2(n * price * (1 + AK_FEE));
      if (cost > wirtBal(acc.state || {}, W) + 10) return fail("guthaben");
      akDivSettle(W, st, now, id);
      x.avg = r2((num(x.avg) * num(x.n) + cost) / (num(x.n) + n)); x.n = num(x.n) + n; x.divFrom = now; W.depot[id] = x;
      W.in = r2(W.in + cost);
      return done({ price, cost, n });
    }
    if (side === "sell") {
      if (!(num(x.n) >= n)) return fail("zu_wenig_aktien");
      akDivSettle(W, st, now, id);
      const pay = r2(n * price * (1 - AK_FEE));
      x.n = num(x.n) - n; if (x.n <= 0) delete W.depot[id]; else W.depot[id] = x;
      W.out = r2(W.out + pay);
      return done({ price, pay, n });
    }
    return fail("aktion");
  }
  if (body.action === "divCollect") {
    const pay = akDivAccrue(W, st, now);
    if (!(pay >= 0.01)) return fail("leer");
    for (const [id, x] of Object.entries(W.depot)) if (x) x.divFrom = now;
    W.divK = 0; W.out = r2(W.out + pay); W.divEarned = r2(num(W.divEarned) + pay);
    return done({ pay });
  }
  return fail("aktion");
}

// ================= Crash (/api/spielstand?crash=1) =================
// Gemeinsame Runden für alle: 7 s Wettphase, Flug (m(t) = e^(0,00006·t)), Absturz, 3 s Pause, nächste Runde.
// Crash-Punkt jeder Runde = aus HMAC(Server-Geheimnis, "crash|<id>") ("reveal"). Vorab wird nur SHA-256(reveal) gezeigt.
// Der Crash-Punkt wird erst kurz vor dem Absturz verraten (CR_AHEAD), damit die Seite exakt abstürzen kann, ohne ständig zu fragen.
// Der Zeitplan ist eindeutig: Runde id+1 beginnt 3 s nach dem Absturz von Runde id. Store "crash": anchor = {id, start} · c/<id>/<name> = Einsatz.
// Einsätze: Das Gerät bucht ab (take) und rechnet mit dem Ergebnis vom Server ab. Auszahlen zählt nur, wenn der Server es vor dem Absturz bekommt.
const CR_K = 0.00006, CR_BET = 7000, CR_PAUSE = 3000, CR_AHEAD = 4500, CR_MIN = 0.1, CR_MAXM = 10000, CR_IDLE = 7_200_000;
const crRevealCache = new Map();
async function crReveal(id) {
  if (crRevealCache.has(id)) return crRevealCache.get(id);
  const v = createHmac("sha256", await secret()).update(`crash|${id}`).digest("hex");
  if (crRevealCache.size > 3000) crRevealCache.clear();
  crRevealCache.set(id, v); return v;
}
const crFromReveal = (hx) => { const r = parseInt(hx.slice(0, 13), 16) / 2 ** 52; return Math.min(CR_MAXM, Math.max(1, Math.floor(97 / (1 - r)) / 100)); };
const crFlightMs = (m) => Math.ceil(Math.log(m) / CR_K);
const crMultAt = (ms) => Math.max(1, Math.floor(Math.exp(CR_K * Math.max(0, ms)) * 100 + 1e-9) / 100);
const crMsFor = (m) => Math.ceil(Math.log(m) / CR_K);
async function crRound(id, start) {
  const reveal = await crReveal(id), crash = crFromReveal(reveal), fly = start + CR_BET, at = fly + crFlightMs(crash);
  return { id, start, fly, crash, at, next: at + CR_PAUSE, reveal, hash: createHash("sha256").update(Buffer.from(reveal, "hex")).digest("hex") };
}
// Aktuelle Runde: vom gespeicherten Anker aus vorwärts rechnen (war lange niemand da: neu beginnen, gleich für alle gleichzeitigen Aufrufe)
async function crNow(now) {
  const s = getStore("crash");
  let a = await s.get("anchor", { type: "json" }).catch(() => null), moved = false;
  if (!a || !(a.id > 0) || !(a.start > 0) || now - a.start > CR_IDLE) {
    const id = a && a.id > 0 ? a.id + 1000 : 1;
    a = { id, start: Math.floor(now / 10000) * 10000 }; moved = true;
  }
  let r = await crRound(a.id, a.start);
  for (let k = 0; k < 2000 && now >= r.next; k++) { r = await crRound(r.id + 1, r.next); moved = true; }
  if (moved) {
    await s.setJSON("anchor", { id: r.id, start: r.start });
    if (r.id % 50 === 0) {   // Aufräumen: Einsätze alter Runden
      try { const { blobs } = await s.list({ prefix: "c/" }); for (const b of blobs) { const id = +b.key.split("/")[1]; if (id < r.id - 300) await s.delete(b.key); } } catch {}
    }
  }
  return r;
}
const crPublic = (r, now) => {
  const o = { id: r.id, start: r.start, fly: r.fly, hash: r.hash };
  if (now >= r.at - CR_AHEAD) { o.crash = r.crash; o.at = r.at; o.reveal = r.reveal; }
  return o;
};
// Ergebnis eines Einsatzes (nur wenn die Runde vorbei ist): m = Auszahl-Multiplikator oder 0
const crResult = (b, r) => (b.m > 0 ? b.m : b.auto >= 1.01 && b.auto <= r.crash ? b.auto : 0);

async function crash(req, url) {
  const now = Date.now(), s = getStore("crash"), cur = await crNow(now);
  if (req.method === "GET") {
    const out = { now, cur: crPublic(cur, now), k: CR_K, bet: CR_BET, pause: CR_PAUSE };
    // Verlauf: die letzten 25 abgestürzten Runden (Crash-Punkt, Hash, Reveal zum Nachprüfen)
    const hist = [];
    let id = now >= cur.at ? cur.id : cur.id - 1;
    for (let i = 0; i < 25 && id > 0; i++, id--) { const rv = await crReveal(id); hist.push({ id, crash: crFromReveal(rv), reveal: rv }); }
    out.hist = hist;
    // Spieler der laufenden Runde
    const { blobs } = await s.list({ prefix: `c/${cur.id}/` });
    const bets = (await Promise.all(blobs.slice(0, 60).map((b) => s.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    const el = now - cur.fly;
    out.players = bets.map((b) => {
      let m = b.m > 0 ? b.m : 0;
      if (!m && b.auto >= 1.01 && b.auto <= cur.crash && el >= crMsFor(b.auto)) m = b.auto;   // Auto-Auszahlung schon erreicht
      return { n: b.n, a: b.a, m: now >= cur.at || m ? m : null };
    }).sort((x, y) => y.a - x.a);
    // Eigene offene Einsätze (Gerät fragt nach Ergebnissen)
    const me = normName(url.searchParams.get("name") || ""), ids = String(url.searchParams.get("mine") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    if (NAME_RE.test(me) && ids.length) {
      const key = encodeURIComponent(me);
      out.mine = [];
      for (const id of ids) {
        if (id > cur.id) continue;
        const b = await s.get(`c/${id}/${key}`, { type: "json" }).catch(() => null);
        const done = id < cur.id || now >= cur.at, live = id === cur.id && now < cur.fly;
        if (!b) { if (!live) out.mine.push({ id, none: 1 }); continue; }
        const o = { id, a: b.a, auto: b.auto || 0, m: b.m || 0 };
        if (done) { const rv = await crReveal(id); o.crash = crFromReveal(rv); o.res = crResult(b, { crash: o.crash }); }
        out.mine.push(o);
      }
    }
    return json(out);
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const name = normName(body.name);
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const key = encodeURIComponent(name);
  const acc = await getStore("spielstaende").get(key, { type: "json" });
  if (!acc) return json({ error: "unbekannt" }, 404);
  if (acc.banned) return json({ error: "gesperrt" }, 403);
  if (!authed(req, acc)) return json({ error: "login" }, 401);
  const id = Number(body.id), bk = `c/${id}/${key}`;

  if (body.action === "bet") {
    if (id !== cur.id || now >= cur.fly - 150) return json({ error: "zu_spaet", cur: crPublic(cur, now), now }, 409);
    const a = Math.floor(num(body.a) * 100) / 100, auto = num(body.auto) >= 1.01 ? Math.min(CR_MAXM, Math.floor(num(body.auto) * 100) / 100) : 0;
    if (!(a >= CR_MIN) || a > CAP) return json({ error: "einsatz" }, 400);
    // großzügig, weil der gespeicherte Stand ein paar Sekunden alt sein kann
    if (a > num((acc.state || {}).bal) + num((acc.state || {}).inPlay) + 10) return json({ error: "guthaben" }, 400);
    if (await s.get(bk, { type: "json" }).catch(() => null)) return json({ error: "schon_gesetzt" }, 409);
    await s.setJSON(bk, { n: name, a, auto, m: 0, t: now });
    return json({ ok: true, id, a, auto, now });
  }
  if (body.action === "cancel") {
    if (id !== cur.id || now >= cur.fly - 150) return json({ error: "zu_spaet", now }, 409);
    await s.delete(bk);
    return json({ ok: true, now });
  }
  if (body.action === "cash") {
    const b = await s.get(bk, { type: "json" }).catch(() => null);
    if (!b) return json({ error: "kein_einsatz" }, 404);
    if (b.m > 0) return json({ ok: true, m: b.m, now });
    if (id !== cur.id || now < cur.fly) return json({ error: id < cur.id ? "abgestuerzt" : "noch_nicht", now }, 409);
    if (now >= cur.at) return json({ error: "abgestuerzt", crash: cur.crash, now }, 409);
    let m = Math.min(crMultAt(now - cur.fly), cur.crash);
    if (b.auto >= 1.01 && b.auto <= m) m = b.auto;   // Auto-Auszahlung kam zuerst
    b.m = m; b.mt = now; await s.setJSON(bk, b);
    return json({ ok: true, m, now });
  }
  return json({ error: "aktion" }, 400);
}

// ================= Registrieren / Einloggen / Abmelden / Passwort ändern (/api/spielstand?auth=1) =================
async function authRoute(req) {
  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const store = getStore("spielstaende"), now = Date.now();
  const name = normName(body.name);
  if (!NAME_RE.test(name)) return json({ error: "name" }, 400);
  const key = encodeURIComponent(name);
  const rec = await store.get(key, { type: "json" });
  const pwOk = (p) => typeof p === "string" && p.length >= 1 && p.length <= 200;
  const newToken = () => randomBytes(24).toString("base64url");

  if (body.action === "logout") {
    if (rec && authed(req, rec)) { const h = sha(bearer(req)); rec.tokens = rec.tokens.filter((x) => x.h !== h); await store.setJSON(key, rec); }
    return json({ ok: true });
  }

  if (body.action === "register") {
    if (!pwOk(body.pw)) return json({ error: "passwort" }, 400);
    if (rec) return json({ error: "vergeben" }, 409);
    const state = body.state;
    const err = basicCheck(state) || (looksFresh(state) ? null : "kein_neuer_spielstand");
    if (err) return json({ error: err }, 422);
    state.sent = 0; state.recv = 0;
    const salt = randomBytes(16).toString("hex"), token = newToken();
    await store.setJSON(key, { state, rev: 1, savedAt: now, sentTotal: 0, recvTotal: 0, seen: [], created: now, potMark: 0, lossMark: ltGross(state),
      pw: { s: salt, h: await scrypt(body.pw, salt) }, tokens: [{ h: sha(token), t: now }] });
    return json({ ok: true, rev: 1, token });
  }

  if (body.action === "login") {
    if (!pwOk(body.pw) || !rec || !rec.pw) return json({ error: "falsch" }, 401);
    const fails = (rec.fails || []).filter((t) => now - t < 15 * 60_000);
    if (fails.length >= 10) return json({ error: "zu_viele_versuche" }, 429);   // gegen Durchprobieren
    if ((await scrypt(body.pw, rec.pw.s)) !== rec.pw.h) { rec.fails = fails.concat(now); await store.setJSON(key, rec); return json({ error: "falsch" }, 401); }
    if (rec.banned) return json({ error: "gesperrt" }, 403);
    const token = newToken();
    rec.fails = []; rec.tokens = (rec.tokens || []).concat({ h: sha(token), t: now }).slice(-10);
    await store.setJSON(key, rec);
    const st = rec.state || {};
    const pend = (await inbox(key)).filter((it) => !(rec.seen || []).includes(it.id));
    const add = pend.reduce((t, it) => t + num(it.a), 0);
    if (add > 0) { st.bal = Math.min(CAP, r2(num(st.bal) + add)); st.recv = r2(num(rec.recvTotal) + add); st.sent = r2(num(rec.sentTotal)); }
    return json({ ok: true, token, state: st, rev: rec.rev || 1, gifts: pend.map((it) => ({ id: it.id, f: it.f, a: it.a })) });
  }

  if (body.action === "password") {
    if (!rec || !authed(req, rec)) return json({ error: "login" }, 401);
    if (!pwOk(body.neu)) return json({ error: "passwort" }, 400);
    if (!pwOk(body.alt) || (await scrypt(body.alt, rec.pw.s)) !== rec.pw.h) return json({ error: "falsch" }, 401);
    const salt = randomBytes(16).toString("hex"), h = sha(bearer(req));
    rec.pw = { s: salt, h: await scrypt(body.neu, salt) };
    rec.tokens = rec.tokens.filter((x) => x.h === h);   // andere Geräte abmelden
    await store.setJSON(key, rec);
    return json({ ok: true });
  }
  return json({ error: "unbekannte_aktion" }, 400);
}

export default async (req) => {
  const url = new URL(req.url);
  await ensureEpoch();
  if (url.searchParams.has("auth")) return authRoute(req);
  if (url.searchParams.has("rennen")) return rennen(req, url);
  if (url.searchParams.has("lotto")) return lotto(req, url);
  if (url.searchParams.has("crash")) return crash(req, url);
  if (url.searchParams.has("wetten")) return wetten(req, url);
  if (url.searchParams.has("wirt")) return wirtRoute(req, url);
  if (url.searchParams.has("immo")) return immoRoute(req, url);
  if (url.searchParams.has("aktien")) return aktienRoute(req, url);
  // Leaderboard: Name, Guthaben, Sterne, Spielzeit aller (nicht gesperrten) Spieler, 30 s zwischengespeichert
  if (url.searchParams.has("board")) {
    const admin = getStore("admin");
    const cached = await admin.get("board", { type: "json" });
    if (cached && Date.now() - cached.t < 30_000) return json({ players: cached.players });
    const store = getStore("spielstaende");
    const { blobs } = await store.list();
    const players = [];
    const keys = blobs.slice(0, 500).map((b) => b.key);
    for (let i = 0; i < keys.length; i += 25) {
      const recs = await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: "json" }).catch(() => null)));
      recs.forEach((rec, j) => {
        if (!rec || rec.banned || !rec.state) return;
        players.push({ n: decodeURIComponent(keys[i + j]), b: Math.round(num(rec.state.bal) * 100) / 100, s: num(rec.state.stars), t: num(rec.state.playMs) });
      });
    }
    await admin.setJSON("board", { t: Date.now(), players });
    return json({ players });
  }
  // Öffentliche Nachricht an alle (vom Admin gesetzt)
  if (url.searchParams.has("msg")) {
    const m = await getStore("admin").get("message", { type: "json" });
    return json({ message: m && m.text ? m : null });
  }
  const name = (url.searchParams.get("name") || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const store = getStore("spielstaende");
  const key = encodeURIComponent(name);
  const stored = await store.get(key, { type: "json" });

  if (req.method === "GET") {
    if (stored && stored.banned) return json({ exists: true, banned: true, state: null, rev: 0 });
    if (!stored) return json({ exists: false, state: null, rev: 0 });
    if (!authed(req, stored)) return json({ error: "login" }, 401);
    // Noch nicht abgeholte Überweisungen schon mal anzeigen (gespeichert wird beim nächsten Speichern)
    const st = stored.state || {};
    const pend = (await inbox(key)).filter((it) => !(stored.seen || []).includes(it.id));
    const add = pend.reduce((t, it) => t + num(it.a), 0);
    if (add > 0) {
      st.bal = Math.min(CAP, r2(num(st.bal) + add));
      st.recv = r2(num(stored.recvTotal) + add);
      st.sent = r2(num(stored.sentTotal));
    }
    return json({ exists: true, state: st, rev: stored.rev || 1, gifts: pend.map((it) => ({ id: it.id, f: it.f, a: it.a })) });
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const state = body && body.state;
  const now = Date.now();

  if (body.create) return json({ error: "veraltet" }, 400);   // Accounts entstehen nur noch über ?auth=1 (mit Passwort)

  if (!stored) return json({ error: "unbekannt" }, 404);
  if (stored.banned) return json({ error: "gesperrt" }, 403);
  if (!authed(req, stored)) return json({ error: "login" }, 401);
  const curRev = stored.rev || 1;

  // Keine Prüfung auf andere Tabs/Geräte: der neueste Speicherstand gewinnt.
  // Ausnahme: Hat der Admin den Stand geändert, muss das Gerät diesen erst übernehmen.
  if (stored.dev === "admin" && body.rev !== curRev) return json({ error: "admin", state: stored.state, rev: curRev }, 409);
  if (basicCheck(state)) return json({ error: basicCheck(state), state: stored.state, rev: curRev }, 422);

  const oldS = stored.state || {};
  // Bisherige Summen (ältere Spielstände ohne Felder: aus dem Stand übernehmen)
  let sentTotal = stored.sentTotal ?? num(oldS.sent);
  let recvTotal = stored.recvTotal ?? num(oldS.recv);
  let seen = Array.isArray(stored.seen) ? stored.seen : [];

  // "Alles zurücksetzen": Summen zurück auf 0, Posteingang bleibt für später liegen
  // nur ein echtes "Alles zurücksetzen" vom Gerät (mit neuem Zeitstempel) setzt die Summen zurück
  const fresh = looksFresh(state) && num(state.resetAt) > num(oldS.resetAt) && !body.transfer;
  let gifts = [], used = [];
  if (fresh) { sentTotal = 0; recvTotal = 0; state.sent = 0; state.recv = 0; }
  else {
    // Neue Eingänge abholen
    const pend = (await inbox(key)).filter((it) => !seen.includes(it.id));
    for (const it of pend) { recvTotal = r2(recvTotal + num(it.a)); used.push(it.id); gifts.push({ id: it.id, f: it.f, a: it.a }); }
  }

  // Überweisung (das Gerät hat den Betrag schon abgezogen und "sent" erhöht)
  let tx = null;
  if (body.transfer && !fresh) {
    const to = String(body.transfer.to || "").trim().toLowerCase().replace(/\s+/g, " ");
    const amount = r2(num(body.transfer.amount));
    const fail = (e) => json({ error: e }, 400);
    if (!NAME_RE.test(to)) return fail("empfaenger_unbekannt");
    if (to === name) return fail("selbst");
    if (!(amount >= TX_MIN)) return fail("zu_wenig");
    if (rounds(oldS) < TX_MIN_ROUNDS) return fail("zu_neu");
    const recent = (stored.tx || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= TX_PER_HOUR) return fail("zu_oft");
    const toKey = encodeURIComponent(to);
    const target = await store.get(toKey, { type: "json" });
    if (!target) return fail("empfaenger_unbekannt");
    if (target.banned) return fail("empfaenger_gesperrt");
    const pendTo = (await inbox(toKey)).filter((it) => !(target.seen || []).includes(it.id)).reduce((t, it) => t + num(it.a), 0);
    if (num(target.state && target.state.bal) + pendTo + amount > CAP) return fail("empfaenger_voll");
    sentTotal = r2(sentTotal + amount);
    tx = { to, toKey, amount, recent };
  }

  const n = normalize(state, sentTotal, recvTotal);
  if (n.err) {
    if (tx) return json({ error: n.err }, 400);
    await logReject(name, n.err, oldS, state);
    return json({ error: n.err, state: oldS, rev: curRev }, 422);
  }

  // Wirtschaft: Ein- und Auszahlungen kennt nur der Server. Guthaben auf seinen Stand bringen.
  let W = null;
  try { W = await wirtGet(key); } catch {}
  if (W) {
    const nw = wirtNormalize(state, W);
    if (nw.err) { await logReject(name, nw.err, oldS, state); return json({ error: nw.err, state: oldS, rev: curRev }, 422); }
  }

  const elapsed = now - (stored.savedAt || 0);
  const err = plausible(oldS, state, elapsed);
  if (err) {
    await logReject(name, err, oldS, state);
    return json({ error: err, state: oldS, rev: curRev }, 422);
  }

  // Spielzeit kann nicht schneller wachsen als die echte Zeit (+1 Minute Puffer) und sinkt nie
  const oldPlay = num(oldS.playMs);
  // Einmalige Schätzung der alten Spielzeit beim ersten Update: höchstens 1 Minute pro bisheriger Runde
  const seed = !oldS.playSeed && state.playSeed ? rounds(oldS) * 60_000 : 0;
  state.playMs = Math.max(oldPlay, Math.min(num(state.playMs), oldPlay + elapsed + 60_000 + seed));

  seen = seen.concat(used).slice(-200);
  // Verluste in den Jackpot-Topf, Spielzeit für Gratis-Lose (Fehler dabei blockieren nie das Speichern)
  let lossMark = stored.lossMark;
  try { lossMark = await ltOnSave(key, oldS, state, stored, fresh, now); } catch {}
  const rec = { ...stored, state, lossMark, rev: curRev + 1, savedAt: now, sentTotal, recvTotal, seen, dev: undefined, tx: tx ? tx.recent.concat(now) : (stored.tx || []).filter((t) => now - t < 3_600_000) };
  await store.setJSON(key, rec);
  // Überweisung erst nach dem Abzug beim Absender in den Posteingang legen (eigener Eintrag, kein Überschreiben).
  // Klappt das nicht, wird der Abzug beim Absender wieder zurückgenommen.
  if (tx) {
    const id = `${tx.toKey}/${now}-${Math.random().toString(36).slice(2, 8)}`;
    try { await getStore("posteingang").setJSON(id, { f: name, a: tx.amount, t: now }); }
    catch {
      rec.sentTotal = r2(rec.sentTotal - tx.amount); rec.state.sent = rec.sentTotal; rec.state.bal = r2(rec.state.bal + tx.amount); rec.tx = tx.recent;
      await store.setJSON(key, rec);
      return json({ ok: true, rev: rec.rev, adj: r2(n.adj + tx.amount), sent: rec.state.sent, recv: state.recv, gifts, txFailed: true });
    }
  }
  // Abgeholte Einträge aufräumen (falls das fehlschlägt, schützt "seen" vor doppelter Gutschrift)
  if (used.length) { const box = getStore("posteingang"); for (const id of used) { try { await box.delete(id); } catch {} } }
  return json({ ok: true, rev: curRev + 1, adj: n.adj, sent: state.sent, recv: state.recv, win: W ? W.in : undefined, wout: W ? W.out : undefined, gifts, sentTx: tx ? { to: tx.to, amount: tx.amount } : null });
};

export const config = { path: "/api/spielstand" };
