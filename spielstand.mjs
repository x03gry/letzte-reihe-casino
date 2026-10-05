// Letzte Reihe Casino – speichert und lädt Spielstände pro Login-Name (Netlify Blobs).
// Jeder Spielstand hat eine Versionsnummer (rev). Wer mit einer alten Version speichern will,
// bekommt den aktuellen Stand zurück (z. B. wenn auf einem anderen Gerät weitergespielt wurde).
// Außerdem prüft der Server jede Änderung auf unmögliche Sprünge (einfacher Schummelschutz).
import { getStore as rawStore } from "@netlify/blobs";
import { createHmac, randomBytes } from "node:crypto";

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

const NAME_RE = /^[a-z0-9äöüß._ -]{3,20}$/;
const CAP = 10_000_000;          // Vermögensgrenze
const SK_MAXBAL = 100_000;      // Chip-Stapler nur unter 100.000 Coins Guthaben
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

// ================= Chip-Stapler (/api/spielstand?stapel=1) =================
// Jede Runde bekommt einen zufälligen Seed. Am Ende spielt der Server die Tipp-Zeiten mit denselben Regeln nach (STK, identisch zur Seite).
// Was unter Höhe 15 verloren geht, wandern in den Jackpot. Wer 75 Chips stapelt, bekommt ihn (über den Posteingang).
// ---- Chip-Stapler: gemeinsame Regeln (Seite und Server identisch) ----
// Gleicher Seed + gleiche Tipp-Zeiten (ms pro Chip) = exakt gleiches Ergebnis. So kann der Server jede Runde nachspielen.
const STK = (() => {
  const R0 = 100, AMP = 220, TOL = 7, GROW = 5, MIN_MS = 350, MAXH = 75; // bei 75 Chips: Jackpot, Runde endet
  const V0 = 160, VS = 6, VQ = 0.45, VMAX = 1000; // langsam starten, dann immer schneller
  // Auszahlung beim Daneben-Fallen: ab Höhe h gilt Faktor m (bis zur nächsten Stufe). Bei 75 zusätzlich der Jackpot.
  const STEPS = [[5, 0.1], [8, 0.2], [10, 0.3], [12, 0.45], [14, 0.6], [16, 0.75], [18, 0.9], [20, 1], [22, 1.2], [24, 1.4], [26, 1.6], [28, 1.8], [30, 2], [35, 3], [40, 4], [45, 6], [50, 8], [60, 9], [75, 10]];
  const POT_BELOW = 15;
  const mult = (h) => { let m = 0; for (const [s, v] of STEPS) if (h >= s) m = v; return m; };
  const nextStep = (h) => STEPS.find(([s]) => s > h) || null;
  function rngOf(seed) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762; const str = "stapel|" + seed;
    for (let i = 0, k; i < str.length; i++) { k = str.charCodeAt(i); h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233); h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179); }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233); h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1; let a = h1 >>> 0, b = h2 >>> 0, c = h3 >>> 0, d = h4 >>> 0;
    const r = () => { a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0; return t >>> 0; };
    for (let i = 0; i < 15; i++) r(); return r;
  }
  // Je Chip (Index = schon gestapelte Höhe): Tempo und Startseite. Ab Höhe 30 schwankt das Tempo um ±10 %.
  function plan(seed) {
    const r = rngOf(seed), L = [];
    for (let k = 0; k < MAXH; k++) {
      const side = r() % 2, jit = 90 + (r() % 21);
      let v = Math.min(VMAX, V0 + k * VS + k * k * VQ); if (k >= 30) v = (v * jit) / 100;
      L.push({ v, side });
    }
    return L;
  }
  // Versatz des gleitenden Chips zur Turmmitte nach t ms (pendelt zwischen -AMP und +AMP)
  function off(l, t) {
    const p = ((l.v * t) / 1000) % (4 * AMP), o = p < 2 * AMP ? -AMP + p : 3 * AMP - p;
    return l.side ? -o : o;
  }
  const fresh = () => ({ r: R0, combo: 0, h: 0, perf: 0, best: 0 });
  // Chip absetzen. kind: "perfect" | "cut" | "fall"
  function step(st, l, t) {
    const d = off(l, t), ad = Math.abs(d);
    if (ad <= TOL) {
      const combo = st.combo + 1, grew = combo >= 3 && st.r < R0;
      return { kind: "perfect", d, grew, prevR: st.r, st: { r: grew ? Math.min(R0, st.r + GROW) : st.r, combo, h: st.h + 1, perf: st.perf + 1, best: Math.max(st.best, combo) } };
    }
    if (ad >= 2 * st.r - 2) return { kind: "fall", d, st: { ...st, combo: 0 } };
    return { kind: "cut", d, prevR: st.r, st: { r: st.r - ad / 2, combo: 0, h: st.h + 1, perf: st.perf, best: st.best } };
  }
  // Ganze Runde nachspielen (Server)
  function replay(seed, taps) {
    const L = plan(seed); let st = fresh(), fell = false;
    for (let i = 0; i < taps.length; i++) {
      const t = taps[i]; if (!(Number.isInteger(t) && t >= MIN_MS && t <= 600000) || st.h >= MAXH) return { bad: true };
      const s = step(st, L[st.h], t); st = s.st; if (s.kind === "fall") { fell = true; if (i !== taps.length - 1) return { bad: true }; break; }
    }
    return { h: st.h, fell, perf: st.perf };
  }
  return { R0, AMP, TOL, MIN_MS, MAXH, STEPS, POT_BELOW, mult, nextStep, plan, off, fresh, step, replay };
})();

async function stapel(req, url) {
  const admin = getStore("admin"), now = Date.now();
  const potRec = async () => (await admin.get("stapelPot", { type: "json" })) || { a: 0, last: null };
  if (req.method === "GET") { const p = await potRec(); return json({ pot: r2(num(p.a)), last: p.last || null }); }
  if (req.method !== "POST") return json({ error: "methode" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) return json({ error: "ungueltiger_name" }, 400);
  const key = encodeURIComponent(name);
  const acc = await getStore("spielstaende").get(key, { type: "json" });
  if (!acc) return json({ error: "unbekannt" }, 404);
  if (acc.banned) return json({ error: "gesperrt" }, 403);
  const st = acc.state || {}, rounds = getStore("stapel");

  if (body.action === "start") {
    const bet = r2(num(body.bet));
    // großzügig, weil der gespeicherte Stand ein paar Sekunden alt sein kann
    if (!(bet > 0) || bet > (num(st.bal) + num(st.inPlay)) * 0.5 + 10) return json({ error: "einsatz" }, 400);
    // ab 100.000 Coins gesperrt (gespeicherter Stand vor oder direkt nach dem Einsatz)
    if (num(st.bal) >= SK_MAXBAL) return json({ error: "zu_reich" }, 403);
    const prev = await rounds.get(key, { type: "json" });
    if (prev && now - prev.t < 700) return json({ error: "zu_schnell" }, 429);
    const r = { id: randomBytes(8).toString("hex"), seed: randomBytes(16).toString("hex"), bet, t: now };
    await rounds.setJSON(key, r);
    const p = await potRec();
    return json({ id: r.id, seed: r.seed, pot: r2(num(p.a)), last: p.last || null });
  }

  if (body.action === "end") {
    const r = await rounds.get(key, { type: "json" });
    const p = await potRec();
    if (!r || r.id !== body.id) return json({ error: "runde", pot: r2(num(p.a)), last: p.last || null }, 409);
    await rounds.delete(key);
    const taps = Array.isArray(body.taps) ? body.taps.slice(0, STK.MAXH + 1) : [];
    const res = STK.replay(r.seed, taps);
    const played = taps.reduce((s, t) => s + (Number(t) || 0), 0);
    // unmöglich: kaputte Tipp-Zeiten, mehr Spielzeit als echte Zeit, oder Ende ohne Fallen und ohne Ziel
    const bad = res.bad || played > now - r.t + 5000 || (!res.fell && res.h < STK.MAXH);
    if (bad) { await logReject(name, "stapel", st, st); return json({ error: "ungueltig", pot: r2(num(p.a)), last: p.last || null }, 422); }
    const m = STK.mult(res.h), pay = r2(r.bet * m);
    if (res.h < STK.POT_BELOW) p.a = r2(num(p.a) + Math.max(0, r.bet - pay));
    let jackpot = 0;
    if (!res.fell && res.h >= STK.MAXH && num(p.a) > 0) {
      // nicht über 10 Mio.: Rest bleibt im Topf
      const pend = (await inbox(key)).filter((it) => !(acc.seen || []).includes(it.id)).reduce((t, it) => t + num(it.a), 0);
      jackpot = r2(Math.max(0, Math.min(num(p.a), CAP - num(st.bal) - pay - pend)));
      if (jackpot > 0) {
        await getStore("posteingang").setJSON(`${key}/${now}-jackpot`, { f: "Jackpot", a: jackpot, t: now });
        p.a = r2(num(p.a) - jackpot); p.last = { n: name, a: jackpot, t: now };
      }
    }
    await admin.setJSON("stapelPot", p);
    return json({ ok: true, h: res.h, fell: res.fell, pot: r2(num(p.a)), last: p.last || null, jackpot });
  }
  return json({ error: "aktion" }, 400);
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.has("rennen")) return rennen(req, url);
  if (url.searchParams.has("stapel")) return stapel(req, url);
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

  if (body.create) {
    if (stored) return json({ error: "vergeben" }, 409);
    const err = basicCheck(state) || (looksFresh(state) ? null : "kein_neuer_spielstand");
    if (err) return json({ error: err }, 422);
    state.sent = 0; state.recv = 0;
    await store.setJSON(key, { state, rev: 1, savedAt: now, sentTotal: 0, recvTotal: 0, seen: [] });
    return json({ ok: true, rev: 1 });
  }

  if (!stored) return json({ error: "unbekannt" }, 404);
  if (stored.banned) return json({ error: "gesperrt" }, 403);
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
  const rec = { state, rev: curRev + 1, savedAt: now, sentTotal, recvTotal, seen, tx: tx ? tx.recent.concat(now) : (stored.tx || []).filter((t) => now - t < 3_600_000) };
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
