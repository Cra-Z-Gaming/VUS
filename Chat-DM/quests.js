(function () {
"use strict";
/* ══════════════════════════════════════════════════════════
   QUESTS  (daily + weekly, login reward, set bonuses, game quests, welcome bundle)
   Everything about a quest is kept in the same coins/<id> record as the balance, and the database rules (vus-chat-rules.json)
   check every step, so nobody can give themselves a reward:
     - messages: chat.js adds 1 to qdm (today) and qwm (this week) in the same write that pays the message coin.
     - time: a heartbeat (qss = session start, qhb = last beat) is written every 40 s. A gap of more than 2 minutes starts a new
       session. Once a session has really lasted 20 minutes it is recorded in qsd (the day it was finished).
     - crates: qcd / qcw remember how many crates you had opened when the day / week began; progress = opened now - that.
     - games: when a 1v1 game you played ends properly (a win, a loss or a draw: not a leave, a disconnect or a refund) it is counted ONCE.
       qgl = the game that was counted, qgt = when it started (each counted game must start later than the last one), qgd / qgw = games today / this week.
       The rules look the game up (pg/<id> for Direct games, games/<id> for Secure ones) and check you were one of the two players.
     - login reward: claimed once per day, the amount depends on the weekday (see LOGIN below).
     - set bonus: 100 coins when every daily quest is claimed, 300 when every weekly quest is claimed.
     - welcome bundle: a brand new account gets 50 coins once (crates are switched off for now, see STARTER below).
     - claiming: ONE write adds the reward to n (and crates to gc) and sets qp/<quest> = the period key. The rules only accept it when
       the progress is really there, the amounts are exactly the reward, and the quest was not claimed in this period yet.
   Resets: daily at 12:00 PM Eastern (17:00 UTC), weekly on Saturday at 12:00 PM Eastern (17:00 UTC). Same moment for everyone.
   If these numbers or the rewards change, change them in vus-chat-rules.json too (the rules have their own copy).
   ══════════════════════════════════════════════════════════ */
const DAY_MS = 86400000, WEEK_MS = 604800000, DAY_OFFSET = 61200000, WEEK_OFFSET = 234000000;
const SESSION_MS = 20 * 60 * 1000;
const BEAT_MS = 40 * 1000, BEAT_MIN_GAP = 20 * 1000, SESSION_GAP_MS = 120 * 1000;

// Login reward by weekday (index 0 = Sunday ... 6 = Saturday). The "day" runs from 12:00 PM Eastern to 12:00 PM Eastern, like the daily quests.
const LOGIN = [200, 100, 25, 25, 50, 100, 150];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHOW_ORDER = [1, 2, 3, 4, 5, 6, 0];          // the strip in the window starts on Monday
// Welcome bundle: only accounts created on or after this moment can get it (the database also only allows it once per account and once per browser).
const STARTER_SINCE = Date.UTC(2026, 10, 21), STARTER_COINS = 50, STARTER_CRATES = 0;   // gift crates are OFF: the database rules have no gift-crate (gc) field yet. Add "gc" to vus-chat-rules.json before raising this or adding crates: to a quest.

// kind: msg = messages sent, time = minutes in one session, crate = crates opened (selling a crate doesn't count), game = finished 1v1 games,
//       login = the daily login reward, set = every quest of the period claimed
const QUESTS = [
  { id: "q-dlogin", period: "d", kind: "login", icon: "📅", name: "Daily Login",      desc: "Come by and say hi", goal: 1 },
  { id: "q-dmsg",   period: "d", kind: "msg",   icon: "💬", name: "Chatterbox",       desc: "Send 50 messages",                        goal: 50,         reward: 150 },
  { id: "q-dtime",  period: "d", kind: "time",  icon: "⏱️", name: "Stick Around",     desc: "Stay on VUS for 20 minutes in one session", goal: SESSION_MS, reward: 100 },
  { id: "q-dcrate", period: "d", kind: "crate", icon: "📦", name: "Crate Cracker",    desc: "Open 2 crates",                           goal: 2,          reward: 75 },
  { id: "q-dgame",  period: "d", kind: "game",  icon: "🎮", name: "Friendly Duel",    desc: "Finish 2 games against other players",    goal: 2,          reward: 75 },
  { id: "q-dset",   period: "d", kind: "set",   icon: "✨", name: "Daily Sweep",      desc: "Claim every daily quest",                 members: ["q-dmsg", "q-dtime", "q-dcrate", "q-dgame"], reward: 100 },
  { id: "q-wcrate", period: "w", kind: "crate", icon: "🎁", name: "Crate Hoarder",    desc: "Open 10 crates",                          goal: 10,         reward: 250 },
  { id: "q-wmsg",   period: "w", kind: "msg",   icon: "🔥", name: "Marathon Chatter", desc: "Send 500 messages",                       goal: 500,        reward: 400 },
  { id: "q-wgame",  period: "w", kind: "game",  icon: "🏆", name: "Arena Regular",    desc: "Finish 5 games against other players",    goal: 5,          reward: 200 },
  { id: "q-wset",   period: "w", kind: "set",   icon: "👑", name: "Weekly Sweep",     desc: "Claim every weekly quest",                members: ["q-wcrate", "q-wmsg", "q-wgame"], reward: 300 }
];
QUESTS.forEach(q => { if (q.kind === "set") q.goal = q.members.length; });
const DAILY = QUESTS.filter(q => q.period === "d"), WEEKLY = QUESTS.filter(q => q.period === "w");

const chat = () => window.VUS_CHAT || null;
const dbOf = () => { try { return chat() && chat().db ? chat().db() : null; } catch (e) { return null; } };
const myId = () => { try { return chat() && chat().myId ? String(chat().myId() || "") : ""; } catch (e) { return ""; } };
const nowMs = () => { try { return chat().srvNow(); } catch (e) { return Date.now(); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const dayKey = t => Math.floor((t - DAY_OFFSET) / DAY_MS);
const weekKey = t => Math.floor((t - WEEK_OFFSET) / WEEK_MS);
const dayStart = t => dayKey(t) * DAY_MS + DAY_OFFSET;
const periodKey = (q, t) => q.period === "d" ? dayKey(t) : weekKey(t);
const periodEnd = (q, t) => q.period === "d" ? (dayKey(t) + 1) * DAY_MS + DAY_OFFSET : (weekKey(t) + 1) * WEEK_MS + WEEK_OFFSET;
const weekdayOf = k => (k + 4) % 7;                 // day 0 (1 Jan 1970) was a Thursday; the period's weekday is the weekday of the date it starts on
const loginAmount = t => LOGIN[weekdayOf(dayKey(t))];
function coinsOf(q, t) { return q.kind === "login" ? loginAmount(t) : q.reward; }
function fmtLeft(ms) {
  ms = Math.max(0, ms);
  const d = Math.floor(ms / DAY_MS), h = Math.floor(ms % DAY_MS / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  if (d >= 1) return d + "d " + h + "h";
  if (h >= 1) return h + "h " + m + "m";
  return m + "m " + String(s).padStart(2, "0") + "s";
}
const fmtClock = ms => Math.floor(ms / 60000) + ":" + String(Math.floor(ms % 60000 / 1000)).padStart(2, "0");
const isDenied = e => !!e && (e.code === "PERMISSION_DENIED" || /permission_denied|permission denied/i.test(String(e.message || e)));
function rewardText(q, t) { const c = coinsOf(q, t); return "🪙 " + c + (q.crates ? " + 📦 " + q.crates : ""); }

/* ── live data: this account's coins record and crates-opened counter ── */
let rec = null, crateO = null, watchId = "", coinsRef = null, crateRef = null;
function stopWatch() {
  if (coinsRef) { try { coinsRef.off(); } catch (e) {} coinsRef = null; }
  if (crateRef) { try { crateRef.off(); } catch (e) {} crateRef = null; }
  rec = null; crateO = null;
}
function ensureWatch() {
  const id = myId(), db = dbOf();
  if (id === watchId && (!id || coinsRef)) return;
  stopWatch(); watchId = ""; starterSt.id = ""; starterSt.fails = 0; welcome = false;
  if (!id || !db) { refreshAll(); return; }
  watchId = id;
  coinsRef = db.ref("coins/" + id);
  coinsRef.on("value", s => { rec = s.val() || {}; onData(); }, () => { rec = {}; onData(); });
  crateRef = db.ref("crateClaims/" + id + "/o");
  crateRef.on("value", s => { crateO = Number(s.val()) || 0; onData(); }, () => { crateO = 0; onData(); });
}

/* progress of one quest, from a coins record r, the crates-opened counter o and the time t */
function progressOf(q, r, o, t) {
  r = r || {};
  const key = periodKey(q, t);
  const claimed = !!(r.qp && Number(r.qp[q.id]) === key);
  let val = 0;
  if (q.kind === "msg") {
    if (q.period === "d") val = Number(r.qdk) === key ? (Number(r.qdm) || 0) : 0;
    else val = Number(r.qwk) === key ? (Number(r.qwm) || 0) : 0;
  } else if (q.kind === "crate") {
    const bk = q.period === "d" ? r.qcdk : r.qcwk, bv = q.period === "d" ? r.qcd : r.qcw;
    if (Number(bk) === key && bv !== undefined && o !== null) val = Math.max(0, o - (Number(r.sc) || 0) - Number(bv));
  } else if (q.kind === "time") {
    if (Number(r.qsd) === key) val = q.goal;
    else if (r.qss && r.qhb && Number(r.qss) >= dayStart(t) && t - Number(r.qhb) <= SESSION_GAP_MS + 30000) val = Math.min(q.goal - 1000, Math.max(0, t - Number(r.qss)));   // live, but "done" only once the database has it
  } else if (q.kind === "game") {
    if (q.period === "d") val = Number(r.qgdk) === key ? (Number(r.qgd) || 0) : 0;
    else val = Number(r.qgwk) === key ? (Number(r.qgw) || 0) : 0;
  } else if (q.kind === "login") {
    val = 1;
  } else if (q.kind === "set") {
    val = q.members.filter(id => r.qp && Number(r.qp[id]) === key).length;
  }
  val = Math.min(val, q.goal);
  return { val, goal: q.goal, done: val >= q.goal, claimed };
}
const progress = q => progressOf(q, rec, crateO, nowMs());
const anyReady = () => !!rec && rec.n !== undefined && QUESTS.some(q => { const p = progress(q); return p.done && !p.claimed; });

/* ── tracking writes: crate baselines, "20 minutes done", and the heartbeat ── */
const TS = () => firebase.database.ServerValue.TIMESTAMP;
function backoff(st) { return Math.min(15000 * Math.pow(2, st.fails), 10 * 60 * 1000); }   // 15 s, 30 s, 1 min ... 10 min (also keeps old database rules from being hammered)
const trackSt = { busy: false, fails: 0, at: 0 }, beatSt = { busy: false, fails: 0, at: 0 };
async function maybeTrack() {
  const db = dbOf();
  if (trackSt.busy || !db || !watchId || !rec || rec.n === undefined) return;
  const t = nowMs();
  if (trackSt.fails && t - trackSt.at < backoff(trackSt)) return;
  const dk = dayKey(t), wk = weekKey(t), upd = {};
  if (Number(rec.qsd) !== dk && rec.qss && rec.qhb && Number(rec.qss) >= dayStart(t) && Number(rec.qhb) - Number(rec.qss) >= SESSION_MS) upd.qsd = dk;
  const needD = Number(rec.qcdk) !== dk || rec.qcd === undefined, needW = Number(rec.qcwk) !== wk || rec.qcw === undefined;
  trackSt.busy = true;
  try {
    if (needD || needW) {
      const o = Number((await db.ref("crateClaims/" + watchId + "/o").get()).val()) || 0, opened = o - (Number(rec.sc) || 0);
      if (needD) { upd.qcdk = dk; upd.qcd = opened; }
      if (needW) { upd.qcwk = wk; upd.qcw = opened; }
    }
    if (Object.keys(upd).length) await db.ref("coins/" + watchId).update(upd);
    trackSt.fails = 0;
  } catch (e) { trackSt.fails++; trackSt.at = nowMs(); }
  trackSt.busy = false;
}
async function beat() {
  const db = dbOf();
  if (beatSt.busy || !db || !watchId || !rec || rec.n === undefined) return;
  const t = nowMs();
  if (beatSt.fails && t - beatSt.at < backoff(beatSt)) return;
  if (Number(rec.qsd) === dayKey(t)) return;   // today's 20 minutes are already recorded: no more beats until the next day
  const last = Number(rec.qhb) || 0, gap = t - last;
  let upd;
  if (rec.qss && last && gap >= BEAT_MIN_GAP && gap <= SESSION_GAP_MS) upd = { qhb: TS() };      // same session carries on
  else if (!rec.qss || !last || gap > SESSION_GAP_MS) upd = { qss: TS(), qhb: TS() };            // first beat, or a gap: a new session starts
  else return;                                                                                   // another tab beat a moment ago
  beatSt.busy = true;
  try { await db.ref("coins/" + watchId).update(upd); beatSt.fails = 0; }
  catch (e) { beatSt.fails++; beatSt.at = nowMs(); }
  beatSt.busy = false;
}

/* ── welcome bundle: 50 coins + 5 crates, once, for a brand new account ──
   Only for an account that has no coins record yet and was created on/after STARTER_SINCE. The rules allow exactly this one write,
   only while the record doesn't exist, and only once per browser (starterDevices/<browser id> = the account that took it). */
const starterSt = { busy: false, fails: 0, at: 0, id: "" };
let welcome = false, toastEl = null;
function toast(text) {
  if (toastEl) { toastEl.remove(); toastEl = null; }
  const t = el("div", "quest-toast", text); document.body.appendChild(t); toastEl = t;
  setTimeout(() => { if (toastEl === t) { t.remove(); toastEl = null; } }, 9000);
  t.addEventListener("click", () => { t.remove(); if (toastEl === t) toastEl = null; });
}
async function maybeStarter() {
  const db = dbOf(), id = watchId;
  if (starterSt.busy || starterSt.id === id || !db || !id || rec === null) return;
  if (rec.n !== undefined || rec.sb) { starterSt.id = id; return; }              // has a coins record already: not a new account (or already got it)
  const t = Date.now();
  if (starterSt.fails && t - starterSt.at < backoff(starterSt)) return;
  starterSt.busy = true;
  try {
    const dm = window.VUS_DM;
    const created = dm && dm.getAccountCreatedAt ? Number(await dm.getAccountCreatedAt(id)) || 0 : 0;
    if (!created) throw new Error("account age unknown");                        // try again in a moment
    if (created < STARTER_SINCE) { starterSt.id = id; starterSt.busy = false; return; }
    const hash = await chat()._deviceHash();
    if (!/^[a-f0-9]{32}$/.test(hash || "")) throw new Error("no browser id");
    const dref = db.ref("starterDevices/" + hash), cur = (await dref.get()).val();
    if (cur && String(cur) !== id) { starterSt.id = id; starterSt.busy = false; return; }   // this browser already took a welcome bundle for another account
    if (!cur) await dref.set(id);
    if (myId() !== id) { starterSt.busy = false; return; }
    const bundle = { n: STARTER_COINS, sb: 1, sbh: hash }; if (STARTER_CRATES) bundle.gc = STARTER_CRATES;
    await db.ref("coins/" + id).set(bundle);
    starterSt.id = id; welcome = true;
    toast("🎁 Welcome to VUS! Here's " + STARTER_COINS + " coins" + (STARTER_CRATES ? " and " + STARTER_CRATES + " crates" : "") + " to get you started.");
    setMsg("🎁 Welcome bundle added: " + STARTER_COINS + " coins" + (STARTER_CRATES ? " and " + STARTER_CRATES + " crates" : "") + "!", true);
  } catch (e) {
    if (isDenied(e)) { starterSt.id = id; }                                      // the rules said no (already taken, or an older account): stop trying
    else { starterSt.fails++; starterSt.at = Date.now(); }
  }
  starterSt.busy = false; refreshAll();
}

/* ── counting finished games (called by games.js whenever a game I'm in is over) ──
   info = { gid, mode: "secure" | "direct", raw: the game record as the database has it }.
   A game counts when it ended properly and has been paid out (so the record is final). Checked here exactly like the rules check it. */
const gameDecided = new Set(), gamePending = new Map();
let gameBusy = false;
function gameStart(info, me) {   // -> { ok, start, wait }
  const g = info.raw; if (!g) return { ok: false, wait: false };
  if (info.mode === "secure") {
    if (g.status !== "done") return { ok: false, wait: true };
    if (g.paid !== true) return { ok: false, wait: true };
    const k = g.result && g.result.kind;
    if (!(k === "score" || k === "timeout" || k === "draw")) return { ok: false, wait: false };
    const a = g.p && g.p.a && String(g.p.a.id), b = g.p && g.p.b && String(g.p.b.id);
    if (!a || !b || a === b || (a !== me && b !== me)) return { ok: false, wait: false };
    return { ok: true, start: Number(g.startedAt) || 0 };
  }
  const a = g.a && String(g.a.id), b = g.b && String(g.b.id), log = g.log || {};
  if (!a || !b || a === b || (a !== me && b !== me)) return { ok: false, wait: false };
  if (!log["0004"] || !log["0000"]) return { ok: false, wait: false };          // nobody really played
  const side = a === me ? "a" : "b";
  if (!(g.paid && g.paid[side])) return { ok: false, wait: true };               // settled when my side has collected
  return { ok: true, start: Number(log["0000"].t) || 0 };
}
function gameDone(info) {
  if (!info || !info.gid || !info.raw) return;
  const key = myId() + ":" + info.mode + ":" + info.gid;      // per account, so switching accounts in one tab doesn't mix them up
  if (gameDecided.has(key)) return;
  gamePending.set(key, { info, since: gamePending.has(key) ? gamePending.get(key).since : Date.now() });
  processGames().catch(() => {});
}
async function processGames() {
  const db = dbOf(), id = watchId;
  if (gameBusy || !db || !id || !gamePending.size) return;
  gameBusy = true;
  try {
    for (const [key, item] of Array.from(gamePending)) {
      if (id !== watchId) break;
      if (key.indexOf(id + ":") !== 0) continue;                                 // belongs to another account
      if (Date.now() - item.since > 10 * 60000) { gamePending.delete(key); gameDecided.add(key); continue; }   // never going to settle: forget it
      const chk = gameStart(item.info, id);
      if (!chk.ok) { if (chk.wait && Date.now() - item.since < 5 * 60000) continue; gamePending.delete(key); gameDecided.add(key); continue; }
      const r = (await db.ref("coins/" + id).get()).val() || {};
      if (r.n === undefined) continue;                                           // no coins record yet: try again after the first coin / the welcome bundle
      const t = nowMs(), dk = dayKey(t), wk = weekKey(t);
      if (chk.start < dayStart(t) || chk.start <= (Number(r.qgt) || 0) || chk.start > t + 60000) { gamePending.delete(key); gameDecided.add(key); continue; }   // an older day / already counted
      const d = Number(r.qgdk) === dk ? (Number(r.qgd) || 0) : 0, w = Number(r.qgwk) === wk ? (Number(r.qgw) || 0) : 0;
      if (d >= 10 || w >= 70) { gamePending.delete(key); gameDecided.add(key); continue; }
      try {
        await db.ref("coins/" + id).update({ qgl: item.info.gid, qgt: chk.start, qgdk: dk, qgd: d + 1, qgwk: wk, qgw: w + 1 });
        gamePending.delete(key); gameDecided.add(key);
      } catch (e) {
        if (isDenied(e)) { item.fails = (item.fails || 0) + 1; if (item.fails >= 3) { gamePending.delete(key); gameDecided.add(key); } }   // the coins record changed under us (or the game isn't final yet): look again soon
      }
    }
  } catch (e) {}
  gameBusy = false;
  if (document.getElementById("questRailDot")) refreshAll();
}

/* ── claiming ── */
let claiming = false;
async function claimQuest(q) {
  const db = dbOf();
  if (claiming || !db || !watchId) return;
  claiming = true; setMsg("Claiming…", false); updateModal();
  const id = watchId, ref = db.ref("coins/" + id);
  try {
    let ok = false, err = null, reason = "", paidCoins = 0;
    for (let i = 0; i < 3 && !ok; i++) {
      const r = (await ref.get()).val() || {};
      const o = q.kind === "crate" ? (Number((await db.ref("crateClaims/" + id + "/o").get()).val()) || 0) : null, t = nowMs();
      const p = progressOf(q, r, o, t);
      if (p.claimed) { reason = "You already claimed this one."; break; }
      if (!p.done) { reason = q.kind === "set" ? "Claim every quest first." : "This quest isn't finished yet."; break; }
      paidCoins = coinsOf(q, t);
      const upd = { n: (Number(r.n) || 0) + paidCoins, qc: q.id };
      if (q.crates) upd.gc = (Number(r.gc) || 0) + q.crates;
      upd["qp/" + q.id] = periodKey(q, t);
      try { await ref.update(upd); ok = true; }
      catch (e) { err = e; await sleep(500); }   // a message coin may have changed the balance between the read and the write: read again and retry
    }
    if (ok) setMsg("🎉 Claimed " + paidCoins + " coins" + (q.crates ? " and " + q.crates + (q.crates === 1 ? " crate" : " crates") : "") + " for “" + q.name + "”!", true);
    else if (reason) setMsg(reason, false);
    else setMsg(isDenied(err) ? "The database refused that claim. Make sure the newest database rules are published, then try again." : "Couldn't claim just now — check your connection and try again.", false);
  } catch (e) { setMsg("Couldn't claim just now — check your connection and try again.", false); }
  claiming = false; updateModal(); refreshAll();
}

/* ── the Quests window ── */
let modal = null, ui = null, msgState = null, tickTimer = null;
function setMsg(text, ok) { msgState = text ? { t: text, ok: !!ok } : null; }
function buildCard(q) {
  const card = el("div", "quest-card" + (q.kind === "set" ? " quest-set" : ""));
  const ic = el("div", "quest-ic", q.icon);
  const info = el("div", "quest-info");
  const top = el("div", "quest-top");
  const rw = el("span", "quest-reward", rewardText(q, nowMs()));
  top.append(el("b", "", q.name), rw);
  const desc = el("small", "", q.desc);
  const bar = el("div", "cr-bar quest-bar"), fill = el("span"); bar.appendChild(fill);
  const row = el("div", "quest-row");
  const txt = el("span", "quest-prog");
  const btn = el("button", "quest-btn"); btn.type = "button";
  btn.addEventListener("click", () => claimQuest(q));
  row.append(txt, btn);
  let strip = null;
  if (q.kind === "login") {
    strip = el("div", "quest-days");
    SHOW_ORDER.forEach(wd => { const c = el("div", "quest-day"); c.append(el("span", "", WEEKDAYS[wd]), el("b", "", String(LOGIN[wd]))); c.dataset.wd = String(wd); strip.appendChild(c); });
    info.append(top, desc, strip, row);
  } else info.append(top, desc, bar, row);
  card.append(ic, info);
  return { q, card, fill, txt, btn, rw, strip, desc };
}
function openModal() {
  if (modal) return;
  ensureWatch();
  const ov = el("div", "crate-overlay"), box = el("div", "crate-modal shop-modal quest-modal");
  ov.appendChild(box); document.body.appendChild(ov);
  modal = ov; if (!welcome) msgState = null;
  ov.addEventListener("click", e => { if (e.target === ov && !claiming) closeModal(); });
  const x = el("button", "poll-x", "×"); x.type = "button"; x.addEventListener("click", () => { if (!claiming) closeModal(); });
  const bal = el("div", "shop-bal"); const balN = el("b", "", "…"); const balT = el("span", "", " coins");
  bal.append(el("span", "shop-bal-ic", "🪙"), balN, balT);
  const msg = el("div", "shop-msg"); msg.style.display = "none";
  box.append(x, el("h3", "cr-h", "📜 Quests"), bal, msg);
  ui = { box, balN, balT, msg, daily: null, weekly: null, cards: [] };
  [["d", "Daily quests", "daily", DAILY], ["w", "Weekly quests", "weekly", WEEKLY]].forEach(([period, title, key, list]) => {
    const head = el("div", "quest-sec"); const h = el("b", "", title); const reset = el("span", "quest-reset");
    head.append(h, reset); box.appendChild(head); ui[key] = reset;
    const wrap = el("div", "shop-list");
    list.forEach(q => { const c = buildCard(q); ui.cards.push(c); wrap.appendChild(c.card); });
    box.appendChild(wrap);
  });
  box.appendChild(el("div", "cr-note", "Messages count when they earn a coin (one every 2 seconds at most, in the main chat and channels). Crates count when you open them, not when you sell them. Games count when a match against another player ends with a win, a loss or a draw (leaving, a disconnect or a refund doesn't count). The daily login reward changes with the weekday and the day ends at 12:00 PM Eastern. Progress is saved to your account, so it follows you between devices."));
  updateModal();
  tickTimer = setInterval(updateModal, 1000);
}
function closeModal() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (modal) { modal.remove(); modal = null; ui = null; }
}
function updateModal() {
  if (!modal || !ui) return;
  const t = nowMs();
  ui.balN.textContent = rec && rec.n !== undefined ? String(Number(rec.n) || 0) : (rec ? "0" : "…");
  ui.balT.textContent = rec && Number(rec.n) === 1 ? " coin" : " coins";
  if (msgState) { ui.msg.style.display = ""; ui.msg.className = "shop-msg" + (msgState.ok ? " ok" : ""); ui.msg.textContent = msgState.t; } else ui.msg.style.display = "none";
  const dEnd = periodEnd({ period: "d" }, t), wEnd = periodEnd({ period: "w" }, t);
  ui.daily.textContent = "resets in " + fmtLeft(dEnd - t);
  ui.weekly.textContent = "ends " + new Date(wEnd).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + " · " + fmtLeft(wEnd - t);
  const todayWd = weekdayOf(dayKey(t));
  const noRecord = !!rec && rec.n === undefined;
  ui.cards.forEach(c => {
    const p = progress(c.q), q = c.q;
    c.rw.textContent = rewardText(q, t);
    c.fill.style.width = (rec ? Math.round(p.val * 100 / p.goal) : 0) + "%";
    if (q.kind === "login") {
      c.txt.textContent = !rec ? "Loading…" : "Today: " + WEEKDAYS[todayWd] + " · " + LOGIN[todayWd] + " coins";
      c.strip.childNodes.forEach(n => { const wd = Number(n.dataset.wd); n.classList.toggle("today", wd === todayWd); n.classList.toggle("got", wd === todayWd && p.claimed); });
    } else c.txt.textContent = !rec ? "Loading…" : q.kind === "time" ? fmtClock(p.val) + " / " + fmtClock(p.goal) : q.kind === "set" ? p.val + " / " + p.goal + " claimed" : p.val + " / " + p.goal;
    c.card.classList.toggle("done", p.done && !p.claimed);
    c.card.classList.toggle("claimed", p.claimed);
    if (p.claimed) { c.btn.textContent = "Claimed ✓"; c.btn.disabled = true; c.btn.className = "quest-btn claimed"; }
    else if (p.done && noRecord) { c.btn.textContent = "Send a message first"; c.btn.disabled = true; c.btn.className = "quest-btn"; }   // no coins record yet: the first message creates it
    else if (p.done) { c.btn.textContent = "Claim " + coinsOf(q, t) + " 🪙" + (q.crates ? " + " + q.crates + " 📦" : ""); c.btn.disabled = claiming; c.btn.className = "quest-btn ready"; }
    else { c.btn.textContent = q.kind === "set" ? "Claim the rest first" : "In progress"; c.btn.disabled = true; c.btn.className = "quest-btn"; }
  });
}

/* ── glue ── */
function refreshDot() {
  const d = document.getElementById("questRailDot");
  if (d) d.classList.toggle("show", anyReady());
}
function refreshAll() { refreshDot(); updateModal(); }
function onData() { refreshAll(); maybeTrack().catch(() => {}); maybeStarter().catch(() => {}); if (gamePending.size) processGames().catch(() => {}); }

(function wire() {
  const b = document.getElementById("navQuests");
  if (b) b.addEventListener("click", () => { if (modal) closeModal(); else openModal(); });
  setInterval(ensureWatch, 3000);            // follows logins and logouts
  setInterval(() => { if (watchId) { beat().catch(() => {}); } }, BEAT_MS);
  setInterval(() => {
    if (!watchId) return;
    maybeTrack().catch(() => {}); maybeStarter().catch(() => {}); refreshDot();
    if (gamePending.size) processGames().catch(() => {});
    // a session that has reached 20 minutes: write the beat that proves it right away instead of waiting for the next one
    if (rec && rec.qss && rec.qhb && Number(rec.qhb) - Number(rec.qss) < SESSION_MS && nowMs() - Number(rec.qss) >= SESSION_MS) beat().catch(() => {});
  }, 5000);
  setTimeout(ensureWatch, 1500);
  setTimeout(() => { if (watchId) beat().catch(() => {}); }, 6000);   // the first beat shortly after you're in
})();

window.VUS_QUESTS = { list: QUESTS, open: openModal, close: closeModal, gameDone, _state: () => ({ rec, crateO }), _keys: () => ({ day: dayKey(nowMs()), week: weekKey(nowMs()), weekday: weekdayOf(dayKey(nowMs())) }) };
})();
