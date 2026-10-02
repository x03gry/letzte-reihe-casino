// Letzte Reihe Casino – speichert und lädt Spielstände pro Login-Name (Netlify Blobs).
// Jeder Spielstand hat eine Versionsnummer (rev). Wer mit einer alten Version speichern will,
// bekommt den aktuellen Stand zurück (z. B. wenn auf einem anderen Gerät weitergespielt wurde).
// Außerdem prüft der Server jede Änderung auf unmögliche Sprünge (einfacher Schummelschutz).
import { getStore } from "@netlify/blobs";

const NAME_RE = /^[a-z0-9äöüß._ -]{3,20}$/;
const CAP = 10_000_000;          // Vermögensgrenze
const MAXWIN = 100_000;          // Höchstgewinn pro Runde
const RESTART_CD = 3_600_000;    // Neustart nur alle 60 Minuten
const BONUS_PER_SAVE = 15_000;   // Boni, die zwischen zwei Speicherungen höchstens dazukommen können
const ITEM_PRICE = { kette: 5000, uhr: 25000, auto: 250000, villa: 1000000, yacht: 2500000, jet: 5000000, insel: 10000000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const sumObj = (o, skip) => Object.entries(o || {}).reduce((s, [k, v]) => (k === skip ? s : s + num(v)), 0);
const rounds = (st) => Object.values(st.games || {}).reduce((s, g) => s + num(g && g.n), 0);
const gameNet = (st) => Object.values(st.games || {}).reduce((s, g) => s + num(g && g.p) - num(g && g.w), 0);
const looksFresh = (st) => rounds(st) === 0 && num(st.bal) <= 1000 && num(st.stars) === 0;

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
  if (dRounds < 0) return "runden";
  if (dRounds > 40 + (elapsedMs / 1000) * 10) return "zu_viele_runden";

  const dStars = num(newS.stars) - num(oldS.stars);
  if (dStars < 0 || dStars > 1) return "sterne";
  if (dStars === 1 && num(oldS.bal) < CAP * 0.99) return "stern_ohne_10mio";

  if (num(newS.restarts) > num(oldS.restarts)) {
    if (num(newS.restarts) - num(oldS.restarts) > 1) return "neustarts";
    if (num(newS.lastRestart) - num(oldS.lastRestart) < RESTART_CD - 60_000) return "neustart_zu_frueh";
  }

  const dNet = gameNet(newS) - gameNet(oldS);
  if (dNet > dRounds * MAXWIN + 1) return "gewinn_zu_hoch";

  const oldBonus = oldS.bonus || {}, newBonus = newS.bonus || {};
  const dBonus = sumObj(newBonus, "sell") - sumObj(oldBonus, "sell");
  if (dBonus < -1 || dBonus > BONUS_PER_SAVE) return "bonus";

  // Verkäufe nur so viel, wie verkaufte Gegenstände wert waren
  const dSell = num(newBonus.sell) - num(oldBonus.sell);
  const oldItems = (oldS.owned && oldS.owned.items) || {}, newItems = (newS.owned && newS.owned.items) || {};
  let sold = 0;
  for (const k of Object.keys(oldItems)) if (!newItems[k]) sold += (ITEM_PRICE[k] || 0) / 2;
  if (dSell > sold + 1) return "verkauf";

  const dSpent = num(newS.spent) - num(oldS.spent);
  if (dSpent < -1) return "ausgaben";

  // Guthaben darf nicht stärker steigen, als Spiele, Boni und Verkäufe erklären
  if (dStars === 0) {
    // inPlay = Einsätze laufender Runden (schon abgezogen, noch nicht ausgewertet)
    const expected = num(oldS.bal) + num(oldS.inPlay) + dNet + dBonus + dSell - dSpent;
    if (num(newS.inPlay) < 0) return "einsatz";
    if (num(newS.bal) + num(newS.inPlay) > expected + 1) return "guthaben_unerklaerlich";
  }
  return null;
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

export default async (req) => {
  const url = new URL(req.url);
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
    return json({ exists: !!stored, state: stored ? stored.state : null, rev: stored ? stored.rev || 1 : 0 });
  }

  if (req.method !== "POST") return json({ error: "methode" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "kaputt" }, 400); }
  const state = body && body.state;
  const now = Date.now();
  // Zufällige Kennung pro geöffneter Seite: so erkennt der Server, ob wirklich ein anderes Gerät gespeichert hat
  const dev = typeof body.dev === "string" ? body.dev.slice(0, 40) : "";

  if (body.create) {
    if (stored) return json({ error: "vergeben" }, 409);
    const err = basicCheck(state) || (looksFresh(state) ? null : "kein_neuer_spielstand");
    if (err) return json({ error: err }, 422);
    await store.setJSON(key, { state, rev: 1, savedAt: now, dev });
    return json({ ok: true, rev: 1 });
  }

  if (!stored) return json({ error: "unbekannt" }, 404);
  if (stored.banned) return json({ error: "gesperrt" }, 403);
  const curRev = stored.rev || 1;

  // Hat dieselbe Seite zuletzt gespeichert, nur die Antwort ging verloren (Handy gesperrt, WLAN weg),
  // ist das kein Konflikt. Nur wenn ein anderes Gerät/Tab oder der Admin gespeichert hat, gilt der Server-Stand.
  const ownLostReply = dev && stored.dev === dev && typeof body.rev === "number" && body.rev < curRev;
  if (body.rev !== curRev && !ownLostReply) return json({ error: "konflikt", state: stored.state, rev: curRev }, 409);

  const err = plausible(stored.state, state, now - (stored.savedAt || 0));
  if (err) {
    await logReject(name, err, stored.state, state);
    return json({ error: err, state: stored.state, rev: curRev }, 422);
  }

  await store.setJSON(key, { state, rev: curRev + 1, savedAt: now, dev });
  return json({ ok: true, rev: curRev + 1 });
};

export const config = { path: "/api/spielstand" };
