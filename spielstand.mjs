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
const MAXWIN = 100_000;          // Höchstgewinn pro Runde
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
  if (dNet > Math.max(dRounds, 1) * MAXWIN + 1) return "gewinn_zu_hoch";

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

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.has("rennen")) return rennen(req, url);
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
