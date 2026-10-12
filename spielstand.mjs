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
  for (const n of ["spielstaende", "posteingang", "stapel", "rennen", "lotto"]) await wipeStore(n);
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
  const dBonus = sumObj(newBonus, "sell") - sumObj(oldBonus, "sell");
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
    const expected = num(oldS.bal) + num(oldS.inPlay) + dNet + dBonus + dSell - dSpent + dRecv - dSent;
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
// Das Casino verdient nichts: Was Spieler unterm Strich verlieren, fließt in einen gemeinsamen Topf.
// Jeden Montag und Donnerstag um 20 Uhr (deutsche Zeit) wird gezogen: 1. Platz 50 %, 2. Platz 25 %, 3. Platz 10 %,
// die übrigen 15 % bleiben als Startgeld für die nächste Ziehung im Topf. Drei verschiedene Gewinner.
// Lose: 250 Coins, höchstens 20 gekaufte pro Ziehung. Dazu Gratis-Lose fürs Spielen: je 30 Minuten aktiv gespielt
// (6 Fünf-Minuten-Abschnitte mit mindestens einer Runde) ein Gratis-Los, höchstens 4 pro Ziehung.
// Store "lotto": a/<ziehung>/<name> = {c: Verluste in den Topf, s: aktive Abschnitte} · b/<ziehung>/<name> = {n: gekaufte Lose}
//                r/<ziehung> = Ergebnis · state = {last: zuletzt ausgeführte Ziehung} · cache = Topf (kurz zwischengespeichert)
// Gezogen wird beim ersten Aufruf nach 20 Uhr. Der Zufall kommt aus dem Server-Geheimnis + Ziehungszeit:
// derselbe Aufruf zweimal gleichzeitig ergibt exakt dieselben Gewinner und dieselben Posteingangs-Einträge (keine Doppelzahlung).
const LT_PRICE = 250, LT_MAX = 20, LT_FREE_MAX = 4, LT_SLOT = 300_000, LT_SLOTS_PER_FREE = 6;
const LT_SHARES = [0.5, 0.25, 0.1];
const LT_SKIP = new Set(["lotto", "wetten"]);   // Lose zählen direkt, Wetten sind Spieler gegen Spieler
const ltLoss = (st) => -Object.entries((st && st.games) || {}).reduce((s, [k, g]) => (LT_SKIP.has(k) ? s : s + num(g && g.p) - num(g && g.w)), 0);
const ltRounds = (st) => Object.entries((st && st.games) || {}).reduce((s, [k, g]) => (k === "lotto" ? s : s + num(g && g.n)), 0);
const ltFree = (slots) => Math.min(LT_FREE_MAX, Math.floor(num(slots) / LT_SLOTS_PER_FREE));

// ---- Ziehungstermine: Montag und Donnerstag, 20:00 Uhr in Berlin (Sommer- und Winterzeit)
const BERLIN = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
function berlinParts(ts) {
  const p = {}; for (const x of BERLIN.formatToParts(new Date(ts))) p[x.type] = +x.value || 0;
  return p;
}
function berlinOffset(ts) { const p = berlinParts(ts); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; }
function drawAt(y, m, d) { const guess = Date.UTC(y, m, d, 20); return guess - berlinOffset(guess - 7_200_000); }
function ltDays(ts, from, to) {   // Ziehungen von Tag "from" bis "to" (relativ zum Berliner Datum von ts)
  const p = berlinParts(ts), out = [];
  for (let i = from; i <= to; i++) {
    const wd = new Date(Date.UTC(p.year, p.month - 1, p.day + i)).getUTCDay();
    if (wd === 1 || wd === 4) out.push(drawAt(p.year, p.month - 1, p.day + i));
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
const ltCarryIn = async (D) => { const r = await getStore("lotto").get(`r/${prevDraw(D - 1)}`, { type: "json" }).catch(() => null); return r ? num(r.carry) : 0; };
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
// Fällige Ziehungen nachholen (beim ersten Aufruf nach 20 Uhr)
async function ltTick(now) {
  const s = getStore("lotto");
  let st = await s.get("state", { type: "json" }).catch(() => null);
  if (!st || !st.last) { st = { last: prevDraw(now) }; await s.setJSON("state", st); return; }
  for (let k = 0; k < 60; k++) {
    const D = nextDraw(st.last);
    if (!D || D > now) break;
    await ltDraw(D);
    st = { last: D }; await s.setJSON("state", st);
    try { await s.delete("cache"); } catch {}
  }
}
// Beim Speichern: neue Verluste in den Topf, aktive Abschnitte für Gratis-Lose merken. Gibt die neue Verlust-Marke zurück.
// Marke = höchster bisheriger Gesamtverlust: Wer verliert und es wieder zurückgewinnt, zahlt nicht doppelt ein.
async function ltOnSave(key, oldS, state, stored, fresh, now) {
  let mark = fresh ? 0 : stored.potMark;
  if (typeof mark !== "number") mark = Math.max(0, ltLoss(oldS));
  const older = ltRounds(state) < ltRounds(oldS);         // Stand aus einem älteren Tab: nichts zählen
  const loss = ltLoss(state);
  let add = 0;
  if (!older && loss > mark + 0.004) { add = r2(loss - mark); mark = loss; }
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
      }
    } catch { return typeof stored.potMark === "number" ? stored.potMark : mark - add; }
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
      out.mine = { n: b ? Math.round(num(b.n)) : 0, t: b ? num(b.t) : 0, f: ltFree(slots), s: slots, c: a ? num(a.c) : 0 };
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
    await store.setJSON(key, { state, rev: 1, savedAt: now, sentTotal: 0, recvTotal: 0, seen: [], created: now, potMark: 0,
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
  if (url.searchParams.has("wetten")) return wetten(req, url);
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
  let potMark = stored.potMark;
  try { potMark = await ltOnSave(key, oldS, state, stored, fresh, now); } catch {}
  const rec = { ...stored, state, potMark, rev: curRev + 1, savedAt: now, sentTotal, recvTotal, seen, dev: undefined, tx: tx ? tx.recent.concat(now) : (stored.tx || []).filter((t) => now - t < 3_600_000) };
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
  return json({ ok: true, rev: curRev + 1, adj: n.adj, sent: state.sent, recv: state.recv, gifts, sentTx: tx ? { to: tx.to, amount: tx.amount } : null });
};

export const config = { path: "/api/spielstand" };
